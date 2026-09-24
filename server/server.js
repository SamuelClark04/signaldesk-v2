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

const HOST = '127.0.0.1'; // local only: there is no auth on the approval socket
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
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function broadcast(type, payload) {
  for (const ws of wss.clients) send(ws, type, payload);
}

const handleMessage = createMessageHandler({ send, broadcast });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handleMessage(ws, raw));
  send(ws, 'hello', { server: 'signaldesk-v2', ts: Date.now() });
  send(ws, 'orders:snapshot', ledger.getPendingOrders());
  send(ws, 'POSITIONS_UPDATED', ledger.getActivePositions());
  send(ws, 'JOURNAL_UPDATED', ledger.getTradeJournal());
  send(ws, 'SETTINGS_UPDATED', ledger.getSettings());
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
  start();
});

module.exports = { app, server, wss, broadcast, runPipeline };
