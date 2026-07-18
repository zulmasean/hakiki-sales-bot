/**
 * APPS SCRIPT WEB APP
 * Menerima data laporan penjualan (JSON) dari bot WhatsApp dan mencatatnya
 * ke 4 Google Sheet terpisah:
 *   1. Laporan Mie Ayam Hakiki
 *   2. Laporan Ayam Kabupaten
 *   3. Laporan Pempek Makcik
 *   4. Laporan Pengeluaran Outlet
 *
 * FITUR EDIT PESAN:
 * Setiap laporan dikirim dengan "reportId" unik (dibentuk dari ID grup + ID
 * pesan WhatsApp aslinya). Kalau reportId yang sama dikirim lagi (karena
 * admin mengedit pesan di WA), sistem akan MENIMPA baris yang sudah ada,
 * bukan membuat baris baru. Kolom "Report ID" di ujung kanan tiap sheet
 * dipakai untuk pencocokan ini — jangan diedit/dihapus manual.
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
 */

const SHARED_SECRET = 'Ay@mb4k4r';

const SHEET_MAH = 'Laporan Mie Ayam Hakiki';
const SHEET_AK = 'Laporan Ayam Kabupaten';
const SHEET_PM = 'Laporan Pempek Makcik';
const SHEET_PENGELUARAN = 'Laporan Pengeluaran Outlet';

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // Tunggu sampai 30 detik kalau ada request lain untuk reportId yang sama
    // sedang diproses. Ini mencegah race condition: kalau ada 2 event edit
    // yang datang hampir bersamaan, keduanya diproses satu-satu (berurutan),
    // bukan paralel — supaya hasil akhir yang tersimpan selalu yang paling baru.
    lock.waitLock(30000);
  } catch (err) {
    return jsonResponse({ status: 'error', message: 'Server sibuk, coba lagi: ' + err.message });
  }

  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ status: 'error', message: 'Unauthorized' });
    }

    const reportId = body.reportId || '';
    if (!reportId) {
      return jsonResponse({ status: 'error', message: 'reportId wajib diisi' });
    }

    const now = new Date();
    const tanggal = body.tanggalText || '';
    const outlet = body.outlet || '';
    const p = body.products || {};

    // Cek dulu apakah reportId ini sudah pernah ada sebelumnya - dipakai bot
    // untuk menampilkan balasan "berhasil dicatat" vs "berhasil diperbarui".
    const mahSheetForCheck = getOrCreateSheet(SHEET_MAH, true);
    const wasUpdate = findRowByReportId(mahSheetForCheck, reportId) > 0;

    upsertProductRow(SHEET_MAH, true, now, tanggal, outlet, p.mieAyamHakiki || {}, reportId);
    upsertProductRow(SHEET_AK, false, now, tanggal, outlet, p.ayamKabupaten || {}, reportId);
    upsertProductRow(SHEET_PM, false, now, tanggal, outlet, p.pempekMakcik || {}, reportId);
    upsertPengeluaranRows(now, tanggal, outlet, body.pengeluaranItems || [], body.totalPengeluaran || 0, reportId);

    return jsonResponse({ status: 'ok', wasUpdate: wasUpdate });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menulis (atau menimpa, kalau reportId sudah ada) satu baris data produk.
 */
