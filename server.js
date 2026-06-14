import express from 'express';
import { config, originBase } from './src/config.js';
import {
  rewriteHtml,
  rewriteText,
  isRewritableText,
  isHtml,
} from './src/rewrite.js';

const app = express();
app.disable('x-powered-by');

// Header response dari origin yang tidak boleh diteruskan apa adanya.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding', // undici sudah men-decode body; jangan teruskan.
  'content-length', // akan dihitung ulang.
  'content-security-policy', // agar script injeksi & resource mirror tidak diblok.
  'content-security-policy-report-only',
  'strict-transport-security',
  'public-key-pins',
  'report-to',
  'nel',
]);

// Tentukan host & protokol mirror dari env atau dari request.
function mirrorContext(req) {
  let mirrorHost;
  let mirrorProtocol;
  if (config.publicUrl) {
    const u = new URL(config.publicUrl);
    mirrorHost = u.host;
    mirrorProtocol = u.protocol.replace(':', '');
  } else {
    mirrorHost = req.headers['x-forwarded-host'] || req.headers.host;
    mirrorProtocol =
      (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      (req.secure ? 'https' : 'http');
  }
  const canonicalUrl = `${mirrorProtocol}://${mirrorHost}${req.originalUrl.split('?')[0]}`;
  return {
    originHost: config.originHost,
    mirrorHost,
    mirrorProtocol,
    canonicalUrl,
  };
}

// Bangun headers untuk request ke origin.
function buildOriginHeaders(req, ctx) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    // Header yang tidak boleh diteruskan / akan kita set ulang.
    if (
      [
        'host',
        'connection',
        'content-length',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-forwarded-for',
        'forwarded',
        'cf-connecting-ip',
        'cf-ipcountry',
        'cf-ray',
        'cf-visitor',
        'x-real-ip',
      ].includes(k)
    ) {
      continue;
    }
    // Tukar referer/origin agar menunjuk ke origin asli (banyak API memvalidasi ini).
    if (k === 'referer' || k === 'origin') {
      headers[key] = String(value).replaceAll(ctx.mirrorHost, config.originHost);
      continue;
    }
    headers[key] = value;
  }
  headers['host'] = config.originHost;
  // Pastikan API yang butuh konteks browser tidak menolak request.
  if (!headers['user-agent'] && !headers['User-Agent']) {
    headers['user-agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  }
  if (!headers['accept'] && !headers['Accept']) {
    headers['accept'] = '*/*';
  }
  headers['accept-encoding'] = 'gzip, deflate, br';
  return headers;
}

// Tulis-ulang header Set-Cookie agar cookie/sesi tersimpan di domain mirror.
// - Domain=hchk.cards -> dibuang (cookie otomatis berlaku untuk host saat ini).
// - SameSite=None tetap, tapi pastikan Secure ada bila mirror https.
function rewriteSetCookie(cookieStr, ctx) {
  let out = cookieStr
    // Buang atribut Domain agar cookie melekat ke domain mirror.
    .replace(/;\s*Domain=[^;]*/gi, '')
    // Ganti sisa referensi host origin di value cookie (jarang, tapi aman).
    .replaceAll(config.originHost, ctx.mirrorHost);

  if (ctx.mirrorProtocol === 'https') {
    if (/SameSite=None/i.test(out) && !/;\s*Secure/i.test(out)) {
      out += '; Secure';
    }
  } else {
    // Di http, cookie Secure tidak akan tersimpan -> buang flag Secure.
    out = out.replace(/;\s*Secure/gi, '');
  }
  return out;
}

// Tulis-ulang header Location & Link agar menunjuk ke domain mirror.
function rewriteHeaderValue(value, ctx) {
  return value
    .replaceAll(
      `${config.originProtocol}://${config.originHost}`,
      `${ctx.mirrorProtocol}://${ctx.mirrorHost}`
    )
    .replaceAll(`//${config.originHost}`, `//${ctx.mirrorHost}`)
    .replaceAll(config.originHost, ctx.mirrorHost);
}

// Ambil teks dari origin (dipakai handler robots/sitemap).
async function fetchOriginText(path, req, ctx) {
  const res = await fetch(`${originBase()}${path}`, {
    method: 'GET',
    headers: buildOriginHeaders(req, ctx),
    redirect: 'follow',
  });
  return { status: res.status, text: await res.text() };
}

// robots.txt: proxy origin, lalu pastikan baris Sitemap menunjuk ke mirror.
app.get('/robots.txt', async (req, res) => {
  const ctx = mirrorContext(req);
  const base = `${ctx.mirrorProtocol}://${ctx.mirrorHost}`;
  try {
    const { status, text } = await fetchOriginText('/robots.txt', req, ctx);
    let body = status >= 200 && status < 300 && text.trim()
      ? rewriteText(text, ctx)
      : 'User-agent: *\nAllow: /\n';
    if (!/^sitemap:/im.test(body)) {
      body = body.trimEnd() + `\nSitemap: ${base}/sitemap.xml\n`;
    }
    res.type('text/plain').send(body);
  } catch {
    res
      .type('text/plain')
      .send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  }
});

// sitemap.xml: proxy origin & rewrite; fallback minimal bila origin tidak punya.
app.get(['/sitemap.xml', '/sitemap_index.xml'], async (req, res) => {
  const ctx = mirrorContext(req);
  const base = `${ctx.mirrorProtocol}://${ctx.mirrorHost}`;
  try {
    const { status, text } = await fetchOriginText(req.path, req, ctx);
    if (status >= 200 && status < 300 && text.includes('<')) {
      res.type('application/xml').send(rewriteText(text, ctx));
      return;
    }
  } catch {
    /* fallback di bawah */
  }
  const now = new Date().toISOString();
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url><loc>${base}/</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n` +
      `</urlset>\n`
  );
});

app.use(async (req, res) => {
  const ctx = mirrorContext(req);
  const targetUrl = `${originBase()}${req.originalUrl}`;

  try {
    const reqHeaders = buildOriginHeaders(req, ctx);
    // Teruskan IP klien asli (banyak API rate-limit / log berbasis IP).
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .toString()
      .split(',')[0]
      .trim();
    if (clientIp) {
      reqHeaders['x-forwarded-for'] = clientIp;
      reqHeaders['x-real-ip'] = clientIp;
    }

    const init = {
      method: req.method,
      headers: reqHeaders,
      redirect: 'manual', // tangani redirect manual agar bisa di-rewrite.
    };

    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) init.body = Buffer.concat(chunks);
    }

    const originRes = await fetch(targetUrl, init);

    // Salin header (kecuali hop-by-hop), rewrite Location/Link & Set-Cookie.
    originRes.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (HOP_BY_HOP.has(k)) return;
      if (k === 'set-cookie') return; // ditangani khusus di bawah.
      if (config.forceIndexable && k === 'x-robots-tag') return; // buang noindex.
      if (k === 'location' || k === 'link') {
        res.setHeader(key, rewriteHeaderValue(value, ctx));
        return;
      }
      res.setHeader(key, value);
    });

    // Set-Cookie: ambil semua cookie (jangan tergabung), rewrite domain agar sesi jalan.
    const setCookies =
      typeof originRes.headers.getSetCookie === 'function'
        ? originRes.headers.getSetCookie()
        : [];
    if (setCookies.length) {
      res.setHeader(
        'set-cookie',
        setCookies.map((c) => rewriteSetCookie(c, ctx))
      );
    }

    res.status(originRes.status);

    const contentType = originRes.headers.get('content-type') || '';

    if (isRewritableText(contentType)) {
      const text = await originRes.text();
      const body = isHtml(contentType)
        ? rewriteHtml(text, ctx)
        : rewriteText(text, ctx);
      res.setHeader('content-length', Buffer.byteLength(body));
      res.end(body);
    } else {
      const buf = Buffer.from(await originRes.arrayBuffer());
      res.setHeader('content-length', buf.length);
      res.end(buf);
    }
  } catch (err) {
    console.error(`[mirror] ${req.method} ${targetUrl} ->`, err.message);
    res.status(502).type('text/plain').send('Mirror upstream error.');
  }
});

app.listen(config.port, () => {
  console.log(
    `Mirror aktif di port ${config.port} -> origin ${originBase()}` +
      (config.publicUrl ? ` (public: ${config.publicUrl})` : '')
  );
});
