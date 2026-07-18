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

/**
 * Fungsi Extract Text Super Agresif
 * Menggali teks dari semua variasi struktur JSON Baileys saat edit terjadi
 */
function extractText(msg) {
  if (!msg) return '';

  // 1. Jalur edit di messages.update terbaru
  const updateEdit = msg.editedMessage?.message?.protocolMessage?.editedMessage;
  if (updateEdit) {
    return updateEdit.conversation || updateEdit.extendedTextMessage?.text || '';
  }

  // 2. Jalur edit di messages.upsert
  const protocolEdit = msg.protocolMessage?.editedMessage;
  if (protocolEdit) {
    return protocolEdit.conversation || protocolEdit.extendedTextMessage?.text || '';
  }

  // 3. Pesan normal
  return msg.conversation || msg.extendedTextMessage?.text || '';
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
    const reportId = buildReportId(jid, parsed.outlet, parsed.tanggalText);

    console.log(`\n[DEBUG] Memproses laporan - reportId: ${reportId}`);
    console.log(`[DEBUG] totalPengeluaran hasil parsing: ${parsed.totalPengeluaran}`);
    console.log(`[DEBUG] jumlah item pengeluaran: ${parsed.pengeluaranItems.length}`);

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

    const warningText = parsed.warnings.length
      ? `\n\n⚠️ Catatan:\n- ${parsed.warnings.join('\n- ')}`
      : '';

    const statusText = wasUpdate
      ? `🔄 Laporan *${outlet}* (${parsed.tanggalText || '-'}) berhasil *diperbarui* di Google Sheet.`
      : `✅ Laporan *${outlet}* (${parsed.tanggalText || '-'}) berhasil dicatat ke Google Sheet.`;

    await sock.sendMessage(jid, { text: `${statusText}${warningText}` });
  } catch (err) {
    console.error('Gagal memproses laporan:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Gagal mencatat laporan *${outlet}*. Cek format pesan lalu kirim ulang.\n(${err.message})`,
    });
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
    if (!phoneNumber) {
      console.error('❌ USE_PAIRING_CODE=true tapi PAIRING_PHONE_NUMBER kosong/salah format di .env');
    } else {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          console.log('\n🔑 Kode pairing WhatsApp Anda:', code);
          console.log('Buka WA -> Perangkat Tertaut -> Tautkan dengan nomor telepon -> masukkan kode.\n');
        } catch (err) {
          console.error('Gagal meminta kode pairing:', err.message);
        }
      }, 3000);
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      console.log('\n📱 Scan QR code ini pakai WA di HP nomor bot (Perangkat Tertaut > Tautkan Perangkat):\n');
      qrcode.generate(qr, { small: true });
      try {
        await QRCode.toFile('./qr.png', qr, { width: 400 });
      } catch (err) {}
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp tersambung dan siap menerima laporan.');
    }
  });

  // =======================================================
  // PENANGANAN PESAN & EDIT (DIPERKUAT)
  // =======================================================

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // KITA HAPUS: if (type !== 'notify') return;
    // Agar event edit yang masuk saat reconnect/append tetap tertangkap

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) continue;
      if (!GROUP_OUTLET_MAP[jid]) continue;

      // Pancingan Log Debug: Jika pesan ini berjenis Edit (tipe 14), kita print bentuk mentahnya
      if (msg.message.protocolMessage && (msg.message.protocolMessage.type === 14 || msg.message.protocolMessage.type === 'MESSAGE_EDIT')) {
        console.log('\n[DEBUG RAW UPSERT EDIT DETECTED]', JSON.stringify(msg.message, null, 2));
      }

      const text = extractText(msg.message);
      if (!text || !/^report\b/i.test(text.trim())) continue;

      if (msg.message.protocolMessage) {
        console.log(`✏️ [UPSERT] Terdeteksi EDIT pesan di grup ${GROUP_OUTLET_MAP[jid]}`);
      } else {
        console.log(`📩 [UPSERT] Terdeteksi pesan BARU di grup ${GROUP_OUTLET_MAP[jid]}`);
      }

      await handleReportText({ sock, jid, text });
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const item of updates) {
      const { key, update } = item;
      const jid = key?.remoteJid;
      
      if (!jid || !jid.endsWith('@g.us')) continue;
      if (!GROUP_OUTLET_MAP[jid]) continue;

      // Pancingan Log Debug: Jika ada unsur "editedMessage" di dalam update
      if (JSON.stringify(update).includes('editedMessage')) {
        console.log('\n[DEBUG RAW UPDATE EDIT DETECTED]', JSON.stringify(update, null, 2));
      }

      if (update && update.message) {
        const text = extractText(update.message);
        if (text && /^report\b/i.test(text.trim())) {
          console.log(`✏️ [UPDATE] Terdeteksi EDIT pesan di grup ${GROUP_OUTLET_MAP[jid]}`);
          await handleReportText({ sock, jid, text });
        }
      }
    }
  });
}

startBot();
