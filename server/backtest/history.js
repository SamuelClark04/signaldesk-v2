// Backtest history (Phase 77): PAGED historical bars for a date window (the live history-bars.js only
// keeps the latest ~150). Same free sources as the app, market data only (no broker call):
//   stocks  Alpaca data, IEX feed, MULTI-symbol requests (/v2/stocks/bars, 10,000 bars a page)
//   crypto  Coinbase public candles, 350 a request, paged back from now (4h = 1h candles regrouped)
// Every request goes through net-guard (a dead host fails fast). Loaded series are cached CACHE_MS, so
// re-running a backtest (another rule on the same bars) costs no second download.
const guard = require('../connectors/net-guard');
const { pace } = require('../execution/loop-pace');

const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 15000;
const COINBASE_MAX = 350;
const COINBASE_GAP_MS = 150; // ~6 requests / s: well inside Coinbase's public limit
const STOCK_TF = { '1d': '1Day', '1h': '1Hour', '5m': '5Min' };
const CRYPTO_TF = { '1d': ['ONE_DAY', 86400], '4h': ['ONE_HOUR', 3600, 4], '1h': ['ONE_HOUR', 3600], '15m': ['FIFTEEN_MINUTE', 900], '5m': ['FIVE_MINUTE', 300] };
const cache = new Map(); // `${symbol}|${tf}|${days}` -> { at, bars }
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function getJson(url, headers = {}) {
  let res;
  try {
    res = await guard.guardedFetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) { return { ok: false, error: err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message }; }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return res.ok ? { ok: true, json } : { ok: false, error: `HTTP ${res.status}: ${(json && (json.message || json.error)) || res.statusText}` };
}

// 1h candles -> 4h (UTC-aligned buckets), like the live history.
function regroup(bars, sec) {
  const out = new Map();
  for (const b of bars) {
    const t = Math.floor(b.time / sec) * sec;
    const g = out.get(t);
    if (!g) out.set(t, { ...b, time: t });
    else Object.assign(g, { high: Math.max(g.high, b.high), low: Math.min(g.low, b.low), close: b.close, volume: g.volume + b.volume });
  }
  return [...out.values()];
}
const tidy = (bars) => [...new Map(bars.filter((b) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) && b.close > 0).map((b) => [b.time, b])).values()].sort((a, b) => a.time - b.time);

async function stocks(symbols, tf, days, now) {
  const k = require('../connectors/alpaca-api').dataKeys();
  if (!k) return { ok: false, error: 'No Alpaca keys (market data): add them in Settings > Accounts & Connections' };
  const base = (process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
  const headers = { 'APCA-API-KEY-ID': k.key, 'APCA-API-SECRET-KEY': k.secret };
  const out = Object.fromEntries(symbols.map((s) => [s, []]));
  const start = new Date(now - days * 864e5).toISOString();
  let token = null;
  for (let page = 0; page < 200; page += 1) {
    const q = `symbols=${symbols.map(encodeURIComponent).join(',')}&timeframe=${STOCK_TF[tf]}&start=${encodeURIComponent(start)}&limit=10000&feed=iex&adjustment=split&sort=asc${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
    const r = await getJson(`${base}/v2/stocks/bars?${q}`, headers);
    if (!r.ok) return r;
    for (const [s, list] of Object.entries((r.json && r.json.bars) || {})) {
      if (out[s]) for (const b of list) out[s].push({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    }
    token = r.json && r.json.next_page_token;
    if (!token) break;
    await pace();
  }
  return { ok: true, series: Object.fromEntries(Object.entries(out).map(([s, b]) => [s, tidy(b)])) };
}

async function coin(symbol, tf, days, now) {
  const [gran, sec, group] = CRYPTO_TF[tf];
  const base = (process.env.COINBASE_API_BASE_URL || 'https://api.coinbase.com').replace(/\/+$/, '');
  const from = Math.floor((now - days * 864e5) / 1000);
  let end = Math.floor(now / 1000);
  const bars = [];
  while (end > from) {
    const start = Math.max(from, end - COINBASE_MAX * sec);
    const r = await getJson(`${base}/api/v3/brokerage/market/products/${encodeURIComponent(symbol)}/candles?start=${start}&end=${end}&granularity=${gran}&limit=${COINBASE_MAX}`);
    if (!r.ok) return r;
    for (const c of (r.json && r.json.candles) || []) bars.push({ time: Number(c.start), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) });
    end = start;
    await sleep(COINBASE_GAP_MS);
  }
  const clean = tidy(bars);
  return { ok: true, bars: group ? regroup(clean, sec * group) : clean };
}

// -> { ok, series: { SYMBOL: bars (oldest first, COMPLETED bars only) }, missing: [{ symbol, error }] }
async function load(symbols, tf, market, days, now = Date.now(), onProgress = () => {}) {
  const series = {};
  const missing = [];
  const want = [];
  for (const s of symbols) {
    const hit = cache.get(`${s}|${tf}|${days}`);
    if (hit && now - hit.at < CACHE_MS) series[s] = hit.bars; else want.push(s);
  }
  const barSec = market === 'crypto' ? CRYPTO_TF[tf][1] * (CRYPTO_TF[tf][2] || 1) : { '1d': 86400, '1h': 3600, '5m': 300 }[tf];
  const done = (s, bars) => { const list = bars.filter((b) => (b.time + barSec) * 1000 <= now); cache.set(`${s}|${tf}|${days}`, { at: now, bars: list }); series[s] = list; };
  if (market === 'stocks' && want.length) {
    const r = await stocks(want, tf, days, now);
    if (!r.ok) return { ok: false, error: r.error };
    for (const s of want) if (r.series[s].length) done(s, r.series[s]); else missing.push({ symbol: s, error: 'no bars' });
  }
  if (market === 'crypto') {
    for (const [i, s] of want.entries()) {
      onProgress(`Downloading ${s} (${i + 1} of ${want.length})`);
      const r = await coin(s, tf, days, now);
      if (r.ok && r.bars.length) done(s, r.bars); else missing.push({ symbol: s, error: r.ok ? 'no bars' : r.error });
    }
  }
  return { ok: true, series, missing };
}

module.exports = { load, regroup, tidy, reset: () => cache.clear(), CACHE_MS };
