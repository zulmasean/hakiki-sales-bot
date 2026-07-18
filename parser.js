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
  
  // Number() sangat ketat. Jika ada 1 huruf saja, hasilnya NaN
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

// DAFTAR OUTLET YANG DIKENALI (HARUS HURUF KECIL SEMUA)
const KNOWN_OUTLETS = ['catalina', 'pondok aren', 'pamulang', 'palmerah'];

function emptyProduct() {
  return { totalPendapatan: 0, grabfood: 0, grabRef: 0, gofood: 0, gofoodRef: 0, shopeefood: 0, qris: 0, cash: 0 };
}

function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function parseExpenseLine(line, criticalErrors) {
  const cleaned = line.replace(/^[-•*]+\s*/, '').trim();
  
  const strictMatch = cleaned.match(/^([\d.,]+)\s*\(([^)]+)\)\s*$/);
  if (strictMatch) {
    try {
      return { amount: toNumber(strictMatch[1], `Pengeluaran ${strictMatch[2].trim()}`), description: strictMatch[2].trim() };
    } catch (e) {
      criticalErrors.push(`Nominal pengeluaran tidak valid: "${line}"`);
      return { amount: 0, description: strictMatch[2].trim() };
    }
  }
  
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
    criticalErrors: [],
  };

  let currentSection = null;
  let inPengeluaranBlock = false;

  for (const line of lines) {
    // 1. TANGKAP JUDUL LAPORAN & VALIDASI SALAH GRUP
    if (/^(report|repirt|repot|laporan|raport)\b/i.test(line)) {
      const rest = line.replace(/^(report|repirt|repot|laporan|raport)\s*/i, '').trim();
      const restLower = rest.toLowerCase();
      
      // Cari tahu outlet apa yang sebenarnya diketik oleh Admin
      let writtenOutlet = null;
      for (const o of KNOWN_OUTLETS) {
        if (restLower.startsWith(o)) {
          writtenOutlet = o;
          break;
        }
      }

      if (outletFromGroup) {
        const outletGroupLower = outletFromGroup.toLowerCase();
        
        if (writtenOutlet && writtenOutlet !== outletGroupLower) {
          // Kasus: Outlet dikenali (misal Catalina), tapi BUKAN outlet grup ini (misal Palmerah)
          result.criticalErrors.push(`SALAH GRUP! Anda mengirim laporan untuk cabang *${writtenOutlet.toUpperCase()}* di dalam grup *${outletFromGroup.toUpperCase()}*.`);
        } else if (!writtenOutlet && !restLower.startsWith(outletGroupLower)) {
          // Kasus: Typo parah sehingga nama outlet tidak dikenali
          result.criticalErrors.push(`Nama outlet pada baris pertama salah ketik atau tidak sesuai dengan nama grup ini (*${outletFromGroup.toUpperCase()}*).`);
        }

        // Ekstrak tanggal dengan memotong nama outlet dari teks
        const matchedOutletLength = writtenOutlet ? writtenOutlet.length : outletFromGroup.length;
        if (restLower.startsWith(writtenOutlet || outletGroupLower)) {
          result.tanggalText = rest.slice(matchedOutletLength).trim();
        } else {
          result.tanggalText = rest.trim();
        }
        result.outlet = outletFromGroup;
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
        result.criticalErrors.push(`Nama kolom salah ketik / tidak dikenali: "${line}"`);
      }
      continue;
    }

    result.criticalErrors.push(`Baris salah ketik / format tidak dikenali: "${line}"`);
  }

  result.pengeluaranItems = result.pengeluaranDetailLines.map(line => parseExpenseLine(line, result.criticalErrors));

  // =========================================================================
  // BLOK WARNING: PENGECEKAN SELISIH (TIDAK MEMBLOKIR KIRIMAN KE SHEET)
  // =========================================================================
  const calcSum = (p) => p.grabfood + p.grabRef + p.gofood + p.gofoodRef + p.shopeefood + p.qris + p.cash;
  
  const DISPLAY_NAMES = {
    mieAyamHakiki: 'Mie Ayam Hakiki',
    ayamKabupaten: 'Ayam Kabupaten',
    pempekMakcik: 'Pempek Makcik'
  };

  for (const key of Object.keys(result.products)) {
    const p = result.products[key];
    const calculated = calcSum(p);
    
    if (p.totalPendapatan > 0 && Math.abs(calculated - p.totalPendapatan) > 1) {
      result.warnings.push(
        `Pendapatan ${DISPLAY_NAMES[key]} tertulis (${p.totalPendapatan}) ≠ Hasil hitung bot (${calculated})`
      );
    }
  }

  const itemsSum = result.pengeluaranItems.reduce((sum, item) => sum + item.amount, 0);
  if (result.totalPengeluaran > 0 && Math.abs(itemsSum - result.totalPengeluaran) > 1) {
    result.warnings.push(
      `Pengeluaran tertulis (${result.totalPengeluaran}) ≠ Jumlah rincian item (${itemsSum})`
    );
  }

  return result;
}

module.exports = { parseReport, toNumber, parseExpenseLine };
