# Sistem Pencatatan Penjualan Otomatis (4 Grup WA → Google Sheet)

## Cara kerja singkat
```
Admin outlet kirim "Report ..." di grup WA
        │
        ▼
Bot WhatsApp (bot.js) mendeteksi & mem-parsing pesan (parser.js)
        │  (POST JSON + secret key)
        ▼
Google Apps Script Web App (AppsScript_Code.gs)
        │
        ▼
Baris baru otomatis muncul di Google Sheet "Data Laporan"
```

Bot juga membalas ke grup: "✅ Laporan Catalina berhasil dicatat" (atau warning
kalau ada angka yang tidak konsisten, misal Total Hakiki Food tidak sama
dengan jumlah 3 produk).

## ⚠️ Hal penting yang perlu diketahui dulu

**WhatsApp Business Cloud API resmi dari Meta TIDAK bisa membaca pesan grup**
(hanya chat pribadi/business). Karena laporan Anda dikirim di **grup**, satu-satunya
cara praktis adalah pakai library tidak resmi seperti **Baileys** (dipakai di sini),
yang bekerja dengan cara "menyambungkan" satu nomor WA sebagai Linked Device —
sama seperti WhatsApp Web.

Konsekuensinya:
- Perlu 1 nomor WA khusus untuk bot (join ke 4 grup tersebut), di-scan sekali via QR.
- Karena tidak resmi, ada risiko kecil nomor tersebut kena batasan dari WhatsApp
  jika terlalu agresif mengirim pesan. Untuk kasus ini (hanya baca + balas
  singkat), risikonya rendah, tapi tetap bukan jaminan 100% dari Meta.
- Bot harus jalan terus-menerus di server/VPS/komputer yang menyala 24 jam
  (bisa VPS murah, Raspberry Pi, atau layanan seperti Railway/Render).

Kalau Anda ingin cara yang 100% resmi, alternatifnya: admin tiap grup **forward**
pesan report ke 1 nomor WhatsApp Business bot secara japri (bukan taruh di grup) —
ini baru bisa pakai WhatsApp Cloud API resmi. Tapi ini menambah 1 langkah manual.
Beri tahu saya kalau mau saya buatkan versi ini juga.

## Struktur file
```
wa-sales-bot/
├── bot.js                 # Bot WhatsApp (Baileys) - dengarkan 4 grup
├── parser.js               # Logika parsing pesan → data terstruktur
├── test-parser.js          # Uji parser tanpa perlu koneksi WA (sudah dites ✅)
├── package.json
├── .env.example             # Salin jadi .env, isi URL Apps Script & secret
└── AppsScript_Code.gs        # Kode Google Apps Script (Web App)
```

## Langkah setup

### 1. Siapkan Google Sheet
1. Buat Google Sheet baru, mis. "Laporan Penjualan Hakiki Group".
2. Buka **Extensions > Apps Script**.
3. Hapus isi default, tempel isi `AppsScript_Code.gs`.
4. Ganti `SHARED_SECRET` di baris atas dengan kode rahasia bebas, contoh:
   `SHARED_SECRET = 'hakiki-rahasia-2026'`.
5. **Deploy > New deployment > Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Salin URL yang muncul (formatnya `.../exec`). Ini `APPS_SCRIPT_URL`.
7. Sheet "Data Laporan" akan otomatis terbentuk dengan header saat data pertama masuk.

### 2. Siapkan bot
1. Install Node.js (v18+) di server/VPS/komputer yang akan menyala terus.
2. Di folder `wa-sales-bot/`, jalankan:
   ```bash
   npm install
   cp .env.example .env
   ```
3. Edit `.env`, isi `APPS_SCRIPT_URL` dan `SHARED_SECRET` (harus sama persis
   dengan yang di Apps Script).
4. Jalankan:
   ```bash
   npm start
   ```
5. Scan QR code yang muncul di terminal, pakai WA di HP nomor bot:
   **WhatsApp > Perangkat Tertaut > Tautkan Perangkat**.
6. Setelah tersambung, kirim pesan apa saja di masing-masing dari 4 grup.
   Bot akan mencetak di terminal ID grup yang belum terdaftar, contoh:
   ```
   ℹ️ Pesan dari grup belum terdaftar: 120363012345678901@g.us
   ```
7. Salin ID tersebut ke `GROUP_OUTLET_MAP` di `bot.js`, sesuaikan dengan
   nama outletnya (Catalina / Pondok Aren / Pamulang / Palmerah).
8. Restart bot (`npm start` lagi). Sistem siap digunakan.

### 3. Format pesan yang harus dikirim admin
Persis seperti contoh Anda — label dan urutan section (`Mie Ayam Hakiki`,
`Ayam Kabupaten`, `Pempek makcik`, lalu `Pengeluaran` dan `Total :`) harus
tetap sama. Nilai angka boleh ditulis `150000`, `150.000`, atau `150rb` —
semua akan dikenali. Baris `Grab ref` dan `Gofood ref` hanya ada di section
Mie Ayam Hakiki, sesuai contoh Anda.

Contoh lengkap ada di `test-parser.js` — jalankan `npm run test-parser`
untuk melihat hasil parsing-nya tanpa perlu menyambungkan WhatsApp sama sekali.

### 4. Menjaga bot tetap hidup
Untuk produksi, jalankan bot dengan process manager supaya otomatis restart
kalau crash atau server reboot, misalnya **PM2**:
```bash
npm install -g pm2
pm2 start bot.js --name wa-sales-bot
pm2 save
pm2 startup
```

## Kalau format pesan admin sering berubah-ubah / typo
Parser sudah memberi **warning otomatis** (dikirim balik ke grup) kalau:
- Total Pendapatan yang ditulis tidak sama dengan jumlah 5 channel (Grabfood+Gofood+Shopeefood+Qris+Cash)
- Total Hakiki Food tidak sama dengan jumlah 3 produk

Ini membantu admin sadar kalau ada salah ketik sebelum data masuk ke rekap bulanan.

## Rekap harian ala screenshot Anda (opsional, langkah lanjutan)
Sheet "Data Laporan" ini berisi data mentah per pesan masuk (baik untuk audit).
Untuk membuat tampilan rekap per outlet seperti screenshot yang Anda kirim
(dengan Total Penjualan & Pengeluaran per outlet), langkah selanjutnya adalah
membuat sheet kedua berisi rumus `QUERY`/`SUMIFS` yang menarik dari
"Data Laporan". Saya bisa buatkan template-nya juga kalau mau — tinggal
bilang nama-nama produk/outlet final yang dipakai.
