// SignalDesk-V2 bootloader: HTTP (Express) + client-facing WebSocket hub.
// Starts the market-data connectors and the execution pipeline; all trading
// logic lives in server/execution/*, server/risk/* and server/strategies/*.
require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const alpacaStocks = require('./connectors/alpaca-stock-socket');
const alpacaNews = require('./connectors/alpaca-news-socket');
const coinbase = require('./connectors/coinbase-socket');
const ledger = require('./execution/paper-ledger');
const { createMessageHandler } = require('./execution/message-handler');
const { startPipeline, stopPipeline, runPipeline } = require('./execution/pipeline');
const { getBrokerState } = require('./execution/broker-state');
const rejectionStats = require('./execution/rejection-stats');
const watchlist = require('./execution/watchlist');

// Local-only by default; LAN_ACCESS=true opens it to the Wi-Fi (token-protected).
const { HOST, LAN_ACCESS, checkUpgrade, lanUrls } = require('./security/access-policy');
const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const STOCK_WATCHLIST = ['AAPL', 'NVDA', 'SPY'];
const CRYPTO_WATCHLIST = ['BTC-USD', 'ETH-USD'];

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), clients: wss.clients.size });
});

const server = http.createServer(app);

// ---------- CSWSH shield ----------
// Browsers do not apply same-origin rules to WebSockets, so any page the user
// has open could otherwise connect and send APPROVE or UPDATE_SETTINGS. Every
// upgrade goes through the access policy (origin + LAN token); see
// server/security/access-policy.js.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const verdict = checkUpgrade(req, PORT);
  if (!verdict.ok) {
    console.warn(`[security] rejected WebSocket upgrade: ${verdict.reason}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function broadcast(type, payload) {
  for (const ws of wss.clients) send(ws, type, payload);
}

const handleMessage = createMessageHandler({ send, broadcast });
rejectionStats.onChange((stats) => broadcast('REJECTION_STATS', stats)); // "Why we passed"
watchlist.onChange((items) => broadcast('WATCHLIST_UPDATED', items)); // "Watching"

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handleMessage(ws, raw));
  send(ws, 'hello', { server: 'signaldesk-v2', ts: Date.now() });
  send(ws, 'orders:snapshot', ledger.getPendingOrders());
  send(ws, 'POSITIONS_UPDATED', ledger.getActivePositions());
  send(ws, 'JOURNAL_UPDATED', ledger.getTradeJournal());
  send(ws, 'SETTINGS_UPDATED', ledger.getSettings());
  send(ws, 'REJECTION_STATS', rejectionStats.snapshot());
  send(ws, 'WATCHLIST_UPDATED', watchlist.getWatchlist());
  getBrokerState()
    .then((state) => send(ws, 'BROKER_STATE', state))
    .catch((err) => console.error('[broker] state for new client failed:', err.message));
});

// Drop dead client connections every 30s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function start() {
  alpacaStocks.init({ symbols: STOCK_WATCHLIST });
  // News stream (Event Catalyst Engine). Alpaca's connection limit is per endpoint,
  // so it doesn't compete with the bar stream; a 406/404 is retried quietly with
  // backoff inside the connector (see alpaca-news-socket.js).
  alpacaNews.init({ symbols: STOCK_WATCHLIST });
  coinbase.init({ symbols: CRYPTO_WATCHLIST });
  startPipeline({ broadcast });
}

function shutdown() {
  stopPipeline();
  clearInterval(heartbeat);
  alpacaStocks.stop();
  alpacaNews.stop();
  coinbase.stop();
  wss.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`SignalDesk-V2 listening on http://${HOST}:${PORT}`);
  if (LAN_ACCESS) {
    const urls = lanUrls(PORT);
    console.warn('[security] LAN ACCESS ON: devices on your network can reach this terminal with the access token.');
    console.warn('[security] Open on your phone (this link contains the secret token; do not share it):');
    for (const u of urls.length ? urls : ['(no private IPv4 address found on this machine)']) console.warn(`           ${u}`);
  }
  start();
});

module.exports = { app, server, wss, broadcast, runPipeline };
