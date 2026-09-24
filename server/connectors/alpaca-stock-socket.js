// Alpaca IEX market-data stream (free tier). WebSocket only, no REST polling.
// Protocol: connect -> auth -> subscribe to minute bars. Auto-reconnects with
// exponential backoff. Free tier allows ONE concurrent stream connection.
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://stream.data.alpaca.markets/v2/iex';
const DEFAULT_SYMBOLS = ['AAPL', 'NVDA', 'SPY'];
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const PING_INTERVAL_MS = 30000;
const MAX_BARS_PER_SYMBOL = 400; // one regular session is 390 one-minute bars

// Alpaca error codes that won't fix themselves by reconnecting.
const FATAL_CODES = new Set([401, 402, 404]); // not authenticated, auth failed, auth timeout

let ws = null;
let symbols = DEFAULT_SYMBOLS;
let onBar = logBar;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer = null;
let pingTimer = null;
let stopped = false;
const barsBySymbol = new Map(); // symbol -> 1m bars, oldest first

function logBar(bar) {
  console.log(`[alpaca] ${bar.symbol} ${bar.time} O:${bar.open} H:${bar.high} L:${bar.low} C:${bar.close} V:${bar.volume}`);
}

function normalizeBar(m) {
  return { symbol: m.S, open: m.o, high: m.h, low: m.l, close: m.c, volume: m.v, vwap: m.vw, time: m.t };
}

// Buffer bars for strategies. There is no REST backfill, so after a restart the
// buffer only holds bars received since reconnecting.
function remember(bar) {
  const list = (barsBySymbol.get(bar.symbol) || []).filter((b) => b.time !== bar.time);
  list.push(bar);
  barsBySymbol.set(bar.symbol, list.slice(-MAX_BARS_PER_SYMBOL));
}

function connect() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    console.error('[alpaca] ALPACA_API_KEY / ALPACA_API_SECRET missing; stream disabled');
    return;
  }

  ws = new WebSocket(process.env.ALPACA_WS_URL || DEFAULT_URL);
  ws.isAlive = true;

  ws.on('open', () => {
    console.log('[alpaca] connected, authenticating');
    ws.send(JSON.stringify({ action: 'auth', key, secret }));
  });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch { return; }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) handleMessage(m);
  });

  ws.on('error', (err) => console.error('[alpaca] socket error:', err.message));

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    console.warn(`[alpaca] closed (${code})`);
    scheduleReconnect();
  });

  // Detect half-open connections: no pong within one interval => terminate.
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }, PING_INTERVAL_MS);
}

function handleMessage(m) {
  switch (m.T) {
    case 'success':
      if (m.msg === 'authenticated') {
        console.log(`[alpaca] authenticated, subscribing to bars: ${symbols.join(', ')}`);
        ws.send(JSON.stringify({ action: 'subscribe', bars: symbols }));
        backoff = BACKOFF_MIN_MS;
      }
      break;
    case 'subscription':
      console.log(`[alpaca] subscribed bars=${JSON.stringify(m.bars)}`);
      break;
    case 'b': {
      const bar = normalizeBar(m);
      remember(bar);
      onBar(bar);
      break;
    }
    case 'error':
      console.error(`[alpaca] error ${m.code}: ${m.msg}`);
      if (FATAL_CODES.has(m.code)) {
        console.error('[alpaca] fatal auth error; not reconnecting. Check your API keys.');
        stop();
      }
      break;
    default:
      break;
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  console.log(`[alpaca] reconnecting in ${delay / 1000}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function init(options = {}) {
  if (ws && !stopped) return { stop, getLatestBars };
  symbols = options.symbols || DEFAULT_SYMBOLS;
  onBar = options.onBar || logBar;
  stopped = false;
  backoff = BACKOFF_MIN_MS;
  connect();
  return { stop, getLatestBars };
}

// Shaped for strategies' marketDataMap input: Map of symbol -> [1m bars].
function getLatestBars() {
  return new Map([...barsBySymbol].map(([s, list]) => [s, list.map((b) => ({ ...b }))]));
}

function stop() {
  stopped = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pingTimer);
  if (ws) ws.close();
  ws = null;
}

module.exports = { init, stop, getLatestBars };
