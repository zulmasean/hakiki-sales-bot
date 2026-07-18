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
//    Cara dapatkan ID grup: jalankan bot ini sekali (npm start),
//    kirim pesan apa saja di tiap grup, lalu cek log console.
//    Bot akan mencetak: "ℹ️ Pesan dari grup belum terdaftar: 12036...@g.us"
//    Salin ID tersebut ke bawah ini.
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

function extractText(messageContent) {
  if (!messageContent) return '';
  return messageContent.conversation || messageContent.extendedTextMessage?.text || '';
}

/**
 * Diproses baik untuk pesan baru maupun pesan hasil edit.
 * `reportId` (dibentuk dari jid + ID pesan WA asli) dipakai Apps Script
 * untuk menentukan apakah harus menambah baris baru atau menimpa baris lama.
 */
async function handleReportText({ sock, jid, msgKey, text, isEdit }) {
  const outlet = GROUP_OUTLET_MAP[jid];
  const reportId = `${jid}::${msgKey.id}`;

  try {
    const parsed = parseReport(text, outlet);

    await sendToSheet({
      reportId,
      outlet: parsed.outlet,
      tanggalText: parsed.tanggalText,
      products: parsed.products,
      pengeluaranItems: parsed.pengeluaranItems,
      totalPengeluaran: parsed.totalPengeluaran,
      raw: parsed.raw,
    });

    const warningText = parsed.warnings.length
      ? `\n\n⚠️ Catatan:\n- ${parsed.warnings.join('\n- ')}`
      : '';

    const statusText = isEdit
      ? `🔄 Laporan *${outlet}* berhasil *diperbarui* di Google Sheet (mengikuti pesan yang diedit).`
      : `✅ Laporan *${outlet}* berhasil dicatat ke Google Sheet.`;

    await sock.sendMessage(jid, { text: `${statusText}${warningText}` });
  } catch (err) {
    console.error('Gagal memproses laporan:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Gagal ${isEdit ? 'memperbarui' : 'mencatat'} laporan *${outlet}*. Cek format pesan lalu kirim ulang.\n(${err.message})`,
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

  // Metode pairing code: cocok untuk VPS, tidak butuh QR sama sekali.
  // Aktifkan dengan USE_PAIRING_CODE=true + PAIRING_PHONE_NUMBER di .env
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

  // Pesan BARU
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) continue; // hanya proses grup

      if (!GROUP_OUTLET_MAP[jid]) {
        console.log('ℹ️  Pesan dari grup belum terdaftar:', jid);
        continue;
      }

      const text = extractText(msg.message);
      if (!/^report\b/i.test(text.trim())) continue; // abaikan chat biasa

      await handleReportText({ sock, jid, msgKey: msg.key, text, isEdit: false });
    }
  });

  // Pesan yang DI-EDIT (tekan lama pesan > Edit di WhatsApp)
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      const jid = key?.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) continue;
      if (!GROUP_OUTLET_MAP[jid]) continue;

      // Tergantung versi Baileys, konten pesan hasil edit bisa muncul langsung
      // di update.message, atau dibungkus di update.message.editedMessage.message
      const editedContent = update?.message?.editedMessage?.message || update?.message || null;
      if (!editedContent) continue;

      const text = extractText(editedContent);
      if (!text || !/^report\b/i.test(text.trim())) continue;

      console.log(`✏️  Terdeteksi edit pesan di grup ${GROUP_OUTLET_MAP[jid]}`);
      await handleReportText({ sock, jid, msgKey: key, text, isEdit: true });
    }
  });
}

startBot();
