// parser.js
// Mengubah teks laporan WhatsApp (format "Report ...") menjadi data terstruktur.

function toNumber(raw) {
  if (raw === undefined || raw === null) return 0;
  let s = String(raw).trim();
  if (s === '' || s === '-') return 0;
  s = s.replace(/rp/i, '').trim();

  // "150rb" / "150k" => 150000
  const kMatch = s.match(/^([\d.,]+)\s*(rb|k)$/i);
  if (kMatch) {
    const num = parseFloat(kMatch[1].replace(/\./g, '').replace(',', '.'));
    return Math.round(num * 1000);
  }

  // Format Indonesia: titik = pemisah ribuan, koma = desimal
  s = s.replace(/\./g, '').replace(/,/g, '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n);
}

const SECTION_HEADERS = {
  'mie ayam hakiki': 'mieAyamHakiki',
  'ayam kabupaten': 'ayamKabupaten',
  'pempek makcik': 'pempekMakcik',
};

const FIELD_MAP = {
  'total pendapatan': 'totalPendapatan',
  'grabfood': 'grabfood',
  'grab ref': 'grabRef',
  'gofood': 'gofood',
  'gofood ref': 'gofoodRef',
  'shopeefood': 'shopeefood',
  'qris': 'qris',
  'cash': 'cash',
};

function emptyProduct() {
  return {
    totalPendapatan: 0,
    grabfood: 0,
    grabRef: 0,
    gofood: 0,
    gofoodRef: 0,
    shopeefood: 0,
    qris: 0,
    cash: 0,
  };
}

function normalizeLabel(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parsing satu baris item pengeluaran, format: "- 4.000(sunghlt)"
 * Mendukung juga tanpa tanda "-" di depan, atau tanpa kurung (fallback).
 */
function parseExpenseLine(line) {
  const cleaned = line.replace(/^[-•*]+\s*/, '').trim();
  const match = cleaned.match(/^([\d.,]+)\s*\(([^)]*)\)\s*$/);
  if (match) {
    return { amount: toNumber(match[1]), description: match[2].trim() };
  }
  // fallback: ambil angka pertama yang ditemukan, sisanya jadi deskripsi
  const numMatch = cleaned.match(/([\d.,]+)/);
  return {
    amount: numMatch ? toNumber(numMatch[1]) : 0,
    description: cleaned,
  };
}

/**
 * @param {string} rawText - isi pesan WA apa adanya
 * @param {string} outletFromGroup - nama outlet, ditentukan dari grup asal pesan
 */
function parseReport(rawText, outletFromGroup) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const result = {
    outlet: outletFromGroup || null,
    tanggalText: null,
    products: {
      mieAyamHakiki: emptyProduct(),
      ayamKabupaten: emptyProduct(),
      pempekMakcik: emptyProduct(),
    },
    pengeluaranDetailLines: [],
    pengeluaranItems: [],
    totalPengeluaran: 0,
    raw: rawText,
    warnings: [],
  };

  let currentSection = null;
  let inPengeluaranBlock = false;

  for (const line of lines) {
    // Baris pertama: "Report {outlet} {tanggal}"
    if (/^report\b/i.test(line)) {
      const rest = line.replace(/^report\s*/i, '');
      if (outletFromGroup) {
        const idx = rest.toLowerCase().indexOf(outletFromGroup.toLowerCase());
        result.tanggalText = idx >= 0
          ? rest.slice(idx + outletFromGroup.length).trim()
          : rest.trim();
        if (!result.outlet) result.outlet = outletFromGroup;
      } else {
        result.tanggalText = rest.trim();
      }
      continue;
    }

    const normalizedForHeader = normalizeLabel(line);
    if (SECTION_HEADERS[normalizedForHeader]) {
      currentSection = SECTION_HEADERS[normalizedForHeader];
      inPengeluaranBlock = false;
      continue;
    }

    // "Pengeluaran outlet :" -> mulai blok daftar pengeluaran
    if (/^pengeluaran(\s+outlet)?\b/i.test(line)) {
      currentSection = null;
      inPengeluaranBlock = true;
      const parts = line.split(':');
      if (parts.length > 1) {
        const val = parts.slice(1).join(':').trim();
        if (val) result.pengeluaranDetailLines.push(val);
      }
      continue;
    }

    // "Total :" penutup = total pengeluaran final
    if (/^total\s*:/i.test(line)) {
      const val = line.split(':').slice(1).join(':');
      result.totalPengeluaran = toNumber(val);
      inPengeluaranBlock = false;
      continue;
    }

    if (inPengeluaranBlock) {
      result.pengeluaranDetailLines.push(line);
      continue;
    }

    if (currentSection && line.includes(':')) {
      const [labelPart, ...valueParts] = line.split(':');
      const label = normalizeLabel(labelPart);
      const value = valueParts.join(':').trim();
      const field = FIELD_MAP[label];
      if (field) {
        result.products[currentSection][field] = toNumber(value);
      } else {
        result.warnings.push(`Baris tidak dikenali di ${currentSection}: "${line}"`);
      }
      continue;
    }

    result.warnings.push(`Baris tidak dikenali: "${line}"`);
  }

  // Ubah tiap baris pengeluaran mentah jadi item terstruktur {description, amount}
  result.pengeluaranItems = result.pengeluaranDetailLines.map(parseExpenseLine);
  result.pengeluaranDetailText = result.pengeluaranDetailLines.join(' | ');

  // Validasi silang: total pendapatan tertulis vs jumlah semua channel
  const calcSum = (p) =>
    p.grabfood + p.grabRef + p.gofood + p.gofoodRef + p.shopeefood + p.qris + p.cash;

  for (const key of Object.keys(result.products)) {
    const p = result.products[key];
    const calculated = calcSum(p);
    if (p.totalPendapatan && Math.abs(calculated - p.totalPendapatan) > 1) {
      result.warnings.push(
        `${key}: total pendapatan tertulis (${p.totalPendapatan}) ≠ jumlah channel (${calculated})`
      );
    }
  }

  // Validasi silang: jumlah item pengeluaran vs "Total :" yang ditulis
  const itemsSum = result.pengeluaranItems.reduce((sum, item) => sum + item.amount, 0);
  if (result.totalPengeluaran && Math.abs(itemsSum - result.totalPengeluaran) > 1) {
    result.warnings.push(
      `Total pengeluaran tertulis (${result.totalPengeluaran}) ≠ jumlah item pengeluaran (${itemsSum})`
    );
  }

  return result;
}

module.exports = { parseReport, toNumber, parseExpenseLine };
