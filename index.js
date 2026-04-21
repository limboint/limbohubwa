import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

let sock = null;
let qrCodeData = null;
let isAuthenticated = false;

const LIMBO_API_URL = process.env.LIMBO_API_URL || 'https://hub.limbointernational.nl/api.php';
const WORKSPACE_ID = process.env.WORKSPACE_ID || null;

// QR-code endpoint
app.get('/qr', async (req, res) => {
  res.json({
    qr: qrCodeData,
    authenticated: isAuthenticated,
    message: qrCodeData ? 'QR ready' : (isAuthenticated ? 'Authenticated' : 'Waiting for QR code...')
  });
});

// Auth status
app.get('/status', (req, res) => {
  res.json({
    authenticated: isAuthenticated,
    userId: sock?.user?.id || null,
  });
});

// Send message
app.post('/send', async (req, res) => {
  const { to, text } = req.body;
  if (!sock || !isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const jid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages (polling endpoint)
app.get('/messages', (req, res) => {
  res.json({ messages: [] });
});

// Logout / disconnect
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    isAuthenticated = false;
    qrCodeData = null;
    res.json({ success: true, message: 'Logged out' });
    // Herstart na korte pauze zodat nieuwe QR gegenereerd wordt
    setTimeout(startBaileys, 2000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize Baileys
async function startBaileys() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log('Baileys version:', version);

    const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_info_baileys');

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ['LIMBO Hub', 'Chrome', '1.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR code received, generating image...');
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          console.log('QR code ready at /qr endpoint');
        } catch (err) {
          console.error('QR generation error:', err);
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp connected!', sock.user?.id);
        isAuthenticated = true;
        qrCodeData = null;
      }

      if (connection === 'close') {
        isAuthenticated = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed. Status:', statusCode, 'Reconnect:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(startBaileys, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text ||
                     msg.message?.imageMessage?.caption || '';
        if (!text || !from) continue;
        console.log('Incoming message from', from, ':', text.substring(0, 50));
        try {
          const payload = {
            action: 'whatsapp_receive_message',
            from,
            text,
            timestamp: msg.messageTimestamp,
          };
          if (WORKSPACE_ID) {
            payload.workspace_id = WORKSPACE_ID;
          }
          await axios.post(LIMBO_API_URL, payload);
        } catch (err) {
          console.error('Failed to send to LIMBO:', err.message);
        }
      }
    });

  } catch (err) {
    console.error('Baileys init error:', err);
    setTimeout(startBaileys, 5000);
  }
}

app.listen(PORT, () => {
  console.log(`Baileys server running on port ${PORT}`);
  console.log(`Workspace ID: ${WORKSPACE_ID || 'not set (will use first workspace)'}`);
  startBaileys();
});
