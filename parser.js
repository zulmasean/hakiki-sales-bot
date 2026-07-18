// parser.js
// Mengubah teks laporan WhatsApp menjadi data terstruktur dengan validasi ketat

function toNumber(raw, labelForError) {
  if (raw === undefined || raw === null) return 0;
  let s = String(raw).trim();
  if (s === '' || s === '-') return 0;
  
  // Bersihkan "Rp", "Rp.", "rp " di awal agar tidak dianggap huruf
  s = s.replace(/^rp\.?\s*/i, '').trim();

  // Deteksi format singkatan "rb" atau "k" (contoh: 150rb atau 150k)
  const kMatch = s.match(/^([\d.,]+)\s*(rb|k)$/i);
  if (kMatch) {
    const numStr = kMatch[1].replace(/\./g, '').replace(',', '.');
    const num = Number(numStr);
    if (isNaN(num)) throw new Error(`Kolom "${labelForError}" harus angka.`);
    return Math.round(num * 1000);
  }

  // Format angka normal: titik = pemisah ribuan, koma = desimal
  s = s.replace(/\./g, '').replace(/,/g, '.');
  
  // Gunakan Number() yang sangat ketat (jika ada 1 huruf saja, hasilnya akan NaN)
  const n = Number(s); 
  
  if (isNaN(n)) {
    throw new Error(`Kolom "${labelForError}" salah! (Anda mengisi: "${raw}"). Harus berupa angka.`);
  }
  return Math.round(n);
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

function parseExpenseLine(line, criticalErrors) {
  const cleaned = line.replace(/^[-•*]+\s*/, '').trim();
  
  // Cek format ideal: 4.000(sunghlt)
  const match = cleaned.match(/^([\d.,]+)\s*\(([^)]*)\)\s*$/);
  if (match) {
    try {
      return { amount: toNumber(match[1], `Harga Pengeluaran ${match[2].trim()}`), description: match[2].trim() };
    } catch (e) {
      criticalErrors.push(`Input nominal pengeluaran tidak valid pada baris: "${line}"`);
      return { amount: 0, description: match[2].trim() };
    }
  }
  
  // Fallback: ambil angka pertama yang ditemukan
  const numMatch = cleaned.match(/([\d.,]+)/);
  if (!numMatch) {
    criticalErrors.push(`Pengeluaran tidak mencantumkan harga/angka yang jelas pada baris: "${line}"`);
    return { amount: 0, description: cleaned };
  }
  
  try {
    return { amount: toNumber(numMatch[1], `Harga Pengeluaran`), description: cleaned };
  } catch (e) {
    criticalErrors.push(`Input nominal pengeluaran tidak valid pada baris: "${line}"`);
    return { amount: 0, description: cleaned };
  }
}

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
    criticalErrors: [], // ARRAY BARU UNTUK MENAMPUNG ERROR FATAL (BUKAN ANGKA)
  };

  let currentSection = null;
  let inPengeluaranBlock = false;

  for (const line of lines) {
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

    // Tangkap baris "Total :" di Pengeluaran
    if (/^total\s*:/i.test(line)) {
      const labelPart = line.split(':')[0].trim();
      const val = line.split(':').slice(1).join(':').trim();
      try {
        result.totalPengeluaran = toNumber(val, labelPart);
      } catch (e) {
        result.criticalErrors.push(e.message);
      }
      inPengeluaranBlock = false;
      continue;
    }

    if (inPengeluaranBlock) {
      result.pengeluaranDetailLines.push(line);
      continue;
    }

    // Proses baris produk (Grabfood, Gofood, dll)
    if (currentSection && line.includes(':')) {
      const [labelPart, ...valueParts] = line.split(':');
      const label = normalizeLabel(labelPart);
      const value = valueParts.join(':').trim();
      const field = FIELD_MAP[label];
      
      if (field) {
        try {
          result.products[currentSection][field] = toNumber(value, labelPart.trim());
        } catch (e) {
          result.criticalErrors.push(e.message); // Masukkan ke daftar dosa (error)
        }
      } else {
        result.warnings.push(`Baris tidak dikenali di area ${currentSection}: "${line}"`);
      }
      continue;
    }

    result.warnings.push(`Baris tidak dikenali: "${line}"`);
  }

  // Proses daftar pengeluaran
  result.pengeluaranItems = result.pengeluaranDetailLines.map(line => parseExpenseLine(line, result.criticalErrors));
  result.pengeluaranDetailText = result.pengeluaranDetailLines.join(' | ');

  // Hitung ulang silang untuk dimunculkan sebagai warning biasa (bukan penolakan)
  const calcSum = (p) =>
    p.grabfood + p.grabRef + p.gofood + p.gofoodRef + p.shopeefood + p.qris + p.cash;

  for (const key of Object.keys(result.products)) {
    const p = result.products[key];
    const calculated = calcSum(p);
    if (p.totalPendapatan && Math.abs(calculated - p.totalPendapatan) > 1) {
      result.warnings.push(
        `${key}: total pendapatan tertulis (${p.totalPendapatan}) ≠ hitung ulang (${calculated})`
      );
    }
  }

  const itemsSum = result.pengeluaranItems.reduce((sum, item) => sum + item.amount, 0);
  if (result.totalPengeluaran && Math.abs(itemsSum - result.totalPengeluaran) > 1) {
    result.warnings.push(
      `Total pengeluaran tertulis (${result.totalPengeluaran}) ≠ jumlah item di list (${itemsSum})`
    );
  }

  return result;
}

module.exports = { parseReport, toNumber, parseExpenseLine };
