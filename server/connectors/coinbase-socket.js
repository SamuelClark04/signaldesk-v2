// Coinbase Advanced Trade public market-data stream. WebSocket only, no REST.
// The ticker channel needs no API key. We also subscribe to "heartbeats",
// because Coinbase closes subscriptions that go 60-90s without messages.
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://advanced-trade-ws.coinbase.com';
const DEFAULT_PRODUCTS = ['BTC-USD', 'ETH-USD'];
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const PING_INTERVAL_MS = 30000;
const LOG_THROTTLE_MS = 5000; // ticker fires many times/sec; throttle the default logger

let ws = null;
let products = DEFAULT_PRODUCTS;
let onTick = logTick;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer = null;
let pingTimer = null;
let stopped = false;
const latest = new Map(); // product_id -> last normalized tick
const lastLogged = new Map(); // product_id -> ms timestamp

function logTick(tick) {
  const now = Date.now();
  if (now - (lastLogged.get(tick.symbol) || 0) < LOG_THROTTLE_MS) return;
  lastLogged.set(tick.symbol, now);
  console.log(`[coinbase] ${tick.symbol} ${tick.price} (bid ${tick.bid} / ask ${tick.ask}, 24h ${tick.change24hPct}%)`);
}

function normalizeTick(t, time) {
  return {
    symbol: t.product_id,
    price: Number(t.price),
    bid: Number(t.best_bid),
    ask: Number(t.best_ask),
    volume24h: Number(t.volume_24_h),
    change24hPct: Number(t.price_percent_chg_24_h),
    time,
  };
}

function subscribe(channel) {
  ws.send(JSON.stringify({ type: 'subscribe', product_ids: products, channel }));
}

function connect() {
  ws = new WebSocket(process.env.COINBASE_WS_URL || DEFAULT_URL);
  ws.isAlive = true;

  ws.on('open', () => {
    console.log(`[coinbase] connected, subscribing to ticker: ${products.join(', ')}`);
    subscribe('ticker');
    subscribe('heartbeats');
    backoff = BACKOFF_MIN_MS;
  });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(msg);
  });

  ws.on('error', (err) => console.error('[coinbase] socket error:', err.message));

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    console.warn(`[coinbase] closed (${code})`);
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

function handleMessage(msg) {
  if (msg.type === 'error') {
    console.error(`[coinbase] error: ${msg.message}`);
    return;
  }
  if (msg.channel === 'subscriptions') {
    console.log(`[coinbase] subscriptions: ${JSON.stringify(msg.events?.[0]?.subscriptions)}`);
    return;
  }
  if (msg.channel !== 'ticker') return; // heartbeats etc. only keep the socket alive

  for (const event of msg.events || []) {
    for (const t of event.tickers || []) {
      const tick = normalizeTick(t, msg.timestamp);
      latest.set(tick.symbol, tick);
      onTick(tick);
    }
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  console.log(`[coinbase] reconnecting in ${delay / 1000}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Stream more products (held coins outside the base universe: synced Coinbase
// balances, manual crypto holdings, Phase 56 gem-watchlist and charted gems). Subscribed now if connected, and kept for
// every reconnect. A product Coinbase does not list only fails its own message.
function addProducts(list) {
  const fresh = [...new Set(list)].filter((p) => /^[A-Z0-9]{1,10}-USDC?$/.test(p) && !products.includes(p));
  if (!fresh.length) return [];
  products = [...products, ...fresh];
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', product_ids: fresh, channel: 'ticker' }));
  console.log(`[coinbase] streaming ${fresh.length} more product(s): ${fresh.slice(0, 12).join(', ')}${fresh.length > 12 ? ` +${fresh.length - 12}` : ''}`);
  return fresh;
}

function init(options = {}) {
  if (ws && !stopped) return { stop, getLatest };
  products = options.symbols || DEFAULT_PRODUCTS;
  onTick = options.onTick || logTick;
  stopped = false;
  backoff = BACKOFF_MIN_MS;
  connect();
  return { stop, getLatest };
}

function getLatest(symbol) {
  return symbol ? latest.get(symbol) : Object.fromEntries(latest);
}

function stop() {
  stopped = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pingTimer);
  if (ws) ws.close();
  ws = null;
}

module.exports = { init, stop, getLatest, addProducts };
