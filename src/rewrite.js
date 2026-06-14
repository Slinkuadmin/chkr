// Modul utilitas untuk menulis-ulang (rewrite) konten dari origin agar:
// - Semua referensi domain origin diganti ke domain mirror (anti-duplikat).
// - Canonical / og:url / structured-data menunjuk ke domain mirror sendiri.
// - Hash SRI (integrity) dihapus karena konten JS/CSS ikut di-rewrite.
// - Klik kanan & seleksi teks diaktifkan kembali.
// - Meta/header noindex dihilangkan jika FORCE_INDEXABLE aktif.

import { config } from './config.js';

const RIGHT_CLICK_SNIPPET = `
<script data-mirror="right-click">
(function () {
  var stop = function (e) { e.stopImmediatePropagation(); return true; };
  // Aktifkan kembali menu klik-kanan.
  window.addEventListener('contextmenu', stop, true);
  // Aktifkan kembali seleksi & copy.
  ['selectstart', 'copy', 'cut', 'dragstart'].forEach(function (ev) {
    window.addEventListener(ev, stop, true);
  });
  // Buang handler inline (oncontextmenu, onselectstart, dll).
  var clearInline = function () {
    var props = ['oncontextmenu', 'onselectstart', 'oncopy', 'oncut', 'ondragstart', 'onmousedown'];
    [document, document.body, document.documentElement].forEach(function (n) {
      if (!n) return;
      props.forEach(function (p) { try { n[p] = null; } catch (_) {} });
    });
    document.querySelectorAll('[oncontextmenu],[onselectstart],[oncopy]').forEach(function (el) {
      el.removeAttribute('oncontextmenu');
      el.removeAttribute('onselectstart');
      el.removeAttribute('oncopy');
    });
  };
  // Paksa CSS user-select kembali aktif.
  var css = document.createElement('style');
  css.textContent = '*{-webkit-user-select:text!important;-moz-user-select:text!important;-ms-user-select:text!important;user-select:text!important;-webkit-touch-callout:default!important;}';
  document.documentElement.appendChild(css);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', clearInline);
  } else {
    clearInline();
  }
  setInterval(clearInline, 1500);
})();
</script>`;

// Escape karakter regex.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Ganti semua referensi domain origin -> domain mirror.
export function replaceDomains(text, originHost, mirrorHost, mirrorProtocol) {
  if (!text) return text;
  const oh = escapeRegExp(originHost);

  return text
    // https://origin atau http://origin -> proto://mirror
    .replace(new RegExp(`https?:\\/\\/${oh}`, 'gi'), `${mirrorProtocol}://${mirrorHost}`)
    // Versi JSON-escaped: https:\/\/origin
    .replace(new RegExp(`https?:\\\\\\/\\\\\\/${oh}`, 'gi'), `${mirrorProtocol}:\\/\\/${mirrorHost}`)
    // Protocol-relative: //origin
    .replace(new RegExp(`\\/\\/${oh}`, 'gi'), `//${mirrorHost}`)
    // Sisa kemunculan bare host (mis. di JSON-LD / atribut).
    .replace(new RegExp(oh, 'gi'), mirrorHost);
}

// Hapus atribut integrity/crossorigin agar resource yang sudah di-rewrite tidak ditolak.
function stripIntegrity(html) {
  return html
    .replace(/\sintegrity=("|')[^"']*\1/gi, '')
    .replace(/\snonce=("|')[^"']*\1/gi, '');
}

// Hilangkan meta robots noindex/nofollow.
function forceIndexable(html) {
  return html.replace(
    /<meta[^>]*name=["']robots["'][^>]*>/gi,
    '<meta name="robots" content="index, follow">'
  );
}

// Pastikan ada <link rel="canonical"> yang menunjuk ke URL mirror saat ini.
function ensureCanonical(html, canonicalUrl) {
  const hasCanonical = /<link[^>]*rel=["']canonical["'][^>]*>/i.test(html);
  const tag = `<link rel="canonical" href="${canonicalUrl}">`;
  if (hasCanonical) {
    return html.replace(/<link[^>]*rel=["']canonical["'][^>]*>/i, tag);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  }
  return tag + html;
}

// Sisipkan snippet sebelum </body> (atau di akhir dokumen).
function injectSnippet(html, snippet) {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${snippet}\n</body>`);
  }
  if (/<\/html>/i.test(html)) {
    return html.replace(/<\/html>/i, `${snippet}\n</html>`);
  }
  return html + snippet;
}

// Rewrite penuh untuk dokumen HTML.
export function rewriteHtml(html, ctx) {
  const { originHost, mirrorHost, mirrorProtocol, canonicalUrl } = ctx;
  let out = replaceDomains(html, originHost, mirrorHost, mirrorProtocol);
  out = stripIntegrity(out);
  out = ensureCanonical(out, canonicalUrl);
  if (config.forceIndexable) out = forceIndexable(out);
  if (config.enableRightClick) out = injectSnippet(out, RIGHT_CLICK_SNIPPET);
  return out;
}

// Rewrite untuk konten teks lain (CSS, JS, JSON, XML/sitemap, robots).
export function rewriteText(text, ctx) {
  const { originHost, mirrorHost, mirrorProtocol } = ctx;
  return replaceDomains(text, originHost, mirrorHost, mirrorProtocol);
}

// Tentukan apakah content-type perlu di-rewrite sebagai teks.
export function isRewritableText(contentType = '') {
  const ct = contentType.toLowerCase();
  return (
    ct.includes('text/html') ||
    ct.includes('text/css') ||
    ct.includes('javascript') ||
    ct.includes('application/json') ||
    ct.includes('xml') ||
    ct.includes('text/plain') ||
    ct.includes('image/svg')
  );
}

export function isHtml(contentType = '') {
  return contentType.toLowerCase().includes('text/html');
}