function upsertProductRow(sheetName, withRefColumns, waktu, tanggal, outlet, product, reportId) {
  const sheet = getOrCreateSheet(sheetName, withRefColumns);

  const calcTotal = withRefColumns
    ? (product.grabfood || 0) + (product.grabRef || 0) + (product.gofood || 0) +
      (product.gofoodRef || 0) + (product.shopeefood || 0) + (product.qris || 0) + (product.cash || 0)
    : (product.grabfood || 0) + (product.gofood || 0) + (product.shopeefood || 0) +
      (product.qris || 0) + (product.cash || 0);

  // Data selain kolom "Waktu Masuk" (kolom itu hanya diisi sekali saat baris dibuat)
  const dataAfterWaktuMasuk = withRefColumns
    ? [
        new Date(), tanggal, outlet,
        product.totalPendapatan || 0,
        product.grabfood || 0, product.grabRef || 0,
        product.gofood || 0, product.gofoodRef || 0,
        product.shopeefood || 0, product.qris || 0, product.cash || 0,
        calcTotal,
        reportId,
      ]
    : [
        new Date(), tanggal, outlet,
        product.totalPendapatan || 0,
        product.grabfood || 0, product.gofood || 0,
        product.shopeefood || 0, product.qris || 0, product.cash || 0,
        calcTotal,
        reportId,
      ];

  const existingRow = findRowByReportId(sheet, reportId);
  if (existingRow > 0) {
    // Timpa baris lama (kolom 2 dan seterusnya), kolom 1 "Waktu Masuk" tetap dipertahankan
    sheet.getRange(existingRow, 2, 1, dataAfterWaktuMasuk.length).setValues([dataAfterWaktuMasuk]);
  } else {
    sheet.appendRow([waktu, ...dataAfterWaktuMasuk]);
  }
}

/**
 * Sheet Pengeluaran Outlet punya banyak baris per laporan (1 baris per item).
 * Untuk edit, cara paling aman adalah hapus semua baris lama dengan reportId
 * yang sama, lalu tulis ulang set barisnya dari awal.
 */
function upsertPengeluaranRows(waktu, tanggal, outlet, items, totalReported, reportId) {
  const sheet = getOrCreateSheet(SHEET_PENGELUARAN, false, true);

  deleteRowsByReportId(sheet, reportId);

  let itemsSum = 0;
  items.forEach((item) => {
    itemsSum += item.amount || 0;
    sheet.appendRow([waktu, tanggal, outlet, item.description || '', item.amount || 0, reportId]);
  });

  sheet.appendRow([waktu, tanggal, outlet, 'TOTAL (tertulis di pesan)', totalReported, reportId]);

  if (Math.abs(itemsSum - totalReported) > 1) {
    sheet.appendRow([waktu, tanggal, outlet, '⚠️ Selisih dengan jumlah item', itemsSum - totalReported, reportId]);
  }
}

function deleteRowsByReportId(sheet, reportId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const col = getColumnIndex(sheet, 'Report ID');
  if (!col) return;

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] === reportId) {
      sheet.deleteRow(i + 2);
    }
  }
}

function findRowByReportId(sheet, reportId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const col = getColumnIndex(sheet, 'Report ID');
  if (!col) return -1;

  const finder = sheet.getRange(2, col, lastRow - 1, 1)
    .createTextFinder(reportId)
    .matchEntireCell(true);
  const found = finder.findNext();
  return found ? found.getRow() : -1;
}

function getColumnIndex(sheet, headerName) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = headers.indexOf(headerName);
  return idx === -1 ? -1 : idx + 1;
}

function getOrCreateSheet(sheetName, withRefColumns, isPengeluaran) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) return sheet;

  sheet = ss.insertSheet(sheetName);

  if (isPengeluaran) {
    sheet.appendRow(['Waktu Masuk', 'Tanggal', 'Outlet', 'Deskripsi', 'Jumlah', 'Report ID']);
  } else if (withRefColumns) {
    sheet.appendRow([
      'Waktu Masuk', 'Terakhir Diupdate', 'Tanggal', 'Outlet',
      'Total Pendapatan (tertulis)',
      'Grabfood', 'Grab Ref',
      'Gofood', 'Gofood Ref',
      'Shopeefood', 'Qris', 'Cash',
      'Total Pendapatan (hitung ulang)',
      'Report ID',
    ]);
  } else {
    sheet.appendRow([
      'Waktu Masuk', 'Terakhir Diupdate', 'Tanggal', 'Outlet',
      'Total Pendapatan (tertulis)',
      'Grabfood', 'Gofood', 'Shopeefood', 'Qris', 'Cash',
      'Total Pendapatan (hitung ulang)',
      'Report ID',
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
