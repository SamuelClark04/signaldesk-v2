// SignalDesk-V2 server entry: HTTP (Express) + client-facing WebSocket hub,
// plus the master pipeline: Connectors -> Strategy -> Risk Engine -> Ledger.
// Keep this file thin: wiring only. Logic lives in the modules it imports.
require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const alpacaStocks = require('./connectors/alpaca-stock-socket');
const alpacaNews = require('./connectors/alpaca-news-socket');
const coinbase = require('./connectors/coinbase-socket');
const equityDay = require('./strategies/1-equity-day');
const { processCandidate } = require('./risk/risk-engine');
const ledger = require('./execution/paper-ledger');
const { validateApproval } = require('./execution/order-guard');
const prices = require('./market/latest-prices');

const HOST = '127.0.0.1'; // local only: there is no auth on the approval socket
const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const PIPELINE_INTERVAL_MS = 60000;
const BANKROLL = 10000; // paper bankroll, fixed for now
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

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, 'error', 'invalid JSON'); }
    if (msg.type === 'ping') return send(ws, 'pong', Date.now());
    if (QUEUE_ACTIONS[msg.type]) return handleQueueAction(ws, msg);
    send(ws, 'error', `unknown message type: ${msg.type}`);
  });
  send(ws, 'hello', { server: 'signaldesk-v2', ts: Date.now() });
  send(ws, 'orders:snapshot', ledger.getPendingOrders());
  send(ws, 'POSITIONS_UPDATED', ledger.getActivePositions());
  send(ws, 'JOURNAL_UPDATED', ledger.getTradeJournal());
});

// Client intents. The client only asks; the ledger decides and the server
// broadcasts the resulting queue so every open client shows the same state.
const QUEUE_ACTIONS = {
  APPROVE: (id) => approveWithGuard(id),
  REJECT: (id) => ledger.discardOrder(id),
};

// Guarded approval: fills at the live price, or retires the setup with a reason.
function approveWithGuard(id) {
  const order = ledger.getPendingOrders().find((o) => o.id === id);
  if (!order) throw new Error(`no pending order ${id}`);
  const livePrice = prices.getLatestPrice(order.asset);
  const check = validateApproval(order, livePrice);
  if (check.valid) return ledger.executeOrder(id, livePrice);
  // A missing price is a data gap, not a verdict on the setup: leave it pending.
  if (check.reason !== 'NO_LIVE_PRICE') ledger.discardOrder(id);
  throw new Error(check.reason);
}

function handleQueueAction(ws, { type, id }) {
  try {
    if (typeof id !== 'string' || !id) throw new Error('missing order id');
    const result = QUEUE_ACTIONS[type](id);
    console.log(`[ledger] ${type} ${id} -> ${result.status}`);
    if (result.status === 'open') broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
  } catch (err) {
    console.warn(`[ledger] ${type} ${id} failed: ${err.message}`);
    send(ws, 'ACTION_FAILED', { type, id, error: err.message });
  }
  broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
}

// Drop dead client connections every 30s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// One pipeline pass. Strategies only propose; the risk engine decides; only
// the ledger holds state. A failure on one candidate never stops the others.
function runPipeline() {
  const counts = { generated: 0, approved: 0, staged: 0 };
  let candidates = [];
  try {
    candidates = equityDay.generateCandidates(alpacaStocks.getLatestBars(), alpacaNews.getNewsContext());
  } catch (err) {
    console.error('[pipeline] strategy equity-day failed:', err.message);
  }
  counts.generated = candidates.length;

  for (const candidate of candidates) {
    const result = processCandidate(candidate, BANKROLL);
    if (!result.approved) {
      console.log(`[pipeline] rejected ${result.candidateId}: ${result.reason}`);
      continue;
    }
    counts.approved += 1;
    try {
      const staged = ledger.stageOrder(result);
      counts.staged += 1;
      broadcast('order:staged', staged);
      console.log(`[pipeline] staged ${result.id}: ${result.positionSize} @ ${result.entryPrice}, stop ${result.invalidation}`);
    } catch (err) {
      // Expected when the same breakout is re-proposed on the next tick (duplicate id).
      console.log(`[pipeline] not staged ${result.id}: ${err.message}`);
    }
  }

  // Exit management for filled positions: stops and T1 targets on fresh prices.
  try {
    const closed = ledger.monitorPositions(prices.getLatestPrices());
    for (const t of closed) {
      console.log(`[ledger] closed ${t.id} ${t.exitReason} @ ${t.exitPrice}: net ${t.netPnl.toFixed(2)} (${t.rMultiple.toFixed(2)}R)`);
    }
    if (closed.length) {
      broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
      broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
    }
  } catch (err) {
    console.error('[pipeline] position monitor failed:', err.message);
  }

  console.log(`[pipeline] candidates=${counts.generated} approved=${counts.approved} staged=${counts.staged}`);
  return counts;
}

let pipelineTimer = null;

function start() {
  alpacaStocks.init({ symbols: STOCK_WATCHLIST });
  alpacaNews.init({ symbols: STOCK_WATCHLIST });
  coinbase.init({ symbols: CRYPTO_WATCHLIST });
  pipelineTimer = setInterval(runPipeline, PIPELINE_INTERVAL_MS);
  console.log(`[pipeline] running every ${PIPELINE_INTERVAL_MS / 1000}s, bankroll $${BANKROLL}`);
}

function shutdown() {
  clearInterval(pipelineTimer);
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
