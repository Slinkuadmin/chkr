// Konfigurasi terpusat untuk mirror.
// Semua nilai bisa di-override lewat environment variables.

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

export const config = {
  // Hostname situs asli (origin) yang di-mirror.
  originHost: process.env.ORIGIN_HOST || 'hchk.cards',

  // Protokol origin.
  originProtocol: (process.env.ORIGIN_PROTOCOL || 'https').replace(':', ''),

  // URL publik mirror (opsional). Jika diisi dipakai sebagai sumber kebenaran
  // untuk canonical/sitemap. Jika kosong dideteksi dari request.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // Port server.
  port: Number(process.env.PORT) || 8080,

  // Paksa halaman dapat di-index (hapus noindex dari origin).
  forceIndexable: bool(process.env.FORCE_INDEXABLE, true),

  // Injeksi script pengaktif klik kanan & seleksi teks.
  enableRightClick: bool(process.env.ENABLE_RIGHT_CLICK, true),
};

export function originBase() {
  return `${config.originProtocol}://${config.originHost}`;
}
