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
const pilotHandler = require('./execution/pilot-handler'); // PILOT_MATRIX snapshot for new clients
const { startPipeline, stopPipeline, runPipeline, getScanStatus, getProximity } = require('./execution/pipeline');
const { getBrokerState } = require('./execution/broker-state');
const rejectionStats = require('./execution/rejection-stats');
const scanLog = require('./execution/scan-log');
const macro = require('./connectors/macro-events');
const watchlist = require('./execution/watchlist');
const prices = require('./market/latest-prices');
const referencePrices = require('./market/reference-prices');
const universe = require('./market/universe');
const { STOCKS, CRYPTO, STREAMED_STOCKS } = universe;
const { getHistory } = require('./connectors/history-bars');
const brokerSync = require('./connectors/broker-sync');
const { buildIntelligence } = require('./intelligence/dashboard-intel');

// Zero trust: every request needs the access token (sign-in cookie), even from
// 127.0.0.1 (a tunnel arrives from localhost). Local-only listener by default;
// LAN_ACCESS=true opens it to the Wi-Fi. See security/access-policy.js.
const { HOST, LAN_ACCESS, checkUpgrade, checkHttp, lanUrls, generatedToken } = require('./security/access-policy');
const authGate = require('./security/auth-gate');
const tunnel = require('./security/tunnel-manager'); // Cloudflare quick tunnel (TUNNEL=off disables)
const mobileLink = require('./security/mobile-link'); // Settings: live tunnel link + email re-send
const externalApi = require('./execution/external-api'); // manual / broker-synced external holdings
const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
authGate.install(app, PORT); // /login is the only page served without a session
app.use(express.static(path.join(__dirname, '..', 'client'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') })); // revalidate: never stale JS
mobileLink.install(app); // behind the sign-in gate, like everything after authGate

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), clients: wss.clients.size });
});

// Chart history: last 100 bars (?tf=1m default; 15m, 1h, 4h, 1d) from Alpaca (stocks) or
// Coinbase (crypto, symbols with "-"). Read-only, but it spends broker API quota,
// so it is guarded like the socket (origin + LAN token).
app.get('/api/history/:symbol', async (req, res) => {
  const verdict = checkHttp(req, PORT);
  if (!verdict.ok) {
    console.warn(`[security] rejected /api/history: ${verdict.reason}`);
    return res.status(403).json({ error: 'forbidden' });
  }
  const result = await getHistory(req.params.symbol, String(req.query.tf || '1m'));
  res.set('Cache-Control', 'no-store');
  if (result.ok) return res.json(result.bars);
  return res.status(result.status || 502).json({ error: result.error });
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
externalApi.install(app, { broadcast }); // /api/portfolio/external (behind the sign-in gate)
rejectionStats.onChange((stats) => broadcast('REJECTION_STATS', stats)); // "Why we passed"
scanLog.onChange((log) => broadcast('SCAN_LOG', log)); // live scanner log, once per pass
watchlist.onChange((items) => broadcast('WATCHLIST_UPDATED', items)); // "Watching"

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handleMessage(ws, raw));
  send(ws, 'hello', { server: 'signaldesk-v2', ts: Date.now() });
  send(ws, 'orders:snapshot', ledger.getPendingOrders());
  send(ws, 'POSITIONS_UPDATED', ledger.getActivePositions());
  send(ws, 'JOURNAL_UPDATED', ledger.getTradeJournal());
  send(ws, 'SAVED_SETUPS', ledger.getSavedSetups());
  send(ws, 'SETTINGS_UPDATED', ledger.getSettings());
  send(ws, 'REJECTION_STATS', rejectionStats.snapshot());
  send(ws, 'WATCHLIST_UPDATED', watchlist.getWatchlist());
  send(ws, 'PRICES_UPDATED', Object.fromEntries(prices.getLatestPrices()));
  send(ws, 'REFERENCE_PRICES', referencePrices.snapshot());
  send(ws, 'SCAN_STATUS', getScanStatus());
  send(ws, 'SCAN_LOG', scanLog.snapshot());
  send(ws, 'PILOT_ACTIONS', ledger.getPilotActions());
  send(ws, 'PILOT_MATRIX', pilotHandler.getMatrix());
  send(ws, 'EXTERNAL_HOLDINGS', externalApi.snapshot());
  send(ws, 'MACRO_EVENTS', macro.upcoming());
  send(ws, 'UNIVERSE', universe.snapshot());
  send(ws, 'TRIGGER_PROXIMITY', getProximity());
  send(ws, 'BROKER_HOLDINGS', brokerSync.getSnapshot()); // last Sync Broker result (never auto-fetched)
  try {
    send(ws, 'DASHBOARD_INTELLIGENCE', buildIntelligence());
  } catch (err) {
    console.error('[intel] snapshot for new client failed:', err.message);
  }
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
  alpacaStocks.init({ symbols: STREAMED_STOCKS }); // free plan: 30 WebSocket symbols (universe.js)
  // News stream (Event Catalyst Engine). Alpaca's connection limit is per endpoint,
  // so it doesn't compete with the bar stream; a 406/404 is retried quietly with
  // backoff inside the connector (see alpaca-news-socket.js).
  alpacaNews.init({ symbols: STREAMED_STOCKS });
  coinbase.init({ symbols: CRYPTO });
  // Last closes for quiet stocks (display only), so a closed market isn't all "—".
  referencePrices.start({ symbols: STOCKS, onChange: (closes) => broadcast('REFERENCE_PRICES', closes) });
  startPipeline({ broadcast });
}

function shutdown() {
  tunnel.stop();
  stopPipeline();
  referencePrices.stop();
  clearInterval(heartbeat);
  alpacaStocks.stop();
  alpacaNews.stop();
  coinbase.stop();
  wss.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Startup banner: where to open the terminal. APP_PUBLIC_URL is the address the
// alert emails link to; it is only printed (no secrets in it).
function banner() {
  const local = `http://127.0.0.1:${PORT}/`;
  const pub = String(process.env.APP_PUBLIC_URL || '').trim();
  const rows = [`Local:   ${local}`, pub ? `Public:  ${pub}  (alert email links)` : 'Public:  APP_PUBLIC_URL not set (alert emails link to the local URL)',
    `Sign in: ${local}login  (token: LAN_ACCESS_TOKEN in .env)`];
  if (generatedToken()) rows.push(`No valid token in .env: this run's token is ${generatedToken()}`);
  const w = Math.max(...rows.map((r) => r.length), 30) + 2;
  console.log(`\n+${'-'.repeat(w)}+\n| ${'SignalDesk is running'.padEnd(w - 1)}|\n${rows.map((r) => `| ${r.padEnd(w - 1)}|`).join('\n')}\n+${'-'.repeat(w)}+\n`);
}

server.listen(PORT, HOST, () => {
  console.log(`SignalDesk-V2 listening on http://${HOST}:${PORT}`);
  banner();
  tunnel.start(PORT);
  if (LAN_ACCESS) {
    const urls = lanUrls(PORT);
    console.warn('[security] LAN ACCESS ON: devices on your network can reach this terminal with the access token.');
    console.warn('[security] Open on your phone (this link contains the secret token; do not share it):');
    for (const u of urls.length ? urls : ['(no private IPv4 address found on this machine)']) console.warn(`           ${u}`);
  }
  start();
});

module.exports = { app, server, wss, broadcast, runPipeline };
