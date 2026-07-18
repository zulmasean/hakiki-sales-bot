// Jalankan: node test-parser.js
// Untuk memastikan parser bekerja sesuai format sebelum dipakai bot.

const { parseReport } = require('./parser');

const sample = `Report Palmerah Jumat 17 Juli 2026
Mie Ayam Hakiki
Total pendapatan : 70000
Grabfood  : 10000
Grab ref   : 10000
Gofood    : 10000
Gofood ref : 10000
Shopeefood : 10000
Qris       : 10000
Cash     : 10000
Ayam Kabupaten
Total Pendapatan : 70000
Grabfood  : 10000
Gofood    : 10000
Shopeefood : 10000
Qris       : 10000
Cash     : 10000
Pempek makcik
Total Pendapatan : 10000
Grabfood  : 10000
Gofood    : 10000
Shopeefood : 10000
Qris       : 10000
Cash     : 10000
Pengeluaran outlet :
- 4.000(sunghlt)
- 10.000(rawit)
- 12.000(pulsa warung)
- 8.000(plstik klip 2pcs)
- 10.000(plstik uk 6x20 1pcs)
Total : 44.000`;

const result = parseReport(sample, 'Palmerah');
console.log(JSON.stringify(result, null, 2));

if (result.warnings.length === 0) {
  console.log('\n✅ Tidak ada warning, data konsisten.');
} else {
  console.log('\n⚠️ Warning:', result.warnings);
}
