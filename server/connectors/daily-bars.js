// Daily bars: on-demand completed daily OHLC history (REST by design).
// The live streams only carry today's 1-minute bars, so multi-day indicators
// (moving averages for the swing system) need a history fetch.
// Real data: the same 1D history fetcher the Setups chart and adoption levels
// use (history-bars.js: Alpaca IEX for stocks, Coinbase for crypto).
//
// Completed sessions only: today's still-forming bar is dropped (its ET date is
// today), so indicators never mix a partial day with finished ones.
// Completed daily bars only change once a day, so results are cached for hours:
// the 60s pipeline never turns this into a poll loop.
const { getHistory } = require('./history-bars');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000; // retry a failed fetch sooner
const LONG_FAIL_TTL_MS = 60 * 1000; // the Pilot's 260-session history: retried within a minute

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
const cache = new Map(); // symbol -> { at, ok, bars }
const longCache = new Map(); // symbol -> { at, ok, bars, product } ('1d-long', 260 sessions)
const warned = new Set();

// A coin's history from its -USD book, else its -USDC book (some coins trade mostly there).
async function coinHistory(symbol, tf) {
  const r = await getHistory(symbol, tf);
  if (!symbol.endsWith('-USD') || (r.ok && r.bars.length)) return { ...r, product: symbol };
  const usdc = await getHistory(symbol.replace(/-USD$/, '-USDC'), tf);
  return usdc.ok && usdc.bars.length ? { ...usdc, product: symbol.replace(/-USD$/, '-USDC') } : { ...r, product: symbol };
}

async function fetchDailyBars(symbol) {
  const r = await coinHistory(symbol, '1d');
  if (!r.ok) {
    if (!warned.has(symbol)) console.warn(`[daily-bars] ${symbol}: no daily history (${r.error}); swing analysis skipped`);
    warned.add(symbol);
    return { ok: false, bars: [] };
  }
  warned.delete(symbol);
  return { ok: true, bars: r.bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })) };
}

// Completed daily bars, oldest first: [{ time, open, high, low, close }] ([] on
// failure). Returns copies so callers can't corrupt the cache.
async function getDailyBars(symbol, now = Date.now()) {
  let hit = cache.get(symbol);
  if (!hit || now - hit.at >= (hit.ok ? CACHE_TTL_MS : FAIL_TTL_MS)) {
    hit = { at: now, ...(await fetchDailyBars(symbol)) };
    cache.set(symbol, hit);
  }
  // Stocks: a 1D bar is stamped at its session start (ET midnight), so today's ET
  // date = still forming. Crypto trades 24/7 in UTC days: complete once 24h passed.
  const today = etDate.format(now);
  const done = symbol.includes('-') ? (b) => (b.time + 86400) * 1000 <= now : (b) => etDate.format(b.time * 1000) < today;
  return hit.bars.filter(done).map((b) => ({ ...b }));
}

const completed = (symbol, now) => {
  const today = etDate.format(now);
  return symbol.includes('-') ? (b) => (b.time + 86400) * 1000 <= now : (b) => etDate.format(b.time * 1000) < today;
};

// The Pilot's deep history (260 sessions, for 200-day averages): completed bars,
// oldest first. A failed fetch keeps the last good bars and is retried within a
// minute; it is never cached as "0 sessions" for hours (the ETHFI bug).
async function getLongDailyBars(symbol, now = Date.now()) {
  const hit = longCache.get(symbol);
  if (!hit || now - hit.at >= (hit.ok ? CACHE_TTL_MS : LONG_FAIL_TTL_MS)) {
    const r = await coinHistory(symbol, '1d-long');
    const ok = r.ok && r.bars.length > 0;
    if (!ok) console.warn(`[daily-bars] ${symbol}: long daily history unavailable (${r.error || 'no bars'}); retrying in ${LONG_FAIL_TTL_MS / 1000}s`);
    longCache.set(symbol, { at: now, ok, bars: ok ? r.bars : (hit ? hit.bars : []), product: r.product });
  }
  return longCache.get(symbol).bars.filter(completed(symbol, now)).map((b) => ({ ...b }));
}

// Held symbols (synced Coinbase coins, manual holdings): both daily histories
// fetched now (startup, after Sync Broker), one symbol at a time (paced).
async function warmHoldings(symbols, now = Date.now()) {
  const out = {};
  for (const s of [...new Set(symbols)]) {
    out[s] = (await getLongDailyBars(s, now)).length;
    await getDailyBars(s, now);
  }
  return out;
}

// Cached completed bars only (sync, no fetch): [] when not cached yet. For sync
// callers (1-equity-day's daily-ATR check); equity-swing keeps the cache warm.
function peekDailyBars(symbol, now = Date.now()) {
  const hit = cache.get(symbol);
  if (!hit || !hit.ok) return [];
  const today = etDate.format(now);
  const done = symbol.includes('-') ? (b) => (b.time + 86400) * 1000 <= now : (b) => etDate.format(b.time * 1000) < today;
  return hit.bars.filter(done).map((b) => ({ ...b }));
}

function reset() { cache.clear(); longCache.clear(); }

module.exports = { getDailyBars, peekDailyBars, getLongDailyBars, warmHoldings, reset, CACHE_TTL_MS };
