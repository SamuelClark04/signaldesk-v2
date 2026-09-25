// Alpaca IEX market-data stream (free tier, 30 symbols). REST bars for the rest are
// ingested by market/stock-poller.js.
// Protocol: connect -> auth -> subscribe to minute bars. Auto-reconnects with
// exponential backoff. The free tier allows one connection PER ENDPOINT, so this
// stream (v2/iex) and the news stream (v1beta1/news) don't compete.
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://stream.data.alpaca.markets/v2/iex';
const DEFAULT_SYMBOLS = ['AAPL', 'NVDA', 'SPY'];
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const PING_INTERVAL_MS = 30000;
const MAX_BARS_PER_SYMBOL = 400; // one regular session is 390 one-minute bars

// Alpaca error codes that won't fix themselves by reconnecting (bad credentials).
const FATAL_CODES = new Set([401, 402]); // not authenticated, auth failed

// Codes that DO clear up on their own, retried quietly with a longer backoff:
//   406 connection limit exceeded: another session already holds this endpoint
//       (a second SignalDesk, another app on the same keys, or Alpaca still
//       counting the previous session for a while after a disconnect/restart);
//   404 auth timeout: authentication didn't complete in time (slow network).
// While this stream is down, prices go stale: after 5 minutes latest-prices
// treats them as missing, so approvals get NO_LIVE_PRICE and the paper exit
// monitor waits. Nothing trades on stale data.
const RETRY_QUIETLY = new Set([404, 406]);
const LIMIT_BACKOFF_MIN_MS = 5000;

let quietRetry = null; // { code, attempts, since } while retrying 404/406 without log spam

let ws = null;
let symbols = DEFAULT_SYMBOLS;
let onBar = logBar;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer = null;
let pingTimer = null;
let stopped = false;
const barsBySymbol = new Map(); // symbol -> 1m bars, oldest first
const streamAt = new Map(); // symbol -> ms of its last bar FROM THE WEBSOCKET (not REST-ingested ones)

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
    if (!quietRetry) console.log('[alpaca] connected, authenticating');
    ws.send(JSON.stringify({ action: 'auth', key, secret }));
  });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch { return; }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) handleMessage(m);
  });

  ws.on('error', (err) => { if (!quietRetry) console.error('[alpaca] socket error:', err.message); });

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    if (!quietRetry) console.warn(`[alpaca] closed (${code})`);
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
        if (quietRetry) {
          const secs = Math.round((Date.now() - quietRetry.since) / 1000);
          console.log(`[alpaca] recovered: connected after ${quietRetry.attempts} quiet retr${quietRetry.attempts === 1 ? 'y' : 'ies'} (${secs}s)`);
          quietRetry = null;
        }
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
      streamAt.set(bar.symbol, Date.now());
      onBar(bar);
      break;
    }
    case 'error':
      if (RETRY_QUIETLY.has(m.code)) {
        startQuietRetry(m);
        break;
      }
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

// 404/406: warn once per streak, then retry silently (5s, 10s, 20s, 40s, 60s, 60s...)
// until a session authenticates. Our side closes the socket so a half-open
// session can never keep holding the endpoint.
function startQuietRetry(m) {
  if (!quietRetry) {
    quietRetry = { code: m.code, attempts: 0, since: Date.now() };
    const why = m.code === 406
      ? 'another session already holds the stock-bar stream (a second SignalDesk, another app on these keys, or the previous session still closing)'
      : 'authentication did not complete in time';
    console.warn(`[alpaca] ${m.code} ${m.msg}: ${why}. Retrying quietly in the background (5s up to every 60s); `
      + 'prices go stale meanwhile, so approvals and paper exits wait.');
  }
  quietRetry.attempts += 1;
  backoff = Math.max(backoff, LIMIT_BACKOFF_MIN_MS);
  if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  if (!quietRetry) console.log(`[alpaca] reconnecting in ${delay / 1000}s`);
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
  quietRetry = null;
  connect();
  return { stop, getLatestBars };
}

// Shaped for strategies' marketDataMap input: Map of symbol -> [1m bars].
function getLatestBars() {
  return new Map([...barsBySymbol].map(([s, list]) => [s, list.map((b) => ({ ...b }))]));
}

// REST 1-minute bars for symbols past the 30-symbol WebSocket cap (market/stock-poller.js,
// Phase 59B), buffered with the streamed ones so every strategy reads one bar store.
// Merged by bar time (a REST page can overlap bars already held), oldest first.
function ingest(bars) {
  const by = new Map();
  for (const b of bars) { if (!by.has(b.symbol)) by.set(b.symbol, []); by.get(b.symbol).push(b); }
  for (const [symbol, list] of by) {
    const m = new Map((barsBySymbol.get(symbol) || []).map((b) => [Date.parse(b.time), b]));
    for (const b of list) m.set(Date.parse(b.time), b);
    barsBySymbol.set(symbol, [...m].sort((a, b) => a[0] - b[0]).map(([, b]) => b).slice(-MAX_BARS_PER_SYMBOL));
  }
}
// symbol -> ms its last WebSocket bar arrived (the poller fills the ones that go quiet).
const streamTimes = () => Object.fromEntries(streamAt);

function stop() {
  stopped = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pingTimer);
  if (ws) ws.close();
  ws = null;
}

module.exports = { init, stop, getLatestBars, ingest, streamTimes };
