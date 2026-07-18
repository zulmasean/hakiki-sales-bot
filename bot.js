require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { parseReport } = require('./parser');

// ============================================================
// 1) ISI MAPPING GRUP -> OUTLET DI SINI
// ============================================================
const GROUP_OUTLET_MAP = {
  '120363427888047377@g.us': 'Catalina',
  '120363000000000002@g.us': 'Pondok Aren',
  '120363000000000003@g.us': 'Pamulang',
  '120363427833899976@g.us': 'Palmerah',
};

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SHARED_SECRET = process.env.SHARED_SECRET;

async function sendToSheet(payload) {
  return axios.post(
    APPS_SCRIPT_URL,
    { ...payload, secret: SHARED_SECRET },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
}

function buildReportId(jid, outlet, tanggalText) {
  const normalizedOutlet = (outlet || '').toLowerCase().trim();
  const normalizedTanggal = (tanggalText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${jid}::${normalizedOutlet}::${normalizedTanggal}`;
}

async function handleReportText({ sock, jid, text }) {
  const outlet = GROUP_OUTLET_MAP[jid];
  try {
    const parsed = parseReport(text, outlet);
    
    // =========================================================
    // TEMBOK PERTAHANAN: TOLAK JIKA ADA TYPO / BUKAN ANGKA
    // =========================================================
    if (parsed.criticalErrors && parsed.criticalErrors.length > 0) {
      console.log(`\n[DEBUG] Laporan dari ${outlet} DITOLAK karena salah format/typo.`);
      
      const errorMsg = `❌ *LAPORAN DITOLAK (Ada Kesalahan Format/Typo)* ❌\n\nSistem menemukan kesalahan pada tulisan Anda. Laporan *TIDAK DISIMPAN* ke Google Sheet.\n\nSilakan perbaiki kesalahan berikut dan kirim ulang sebagai pesan baru:\n\n- ${parsed.criticalErrors.join('\n- ')}`;
      
      await sock.sendMessage(jid, { text: errorMsg });
      return; // Berhenti! Data tidak dikirim ke Sheet
    }

    const reportId = buildReportId(jid, parsed.outlet, parsed.tanggalText);
    console.log(`\n[DEBUG] Memproses laporan - reportId: ${reportId}`);
    
    const response = await sendToSheet({
      reportId,
      outlet: parsed.outlet,
      tanggalText: parsed.tanggalText,
      products: parsed.products,
      pengeluaranItems: parsed.pengeluaranItems,
      totalPengeluaran: parsed.totalPengeluaran,
      raw: parsed.raw,
    });

    const wasUpdate = response?.data?.wasUpdate;
    
    // =========================================================
    // PENAMPIL WARNING KEMBALI DIMASUKKAN
    // =========================================================
    const warningText = (parsed.warnings && parsed.warnings.length > 0) 
      ? `\n\n⚠️ *Catatan (Info Selisih):*\n- ${parsed.warnings.join('\n- ')}` 
      : '';
    
    const statusText = wasUpdate
      ? `🔄 Laporan *${outlet}* (${parsed.tanggalText || '-'}) berhasil *DIPERBARUI (REVISI)* di Google Sheet.`
      : `✅ Laporan *${outlet}* (${parsed.tanggalText || '-'}) berhasil *DICATAT* ke Google Sheet.`;

    // Menggabungkan pesan Sukses + Warning Selisih (Sebelumnya ini tertinggal)
    await sock.sendMessage(jid, { text: `${statusText}${warningText}` });
  } catch (err) {
    console.error('Gagal memproses laporan:', err.message);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
  const { version } = await fetchLatestBaileysVersion();
  const usePairingCode = process.env.USE_PAIRING_CODE === 'true';

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  if (usePairingCode && !sock.authState.creds.registered) {
    const phoneNumber = (process.env.PAIRING_PHONE_NUMBER || '').replace(/[^0-9]/g, '');
    if (phoneNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          console.log('\n🔑 Kode pairing WhatsApp Anda:', code);
        } catch (err) {}
      }, 3000);
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !usePairingCode) qrcode.generate(qr, { small: true });
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp tersambung dan siap menerima laporan.\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const jid = msg.key.remoteJid;
      
      // 1. Pastikan pesan berasal dari Grup (diakhiri dengan @g.us)
      if (!jid || !jid.endsWith('@g.us')) continue;

      // 2. DETEKSI ID GRUP BARU
      if (!GROUP_OUTLET_MAP[jid]) {
        // Cetak ID Grup ke layar CLI agar mudah disalin
        console.log(`ℹ️ Pesan dari grup belum terdaftar: ${jid}`);
        continue; // Hentikan proses, karena grup belum ada di daftar
      }

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

      // TANGKAP TYPO KATA "REPORT"
      if (!text || !/^(report|repirt|repot|laporan|raport)\b/i.test(text.trim())) continue;

      console.log(`\n📩 [PESAN MASUK] Terdeteksi dari grup ${GROUP_OUTLET_MAP[jid]}`);
      await handleReportText({ sock, jid, text });
    }
  });
}

startBot();
