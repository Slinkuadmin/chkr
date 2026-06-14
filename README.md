# chkr — Full Mirror + SEO Fix

Reverse-proxy untuk **mirror penuh** sebuah website (default `hchk.cards`) yang bisa
di-deploy ke **Railway, Render, atau VPS pribadi**. Pengganti script Cloudflare Workers,
dengan tambahan perbaikan SEO dan pengaktif klik-kanan.

## Yang diperbaiki

| Masalah Search Console | Solusi di mirror ini |
|---|---|
| Duplikat, Google memilih kanonis berbeda | Semua referensi domain origin di-rewrite ke domain mirror; `<link rel="canonical">`, `og:url`, `twitter:url` dipaksa menunjuk ke URL mirror sendiri (self-canonical). |
| Halaman dengan pengalihan | Redirect ditangani `manual`; header `Location`/`Link` di-rewrite ke domain mirror agar tidak balik ke origin. |
| Tidak ditemukan (404) | Proxy meneruskan status & path apa adanya; tidak ada rewrite path yang merusak. |
| Data terstruktur Breadcrumb / tidak dapat diurai | JSON-LD di-rewrite domainnya (termasuk versi `https:\/\/` ter-escape) sehingga URL breadcrumb valid & konsisten dengan domain mirror. |
| Sitemap terlewat | Endpoint `/sitemap.xml` & `/robots.txt` ditangani khusus: proxy + rewrite, dengan **fallback otomatis** bila origin tidak menyediakannya. Baris `Sitemap:` dipastikan ada di robots. |
| Tidak bisa klik kanan | Script injeksi mengaktifkan kembali `contextmenu`, seleksi, copy, dan `user-select`. |
| `noindex` dari origin | Header `X-Robots-Tag` dan meta `robots` noindex dihapus/diubah jadi `index, follow` (`FORCE_INDEXABLE=true`). |

Selain itu header `Content-Security-Policy` dan atribut `integrity` (SRI) dibuang agar
script injeksi & resource mirror tidak diblokir browser.

## Konfigurasi (environment variables)

Lihat `.env.example`. Yang penting:

- `ORIGIN_HOST` — host situs asli (default `hchk.cards`).
- `ORIGIN_PROTOCOL` — `https` atau `http`.
- `PUBLIC_URL` — **isi dengan URL publik mirror kamu** (mis. `https://chkr.example.com`).
  Sangat disarankan agar canonical & sitemap selalu akurat.
- `FORCE_INDEXABLE` — `true` untuk menghapus noindex.
- `ENABLE_RIGHT_CLICK` — `true` untuk mengaktifkan klik kanan.

## Jalankan lokal

```bash
npm install
ORIGIN_HOST=hchk.cards node server.js
# buka http://localhost:8080
```

## Deploy ke Railway

1. Push repo ini ke GitHub.
2. Railway → New Project → Deploy from GitHub repo.
3. Tambah Variables: `ORIGIN_HOST=hchk.cards`, `FORCE_INDEXABLE=true`,
   `ENABLE_RIGHT_CLICK=true`, dan setelah dapat domain isi `PUBLIC_URL=https://<domain-railway>`.
4. Railway otomatis pakai `railway.json` (Nixpacks) dan `node server.js`.

## Deploy ke Render

1. Push repo ke GitHub.
2. Render → New → Blueprint, pilih repo (memakai `render.yaml`).
   Atau New → Web Service: Build `npm install`, Start `node server.js`.
3. Set `PUBLIC_URL` ke URL `*.onrender.com` kamu setelah service dibuat.

## Deploy ke VPS pribadi

Dengan Docker:

```bash
docker build -t chkr-mirror .
docker run -d --name chkr -p 80:8080 \
  -e ORIGIN_HOST=hchk.cards \
  -e PUBLIC_URL=https://domainkamu.com \
  -e FORCE_INDEXABLE=true -e ENABLE_RIGHT_CLICK=true \
  chkr-mirror
```

Tanpa Docker (Node 18+):

```bash
npm install
PUBLIC_URL=https://domainkamu.com ORIGIN_HOST=hchk.cards node server.js
```

Pakai Nginx/Caddy di depannya untuk TLS, lalu set `PUBLIC_URL` ke domain HTTPS-mu.

## Catatan SEO setelah deploy

1. Set `PUBLIC_URL` ke domain final (wajib agar canonical benar).
2. Verifikasi domain mirror di Google Search Console.
3. Submit `https://domainkamu.com/sitemap.xml`.
4. Cek beberapa URL via **URL Inspection** → pastikan "User-declared canonical"
   sama dengan domain mirror, bukan origin.
5. Gunakan **Rich Results Test** untuk memastikan breadcrumb structured data valid.