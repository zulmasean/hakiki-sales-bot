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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan QR code ini pakai WA di HP nomor bot (Perangkat Tertaut > Tautkan Perangkat):\n');
      qrcode.generate(qr, { small: true });
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

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!/^report\b/i.test(text.trim())) continue; // abaikan chat biasa

      const outlet = GROUP_OUTLET_MAP[jid];

      try {
        const parsed = parseReport(text, outlet);

        await sendToSheet({
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

        await sock.sendMessage(jid, {
          text: `✅ Laporan *${outlet}* berhasil dicatat ke Google Sheet.${warningText}`,
        });
      } catch (err) {
        console.error('Gagal memproses laporan:', err.message);
        await sock.sendMessage(jid, {
          text: `❌ Gagal mencatat laporan *${outlet}*. Cek format pesan lalu kirim ulang.\n(${err.message})`,
        });
      }
    }
  });
}

startBot();
