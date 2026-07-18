/**
 * APPS SCRIPT WEB APP
 * Menerima data laporan penjualan (JSON) dari bot WhatsApp dan mencatatnya
 * otomatis ke 4 Google Sheet terpisah:
 *   1. Laporan Mie Ayam Hakiki
 *   2. Laporan Ayam Kabupaten
 *   3. Laporan Pempek Makcik
 *   4. Laporan Pengeluaran Outlet
 *
 * CARA PASANG:
 * 1. Buka/buat Google Sheet tujuan -> menu Extensions > Apps Script.
 * 2. Hapus isi default file Code.gs, tempel seluruh kode ini.
 * 3. Ganti nilai SHARED_SECRET di bawah dengan kode rahasia -
 *    HARUS SAMA PERSIS dengan SHARED_SECRET di file .env bot.
 * 4. Klik Deploy > New deployment > pilih tipe "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Salin URL yang muncul (diakhiri /exec) -> tempel sebagai APPS_SCRIPT_URL
 *    di file .env bot.
 * 6. Setiap kali kode ini diubah, buat deployment baru
 *    (Manage deployments > Edit > New version).
 *
 * Keempat sheet di atas akan otomatis terbentuk sendiri saat data pertama masuk,
 * tidak perlu dibuat manual.
 */

const SHARED_SECRET = 'Ay@mb4k4r';

const SHEET_MAH = 'Laporan Mie Ayam Hakiki';
const SHEET_AK = 'Laporan Ayam Kabupaten';
const SHEET_PM = 'Laporan Pempek Makcik';
const SHEET_PENGELUARAN = 'Laporan Pengeluaran Outlet';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ status: 'error', message: 'Unauthorized' });
    }

    const now = new Date();
    const tanggal = body.tanggalText || '';
    const outlet = body.outlet || '';
    const p = body.products || {};

    // 1) Sheet Mie Ayam Hakiki (punya kolom Grab Ref & Gofood Ref)
    writeProductRow(SHEET_MAH, true, now, tanggal, outlet, p.mieAyamHakiki || {});

    // 2) Sheet Ayam Kabupaten (tanpa kolom Ref)
    writeProductRow(SHEET_AK, false, now, tanggal, outlet, p.ayamKabupaten || {});

    // 3) Sheet Pempek Makcik (tanpa kolom Ref)
    writeProductRow(SHEET_PM, false, now, tanggal, outlet, p.pempekMakcik || {});

    // 4) Sheet Pengeluaran Outlet (satu baris per item + satu baris ringkasan total)
    writePengeluaranRows(now, tanggal, outlet, body.pengeluaranItems || [], body.totalPengeluaran || 0);

    return jsonResponse({ status: 'ok' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

function writeProductRow(sheetName, withRefColumns, waktu, tanggal, outlet, product) {
  const sheet = getOrCreateSheet(sheetName, withRefColumns);
  const calcTotal = withRefColumns
    ? (product.grabfood || 0) + (product.grabRef || 0) + (product.gofood || 0) +
      (product.gofoodRef || 0) + (product.shopeefood || 0) + (product.qris || 0) + (product.cash || 0)
    : (product.grabfood || 0) + (product.gofood || 0) + (product.shopeefood || 0) +
      (product.qris || 0) + (product.cash || 0);

  const row = withRefColumns
    ? [
        waktu, tanggal, outlet,
        product.totalPendapatan || 0,
        product.grabfood || 0, product.grabRef || 0,
        product.gofood || 0, product.gofoodRef || 0,
        product.shopeefood || 0, product.qris || 0, product.cash || 0,
        calcTotal,
      ]
    : [
        waktu, tanggal, outlet,
        product.totalPendapatan || 0,
        product.grabfood || 0, product.gofood || 0,
        product.shopeefood || 0, product.qris || 0, product.cash || 0,
        calcTotal,
      ];

  sheet.appendRow(row);
}

function writePengeluaranRows(waktu, tanggal, outlet, items, totalReported) {
  const sheet = getOrCreateSheet(SHEET_PENGELUARAN, false, true);

  let itemsSum = 0;
  items.forEach((item) => {
    itemsSum += item.amount || 0;
    sheet.appendRow([waktu, tanggal, outlet, item.description || '', item.amount || 0]);
  });

  // Baris ringkasan total, memudahkan cross-check dengan angka yang ditulis admin
  sheet.appendRow([waktu, tanggal, outlet, 'TOTAL (tertulis di pesan)', totalReported]);

  if (Math.abs(itemsSum - totalReported) > 1) {
    sheet.appendRow([waktu, tanggal, outlet, '⚠️ Selisih dengan jumlah item', itemsSum - totalReported]);
  }
}

function getOrCreateSheet(sheetName, withRefColumns, isPengeluaran) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) return sheet;

  sheet = ss.insertSheet(sheetName);

  if (isPengeluaran) {
    sheet.appendRow(['Waktu Masuk', 'Tanggal', 'Outlet', 'Deskripsi', 'Jumlah']);
  } else if (withRefColumns) {
    sheet.appendRow([
      'Waktu Masuk', 'Tanggal', 'Outlet',
      'Total Pendapatan (tertulis)',
      'Grabfood', 'Grab Ref',
      'Gofood', 'Gofood Ref',
      'Shopeefood', 'Qris', 'Cash',
      'Total Pendapatan (hitung ulang)',
    ]);
  } else {
    sheet.appendRow([
      'Waktu Masuk', 'Tanggal', 'Outlet',
      'Total Pendapatan (tertulis)',
      'Grabfood', 'Gofood', 'Shopeefood', 'Qris', 'Cash',
      'Total Pendapatan (hitung ulang)',
    ]);
  }

  sheet.setFrozenRows(1);
  return sheet;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse({ status: 'ok', message: 'WA Sales Bot Web App is running.' });
}
