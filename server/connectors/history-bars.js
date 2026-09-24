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
// Coinbase has no 4-hour candles: 4h is built from 1-hour candles (`group`).
const TIMEFRAMES = Object.freeze({
  '1m': { alpaca: '1Min', coinbase: 'ONE_MINUTE', sec: 60, lookbackDays: 7 },
  '5m': { alpaca: '5Min', coinbase: 'FIVE_MINUTE', sec: 300, lookbackDays: 7 },
  '15m': { alpaca: '15Min', coinbase: 'FIFTEEN_MINUTE', sec: 900, lookbackDays: 14 },
  '1h': { alpaca: '1Hour', coinbase: 'ONE_HOUR', sec: 3600, lookbackDays: 30 },
  '4h': { alpaca: '4Hour', coinbase: 'ONE_HOUR', sec: 14400, lookbackDays: 180, group: 4 },
  '1d': { alpaca: '1Day', coinbase: 'ONE_DAY', sec: 86400, lookbackDays: 200 },
  // Deeper daily history for 200-day averages (Portfolio Pilot); not a chart timeframe.
  '1d-long': { alpaca: '1Day', coinbase: 'ONE_DAY', sec: 86400, lookbackDays: 420, limit: 260 },
});
const COINBASE_MAX_CANDLES = 350;

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
  const query = `timeframe=${tf.alpaca}&limit=${tf.limit || LIMIT}&feed=iex&sort=desc&start=${encodeURIComponent(start)}`;
  const r = await getJson(`${alpacaData()}/v2/stocks/${encodeURIComponent(symbol)}/bars?${query}`, headers);
  if (!r.ok) return r;
  const bars = (r.json.bars || []).map((b) => ({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  return { ok: true, bars };
}

async function fetchCrypto(symbol, tf) {
  const group = tf.group || 1;
  const baseSec = tf.sec / group;
  const count = Math.min((tf.limit || LIMIT) * group, COINBASE_MAX_CANDLES);
  const end = Math.floor(Date.now() / 1000);
  const query = `start=${end - count * baseSec}&end=${end}&granularity=${tf.coinbase}&limit=${count}`;
  const r = await getJson(`${coinbaseBase()}/api/v3/brokerage/market/products/${encodeURIComponent(symbol)}/candles?${query}`);
  if (!r.ok) return r;
  const bars = (r.json.candles || []).map((c) => ({
    time: Number(c.start), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
  }));
  return { ok: true, bars: group > 1 ? regroup(bars, tf.sec) : bars };
}

// Merges smaller candles into tfSec buckets (UTC-aligned), e.g. 1h -> 4h.
function regroup(bars, tfSec) {
  const out = new Map();
  for (const b of [...bars].sort((x, y) => x.time - y.time)) {
    const t = Math.floor(b.time / tfSec) * tfSec;
    const g = out.get(t);
    if (!g) out.set(t, { ...b, time: t });
    else Object.assign(g, { high: Math.max(g.high, b.high), low: Math.min(g.low, b.low), close: b.close, volume: (g.volume || 0) + (b.volume || 0) });
  }
  return [...out.values()];
}

// Oldest first, one bar per timestamp, finite prices only.
function clean(bars, limit = LIMIT) {
  const byTime = new Map();
  for (const b of bars) {
    if ([b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) && b.close > 0) byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

// { ok: true, bars: [{ time (unix seconds), open, high, low, close, volume }] } or { ok: false, status, error }.
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
  const bars = clean(result.bars, tf.limit || LIMIT);
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
