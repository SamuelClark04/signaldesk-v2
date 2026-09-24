// Alpaca real-time news stream (Benzinga feed). WebSocket only, no REST polling.
// Protocol: connect -> auth -> subscribe to news. Each headline is scored with
// the keyword sentiment engine. Auto-reconnects with exponential backoff.
const WebSocket = require('ws');
const { scoreHeadline } = require('../intelligence/sentiment-nlp');

const DEFAULT_URL = 'wss://stream.data.alpaca.markets/v1beta1/news';
const DEFAULT_SYMBOLS = ['AAPL', 'NVDA', 'SPY'];
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const PING_INTERVAL_MS = 30000;
const MAX_HEADLINES_PER_SYMBOL = 20;

// Alpaca error codes that won't fix themselves by reconnecting.
const FATAL_CODES = new Set([401, 402, 404]); // not authenticated, auth failed, auth timeout

let ws = null;
let symbols = DEFAULT_SYMBOLS;
let onNews = logNews;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer = null;
let pingTimer = null;
let stopped = false;
const recent = new Map(); // symbol -> scored news items, oldest first

function logNews(item) {
  console.log(`[alpaca-news] ${item.symbols.join(',')} [${item.sentiment.classification} ${item.sentiment.score}] ${item.headline}`);
}

function normalizeNews(m) {
  return {
    id: m.id,
    headline: m.headline,
    summary: m.summary,
    source: m.source,
    url: m.url,
    symbols: (m.symbols || []).filter((s) => symbols.includes(s)),
    time: m.updated_at || m.created_at,
    sentiment: scoreHeadline(m.headline),
  };
}

// Keep a short rolling buffer per symbol; a re-sent (updated) story replaces its old copy.
function remember(item) {
  for (const symbol of item.symbols) {
    const list = (recent.get(symbol) || []).filter((n) => n.id !== item.id);
    list.push(item);
    recent.set(symbol, list.slice(-MAX_HEADLINES_PER_SYMBOL));
  }
}

function connect() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    console.error('[alpaca-news] ALPACA_API_KEY / ALPACA_API_SECRET missing; stream disabled');
    return;
  }

  ws = new WebSocket(process.env.ALPACA_NEWS_WS_URL || DEFAULT_URL);
  ws.isAlive = true;

  ws.on('open', () => {
    console.log('[alpaca-news] connected, authenticating');
    ws.send(JSON.stringify({ action: 'auth', key, secret }));
  });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch { return; }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) handleMessage(m);
  });

  ws.on('error', (err) => console.error('[alpaca-news] socket error:', err.message));

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    console.warn(`[alpaca-news] closed (${code})`);
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
        console.log(`[alpaca-news] authenticated, subscribing to news: ${symbols.join(', ')}`);
        ws.send(JSON.stringify({ action: 'subscribe', news: symbols }));
        backoff = BACKOFF_MIN_MS;
      }
      break;
    case 'subscription':
      console.log(`[alpaca-news] subscribed news=${JSON.stringify(m.news)}`);
      break;
    case 'n': {
      const item = normalizeNews(m);
      if (!item.headline || !item.symbols.length) break;
      remember(item);
      onNews(item);
      break;
    }
    case 'error':
      console.error(`[alpaca-news] error ${m.code}: ${m.msg}`);
      if (FATAL_CODES.has(m.code)) {
        console.error('[alpaca-news] fatal auth error; not reconnecting. Check your API keys.');
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
  console.log(`[alpaca-news] reconnecting in ${delay / 1000}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function init(options = {}) {
  if (ws && !stopped) return { stop, getNewsContext };
  symbols = options.symbols || DEFAULT_SYMBOLS;
  onNews = options.onNews || logNews;
  stopped = false;
  backoff = BACKOFF_MIN_MS;
  connect();
  return { stop, getNewsContext };
}

// Shaped for strategies' newsContext input: Map of symbol -> [{ headline, ... }].
function getNewsContext() {
  return new Map([...recent].map(([s, list]) => [s, list.map((n) => ({ ...n }))]));
}

function stop() {
  stopped = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pingTimer);
  if (ws) ws.close();
  ws = null;
}

module.exports = { init, stop, getNewsContext };
