// parser.js
// Mengubah teks laporan WhatsApp menjadi data terstruktur dengan VALIDASI KETAT

function toNumber(raw, labelForError) {
  if (raw === undefined || raw === null) return 0;
  let s = String(raw).trim();
  if (s === '' || s === '-') return 0;
  
  // Bersihkan "Rp" di awal agar tidak dianggap huruf
  s = s.replace(/^rp\.?\s*/i, '').trim();

  // Format ribuan singkatan: "150rb" atau "150k"
  const kMatch = s.match(/^([\d.,]+)\s*(rb|k)$/i);
  if (kMatch) {
    const numStr = kMatch[1].replace(/\./g, '').replace(',', '.');
    const num = Number(numStr);
    if (isNaN(num)) throw new Error(`Kolom "${labelForError}" harus angka.`);
    return Math.round(num * 1000);
  }

  s = s.replace(/\./g, '').replace(/,/g, '.');
  
  // Number() sangat ketat. Jika ada 1 huruf saja (misal: "30000 ayam"), hasilnya NaN (Not a Number)
  const n = Number(s); 
  
  if (isNaN(n)) {
    throw new Error(`Kolom "${labelForError}" salah isi: "${raw}". Harus berupa ANGKA SAJA.`);
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
  return { totalPendapatan: 0, grabfood: 0, grabRef: 0, gofood: 0, gofoodRef: 0, shopeefood: 0, qris: 0, cash: 0 };
}

function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function parseExpenseLine(line, criticalErrors) {
  const cleaned = line.replace(/^[-•*]+\s*/, '').trim();
  
  // FORMAT KETAT: Angka(Deskripsi) => Contoh: 4000(sunghlt) atau 4.000(ikan asin)
  const strictMatch = cleaned.match(/^([\d.,]+)\s*\(([^)]+)\)\s*$/);
  
  if (strictMatch) {
    try {
      return { amount: toNumber(strictMatch[1], `Pengeluaran ${strictMatch[2].trim()}`), description: strictMatch[2].trim() };
    } catch (e) {
      criticalErrors.push(`Nominal pengeluaran tidak valid: "${line}"`);
      return { amount: 0, description: strictMatch[2].trim() };
    }
  }
  
  // Jika formatnya seperti "(sunghlt)4000" atau salah ketik lainnya:
  criticalErrors.push(`Format pengeluaran salah: "${line}". Gunakan format persis: Angka(Deskripsi) contoh: 4000(sunghlt)`);
  return { amount: 0, description: cleaned };
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
    criticalErrors: [], // Penampung semua dosa Typo
  };

  let currentSection = null;
  let inPengeluaranBlock = false;

  for (const line of lines) {
    // 1. Tangkap Judul Laporan (Toleransi Typo kata Report)
    if (/^(report|repirt|repot|laporan|raport)\b/i.test(line)) {
      const rest = line.replace(/^(report|repirt|repot|laporan|raport)\s*/i, '');
      if (outletFromGroup) {
        const idx = rest.toLowerCase().indexOf(outletFromGroup.toLowerCase());
        result.tanggalText = idx >= 0 ? rest.slice(idx + outletFromGroup.length).trim() : rest.trim();
        if (!result.outlet) result.outlet = outletFromGroup;
      } else {
        result.tanggalText = rest.trim();
      }
      continue;
    }

    // 2. Tangkap Judul Produk
    const normalizedForHeader = normalizeLabel(line);
    if (SECTION_HEADERS[normalizedForHeader]) {
      currentSection = SECTION_HEADERS[normalizedForHeader];
      inPengeluaranBlock = false;
      continue;
    }

    // 3. Tangkap Judul Pengeluaran
    if (/^(pengeluaran|keluaran)\s*(outlet)?\s*:?/i.test(line)) {
      currentSection = null;
      inPengeluaranBlock = true;
      const parts = line.split(':');
      if (parts.length > 1) {
        const val = parts.slice(1).join(':').trim();
        if (val) result.pengeluaranDetailLines.push(val);
      }
      continue;
    }

    // 4. Tangkap Total Pengeluaran
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

    // 5. Tangkap Kolom Isian Data
    if (currentSection && line.includes(':')) {
      const [labelPart, ...valueParts] = line.split(':');
      const label = normalizeLabel(labelPart);
      const value = valueParts.join(':').trim();
      const field = FIELD_MAP[label];
      
      if (field) {
        try {
          result.products[currentSection][field] = toNumber(value, labelPart.trim());
        } catch (e) {
          result.criticalErrors.push(e.message);
        }
      } else {
        // ERROR JIKA LABEL SALAH (misal: tutal pendapatan)
        result.criticalErrors.push(`Nama kolom salah ketik / tidak dikenali: "${line}"`);
      }
      continue;
    }

    // 6. CATCH-ALL: ERROR JIKA JUDUL SALAH (misal: Mie Bebek Hakiki)
    result.criticalErrors.push(`Baris salah ketik / format tidak dikenali: "${line}"`);
  }

  result.pengeluaranItems = result.pengeluaranDetailLines.map(line => parseExpenseLine(line, result.criticalErrors));

  return result;
}

module.exports = { parseReport, toNumber, parseExpenseLine };
