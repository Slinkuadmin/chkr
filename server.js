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
    if (['host', 'connection', 'content-length'].includes(k)) continue;
    // Tukar referer/origin agar menunjuk ke origin asli.
    if (k === 'referer' || k === 'origin') {
      headers[key] = String(value).replace(ctx.mirrorHost, config.originHost);
      continue;
    }
    headers[key] = value;
  }
  headers['host'] = config.originHost;
  // Minta konten tak terkompresi-spesifik supaya undici menanganinya konsisten.
  headers['accept-encoding'] = 'gzip, deflate, br';
  return headers;
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
    const init = {
      method: req.method,
      headers: buildOriginHeaders(req, ctx),
      redirect: 'manual', // tangani redirect manual agar bisa di-rewrite.
    };

    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) init.body = Buffer.concat(chunks);
    }

    const originRes = await fetch(targetUrl, init);

    // Salin header (kecuali hop-by-hop), rewrite Location/Link.
    originRes.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (HOP_BY_HOP.has(k)) return;
      if (config.forceIndexable && k === 'x-robots-tag') return; // buang noindex.
      if (k === 'location' || k === 'link') {
        res.setHeader(key, rewriteHeaderValue(value, ctx));
        return;
      }
      res.setHeader(key, value);
    });

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
