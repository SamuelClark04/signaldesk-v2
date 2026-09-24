// Historical candles (REST, on demand) for the Setups chart, plus last closes for
// stocks whose live stream is quiet (market closed, weekend, fresh restart).
//   Stocks: Alpaca market data, IEX feed (the same feed as the bar stream).
//   Crypto: Coinbase Advanced Trade public market endpoint (no auth needed).
// Results are cached briefly, so repeated chart opens never become a poll loop.
//
// Never throws: every outcome is { ok: true, ... } or { ok: false, status, error }.
const SYMBOL_RE = /^[A-Z0-9.]{1,10}(-[A-Z]{2,5})?$/; // AAPL, BRK.B, BTC-USD
const LIMIT = 100;
const CACHE_MS = 30 * 1000;
const TIMEOUT_MS = 8000;
const TIMEFRAMES = Object.freeze({
  '1m': { alpaca: '1Min', coinbase: 'ONE_MINUTE', sec: 60, lookbackDays: 7 },
  '1h': { alpaca: '1Hour', coinbase: 'ONE_HOUR', sec: 3600, lookbackDays: 30 },
});

const cache = new Map(); // `${symbol}|${tf}` -> { at, bars }
const isCrypto = (symbol) => symbol.includes('-');

async function getJson(url, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, status: 502, error: err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) return { ok: false, status: 502, error: `HTTP ${res.status}: ${(json && (json.message || json.error)) || res.statusText}` };
  return { ok: true, json };
}

function alpacaHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  return key && secret ? { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } : null;
}
const alpacaData = () => (process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
const coinbaseBase = () => (process.env.COINBASE_API_BASE_URL || 'https://api.coinbase.com').replace(/\/+$/, '');

// Latest LIMIT bars within the lookback window, newest first from Alpaca.
async function fetchStock(symbol, tf) {
  const headers = alpacaHeaders();
  if (!headers) return { ok: false, status: 503, error: 'ALPACA_API_KEY / ALPACA_API_SECRET not set in .env' };
  const start = new Date(Date.now() - tf.lookbackDays * 86400000).toISOString();
  const query = `timeframe=${tf.alpaca}&limit=${LIMIT}&feed=iex&sort=desc&start=${encodeURIComponent(start)}`;
  const r = await getJson(`${alpacaData()}/v2/stocks/${encodeURIComponent(symbol)}/bars?${query}`, headers);
  if (!r.ok) return r;
  const bars = (r.json.bars || []).map((b) => ({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c }));
  return { ok: true, bars };
}

async function fetchCrypto(symbol, tf) {
  const end = Math.floor(Date.now() / 1000);
  const query = `start=${end - LIMIT * tf.sec}&end=${end}&granularity=${tf.coinbase}&limit=${LIMIT}`;
  const r = await getJson(`${coinbaseBase()}/api/v3/brokerage/market/products/${encodeURIComponent(symbol)}/candles?${query}`);
  if (!r.ok) return r;
  const bars = (r.json.candles || []).map((c) => ({ time: Number(c.start), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }));
  return { ok: true, bars };
}

// Oldest first, one bar per timestamp, finite prices only.
function clean(bars) {
  const byTime = new Map();
  for (const b of bars) {
    if ([b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) && b.close > 0) byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// { ok: true, bars: [{ time (unix seconds), open, high, low, close }] } or { ok: false, status, error }.
async function getHistory(symbol, timeframe = '1m', now = Date.now()) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) return { ok: false, status: 400, error: `invalid symbol "${String(symbol).slice(0, 20)}"` };
  const tf = TIMEFRAMES[timeframe];
  if (!tf) return { ok: false, status: 400, error: `timeframe must be one of ${Object.keys(TIMEFRAMES).join(', ')}` };
  const key = `${s}|${timeframe}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return { ok: true, bars: hit.bars.map((b) => ({ ...b })) };
  const result = isCrypto(s) ? await fetchCrypto(s, tf) : await fetchStock(s, tf);
  if (!result.ok) return result;
  const bars = clean(result.bars);
  cache.set(key, { at: now, bars });
  return { ok: true, bars: bars.map((b) => ({ ...b })) };
}

// Last completed 1-minute bar per stock, in one request. A bar is stamped at its
// start, so its close is a minute later. { ok: true, closes: { SYM: { price, time } } }.
async function getLatestStockCloses(symbols) {
  const headers = alpacaHeaders();
  if (!headers) return { ok: false, status: 503, error: 'ALPACA_API_KEY / ALPACA_API_SECRET not set in .env' };
  const list = symbols.filter((s) => SYMBOL_RE.test(s) && !isCrypto(s));
  if (!list.length) return { ok: true, closes: {} };
  const r = await getJson(`${alpacaData()}/v2/stocks/bars/latest?symbols=${list.map(encodeURIComponent).join(',')}&feed=iex`, headers);
  if (!r.ok) return r;
  const closes = {};
  for (const [symbol, b] of Object.entries(r.json.bars || {})) {
    if (b && b.c > 0) closes[symbol] = { price: b.c, time: Date.parse(b.t) + 60000 };
  }
  return { ok: true, closes };
}

module.exports = { getHistory, getLatestStockCloses, TIMEFRAMES };
