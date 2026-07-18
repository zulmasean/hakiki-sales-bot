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
 * Fungsi Extract Text Ultra-Wide
 * Mencari teks dari segala kemungkinan struktur JSON WhatsApp Baileys
 */
function extractText(msg) {
  if (!msg) return '';

  // 1. Pesan Normal
  const normalText = msg.conversation || msg.extendedTextMessage?.text;
  if (normalText) return normalText;

  // 2. Pesan Edit (jalur utama Baileys)
  const editMsg = msg.protocolMessage?.editedMessage;
  if (editMsg) {
    const editText = editMsg.conversation || editMsg.extendedTextMessage?.text;
    if (editText) return editText;
  }

  // 3. Kemungkinan struktur langka lainnya
  const innerMsg = msg.editedMessage?.message?.protocolMessage?.editedMessage || msg.editedMessage?.message;
  if (innerMsg) {
    const innerText = innerMsg.conversation || innerMsg.extendedTextMessage?.text;
    if (innerText) return innerText;
  }

  return '';
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

    console.log(`[DEBUG] Memproses laporan - reportId: ${reportId}`);
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
      try { await QRCode.toFile('./qr.png', qr, { width: 400 }); } catch (err) {}
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp tersambung dan siap menerima laporan.\n');
    }
  });

  // =======================================================
  // EVENT LISTENER DIPERKUAT (DEBUG DI DEPAN)
  // =======================================================

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) continue;
      if (!GROUP_OUTLET_MAP[jid]) continue;

      // CEK APAKAH INI PESAN EDIT (Tipe 14 atau MESSAGE_EDIT)
      const isEdit = msg.message.protocolMessage && 
                    (msg.message.protocolMessage.type === 14 || msg.message.protocolMessage.type === 'MESSAGE_EDIT');

      if (isEdit) {
        console.log(`\n=== 🚨 [DEBUG RAW] PESAN EDIT MASUK DI GRUP ${GROUP_OUTLET_MAP[jid]} ===`);
        console.log(JSON.stringify(msg.message, null, 2));
      }

      // Ekstrak teks
      const text = extractText(msg.message);

      // Filter teks
      if (!text || !/^report\b/i.test(text.trim())) {
        if (isEdit) console.log(`⚠️ Pesan edit diabaikan (Gagal ekstrak teks ATAU teks tidak diawali kata 'Report').`);
        continue;
      }

      if (isEdit) {
        console.log(`✅ Teks edit berhasil diekstrak! Memproses data ke Sheet...`);
      } else {
        console.log(`\n📩 [UPSERT] Terdeteksi pesan BARU di grup ${GROUP_OUTLET_MAP[jid]}`);
      }

      await handleReportText({ sock, jid, text });
    }
  });

  // Tangkapan cadangan jika WA mengirimkan edit lewat jalur update
  sock.ev.on('messages.update', async (updates) => {
    for (const item of updates) {
      const { key, update } = item;
      const jid = key?.remoteJid;
      
      if (!jid || !jid.endsWith('@g.us')) continue;
      if (!GROUP_OUTLET_MAP[jid]) continue;

      if (update && (update.editedMessage || update.message)) {
        console.log(`\n=== 🚨 [DEBUG RAW UPDATE] PESAN UPDATE MASUK DI GRUP ${GROUP_OUTLET_MAP[jid]} ===`);
        console.log(JSON.stringify(update, null, 2));

        const actualMessage = update.editedMessage?.message || update.message;
        const text = extractText(actualMessage);

        if (text && /^report\b/i.test(text.trim())) {
          console.log(`✅ Teks update berhasil diekstrak! Memproses data ke Sheet...`);
          await handleReportText({ sock, jid, text });
        } else {
          console.log(`⚠️ Event update diabaikan (Bukan laporan penjualan).`);
        }
      }
    }
  });
}

startBot();
