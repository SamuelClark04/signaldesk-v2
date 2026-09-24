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

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
const cache = new Map(); // symbol -> { at, ok, bars }
const warned = new Set();

async function fetchDailyBars(symbol) {
  const r = await getHistory(symbol, '1d');
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
  const today = etDate.format(now);
  // A 1D bar is stamped at the start of its session (ET midnight), so its ET date is the session date.
  return hit.bars.filter((b) => etDate.format(b.time * 1000) < today).map((b) => ({ ...b }));
}

module.exports = { getDailyBars, CACHE_TTL_MS };
