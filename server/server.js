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
const cryptoIntra = require('./strategies/2-crypto-intra');
const equitySwing = require('./strategies/3-equity-swing');
const optionsSystem = require('./strategies/5-options-system');
const { processCandidate } = require('./risk/risk-engine');
const ledger = require('./execution/paper-ledger');
const { createMessageHandler } = require('./execution/message-handler');
const { sendApprovalAlert } = require('./execution/notifier');
const prices = require('./market/latest-prices');

const HOST = '127.0.0.1'; // local only: there is no auth on the approval socket
const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const PIPELINE_INTERVAL_MS = 60000;
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

// Each strategy runs isolated: one failing never blocks the others' candidates.
const STRATEGIES = [
  ['equity-day', () => equityDay.generateCandidates(alpacaStocks.getLatestBars(), alpacaNews.getNewsContext())],
  ['crypto-intraday', () => cryptoIntra.generateCandidates(prices.getLatestPrices())],
  ['equity-swing', () => equitySwing.generateCandidates(prices.getLatestPrices())],
  ['options-system', () => optionsSystem.generateCandidates(prices.getLatestPrices())],
];

async function collectCandidates() {
  const all = [];
  for (const [name, generate] of STRATEGIES) {
    try {
      all.push(...(await generate()));
    } catch (err) {
      console.error(`[pipeline] strategy ${name} failed:`, err.message);
    }
  }
  return all;
}

// One pipeline pass. Strategies only propose; the risk engine decides; only
// the ledger holds state. A failure on one candidate never stops the others.
let pipelineRunning = false;
async function runPipeline() {
  if (pipelineRunning) return console.warn('[pipeline] previous pass still running; skipping this tick');
  pipelineRunning = true;
  try {
    return await pipelinePass();
  } finally {
    pipelineRunning = false;
  }
}

// Fire-and-forget alert for a freshly staged order. Not awaited, so a slow
// notifier can never stall the loop; sync throws and rejections are both caught.
function notify(order) {
  Promise.resolve()
    .then(() => sendApprovalAlert(order))
    .catch((err) => console.error(`[notifier] alert for ${order.id} failed: ${err.message}`));
}

async function pipelinePass() {
  const counts = { generated: 0, approved: 0, staged: 0 };
  const candidates = await collectCandidates();
  // Read once per pass: every candidate in a pass is sized against the same bankroll.
  const { bankroll } = ledger.getSettings();
  counts.generated = candidates.length;

  for (const candidate of candidates) {
    const result = processCandidate(candidate, bankroll);
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
      notify(staged);
    } catch (err) {
      // Expected when the same setup is re-proposed on the next tick (duplicate id).
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
  pipelineTimer = setInterval(() => {
    runPipeline().catch((err) => console.error('[pipeline] pass failed:', err));
  }, PIPELINE_INTERVAL_MS);
  console.log(`[pipeline] running every ${PIPELINE_INTERVAL_MS / 1000}s, bankroll $${ledger.getSettings().bankroll} (editable in Settings)`);
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
