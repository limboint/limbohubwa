const express = require('express');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const axios = require('axios');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let sock = null;
let qrCodeData = null;

const LIMBO_API_URL = process.env.LIMBO_API_URL || 'https://hub.limbointernational.nl/api.php';

// QR-code endpoint
app.get('/qr', async (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData, authenticated: sock?.user?.id ? true : false });
  } else {
    res.json({ qr: null, authenticated: false, message: 'Waiting for QR code...' });
  }
});

// Auth status
app.get('/status', (req, res) => {
  res.json({
    authenticated: sock?.user?.id ? true : false,
    userId: sock?.user?.id || null,
  });
});

// Send message
app.post('/send', async (req, res) => {
  const { to, text } = req.body;
  if (!sock || !sock.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    await sock.sendMessage(to, { text });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize Baileys
async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) qrCodeData = url;
      });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        startBaileys();
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      if (!text) continue;

      // Send to LIMBO API
      try {
        await axios.post(LIMBO_API_URL, {
          action: 'whatsapp_receive_message',
          from,
          text,
          timestamp: msg.messageTimestamp,
        });
      } catch (err) {
        console.error('Failed to send to LIMBO:', err.message);
      }
    }
  });
}

startBaileys();

app.listen(PORT, () => {
  console.log(`Baileys server running on port ${PORT}`);
  console.log(`QR endpoint: http://localhost:${PORT}/qr`);
});
