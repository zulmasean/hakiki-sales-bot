require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore // <-- FITUR MEMORI DITAMBAHKAN
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

// Inisialisasi Store (WAJIB ADA UNTUK BISA MEMBACA PESAN EDIT)
const store = makeInMemoryStore({ logger: P({ level: 'silent' }) });
store.readFromFile('./baileys_store.json');
setInterval(() => {
  store.writeToFile('./baileys_store.json');
}, 10_000);

async function sendToSheet(payload) {
  return axios.post(
    APPS_SCRIPT_URL,
    { ...payload, secret: SHARED_SECRET },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
}

// Fungsi ekstrak teks rekursif (mencari teks terdalam dari segala struktur WA)
function extractText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  let text = '';
  
  if (obj.editedMessage) text = extractText(obj.editedMessage);
  if (text) return text;
  
  if (obj.protocolMessage?.editedMessage) text = extractText(obj.protocolMessage.editedMessage);
  if (text) return text;
  
  if (obj.conversation) return obj.conversation;
  if (obj.text) return obj.text;
  if (obj.extendedTextMessage?.text) return obj.extendedTextMessage.text;
  
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object') {
      text = extractText(obj[key]);
      if (text) return text;
    }
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
    const warningText = parsed.warnings.length ? `\n\n⚠️ Catatan:\n- ${parsed.warnings.join('\n- ')}` : '';
    const statusText = wasUpdate
      ? `🔄 Laporan *${outlet}* (${parsed.tanggalText || '-'}) berhasil *diperbarui* di Google Sheet.`
      : `✅ Laporan *${outlet}* (${parsed.tanggalText || '-'}) berhasil dicatat ke Google Sheet.`;

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
    // GET MESSAGE WAJIB DIISI AGAR BOT BISA MENDETEKSI EVENT "EDIT"
    getMessage: async (key) => {
      if (store) {
        const msg = await store.loadMessage(key.remoteJid, key.id);
        return msg?.message || undefined;
      }
      return { conversation: '' };
    }
  });

  // Sambungkan Store (Memori) ke Bot
  store.bind(sock.ev);
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

  // JALUR 1: MENANGKAP PESAN BARU
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || !GROUP_OUTLET_MAP[jid]) continue;

      // Filter pesan edit, biarkan ditangani oleh events messages.update
      if (msg.message.protocolMessage && (msg.message.protocolMessage.type === 14 || msg.message.protocolMessage.type === 'MESSAGE_EDIT')) {
        continue;
      }

      const text = extractText(msg.message);
      if (text && /^report\b/i.test(text.trim())) {
        console.log(`\n📩 [PESAN BARU] Terdeteksi di grup ${GROUP_OUTLET_MAP[jid]}`);
        await handleReportText({ sock, jid, text });
      }
    }
  });

  // JALUR 2: MENANGKAP PESAN YANG DIEDIT (BERHASIL BERKAT "STORE" MEMORI)
  sock.ev.on('messages.update', async (updates) => {
    for (const item of updates) {
      const { key, update } = item;
      const jid = key?.remoteJid;
      
      if (!jid || !GROUP_OUTLET_MAP[jid]) continue;

      if (update && update.message) {
        const text = extractText(update.message);
        if (text && /^report\b/i.test(text.trim())) {
          console.log(`\n✏️ [PESAN DIEDIT] Terdeteksi di grup ${GROUP_OUTLET_MAP[jid]}`);
          await handleReportText({ sock, jid, text });
        }
      }
    }
  });
}

startBot();
