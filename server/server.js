// SignalDesk-V2 server entry: HTTP (Express) + client-facing WebSocket hub.
// Keep this file thin: wiring only. Market feeds, strategies, risk and ledger
// live in their own modules and are attached here later.
require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), clients: wss.clients.size });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function broadcast(type, payload) {
  for (const ws of wss.clients) send(ws, type, payload);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, 'error', 'invalid JSON'); }
    if (msg.type === 'ping') return send(ws, 'pong', Date.now());
    send(ws, 'error', `unknown message type: ${msg.type}`);
  });
  send(ws, 'hello', { server: 'signaldesk-v2', ts: Date.now() });
});

// Drop dead client connections every 30s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function shutdown() {
  clearInterval(heartbeat);
  wss.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`SignalDesk-V2 listening on :${PORT}`));

module.exports = { app, server, wss, broadcast };
