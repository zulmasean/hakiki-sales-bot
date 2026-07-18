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
 * Fungsi Extract Text yang diperkuat.
 * Mencari isi teks sampai ke dalam struktur terdalam Baileys saat pesan diedit.
 */
function extractText(messageContent) {
  if (!messageContent) return '';

  // 1. Pesan normal
  let text = messageContent.conversation || messageContent.extendedTextMessage?.text || '';
  if (text) return text;

  // 2. Pesan Edit (Baileys mengirimkannya lewat messages.upsert sebagai protocolMessage)
  const editMsg = messageContent.protocolMessage?.editedMessage;
  if (editMsg) {
    text = editMsg.conversation || editMsg.extendedTextMessage?.text || '';
    if (text) return text;
  }

  // 3. Pesan Edit (dari event messages.update)
  const updateMsg = messageContent.editedMessage?.message;
  if (updateMsg) {
    text = updateMsg.conversation || updateMsg.extendedTextMessage?.text || '';
    if (text) return text;
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
          console.log(
            'Buka WhatsApp di HP nomor bot -> Perangkat Tertaut -> Tautkan Perangkat ->\n' +
            '"Tautkan dengan nomor telepon" -> masukkan kode di atas.\n'
          );
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
        console.log('🖼️  QR juga disimpan sebagai file qr.png (download & scan kalau tampilan terminal rusak)\n');
      } catch (err) {
        console.error('Gagal menyimpan qr.png:', err.message);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp tersambung dan siap menerima laporan.');
    }
  });

  // JALUR 1: Event `upsert` (Menangkap pesan baru DAN pesan yang diedit tipe ProtocolMessage)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) continue;
      if (!GROUP_OUTLET_MAP[jid]) continue;

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

  // JALUR 2: Event `update` (Fallback jika WA client melempar edit ke jalur ini)
  sock.ev.on('messages.update', async (updates) => {
    for (const item of updates) {
      const { key, update } = item;
      const jid = key?.remoteJid;
      
      if (!jid || !jid.endsWith('@g.us')) continue;
      if (!GROUP_OUTLET_MAP[jid]) continue;

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
