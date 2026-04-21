const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());

// Auth state directory
const authDir = '/tmp/auth_info';
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

// Config
const LIMBO_API = process.env.LIMBO_API_URL || 'https://hub.limbointernational.nl/api.php';
const PORT = process.env.PORT || 3000;

let sock = null;
let qrCode = null;
let isConnected = false;

// Initialize WhatsApp connection
async function initializeWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  // QR Code event
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrCode = await QRCode.toDataURL(qr);
        console.log('QR Code generated');
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      qrCode = null;
      console.log('WhatsApp connected!');
      
      // Notify LIMBO that we're connected
      try {
        await axios.post(LIMBO_API, {
          action: 'whatsapp_status',
          status: 'connected',
          phone: sock.user?.id,
        });
      } catch (err) {
        console.error('Error notifying LIMBO:', err.message);
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('WhatsApp disconnected, reconnecting...', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(initializeWhatsApp, 3000);
      }
    }
  });

  // Credentials saved
  sock.ev.on('creds.update', saveCreds);

  // Messages received
  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message) return;

    const fromMe = message.key.fromMe;
    const chatId = message.key.remoteJid;
    const messageId = message.key.id;
    const timestamp = message.messageTimestamp;
    const text = message.message.conversation || message.message.extendedTextMessage?.text || '';

    console.log(`Message from ${chatId}: ${text}`);

    // Send to LIMBO API
    if (!fromMe) {
      try {
        await axios.post(LIMBO_API, {
          action: 'whatsapp_receive',
          chatId,
          messageId,
          text,
          timestamp,
        });
      } catch (err) {
        console.error('Error sending to LIMBO:', err.message);
      }
    }
  });
}

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: isConnected ? 'connected' : 'disconnected' });
});

app.get('/qr', (req, res) => {
  if (!isConnected) {
    if (qrCode) {
      res.json({ qr: qrCode, status: 'waiting' });
    } else {
      res.json({ status: 'initializing' });
    }
  } else {
    res.json({ status: 'connected' });
  }
});

app.post('/send', async (req, res) => {
  const { phone, text } = req.body;

  if (!sock || !isConnected) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  try {
    const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/logout', async (req, res) => {
  if (sock) {
    await sock.logout();
    sock = null;
    isConnected = false;
    // Clear auth
    fs.rmSync(authDir, { recursive: true, force: true });
  }
  res.json({ success: true });
});

// Start
initializeWhatsApp();

app.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
});
