// Daily bars: on-demand completed daily OHLC history (REST by design).
// The live streams only carry today's 1-minute bars, so multi-day indicators
// (moving averages for the swing system) need a history fetch.
// MOCK for now. The real version will call Alpaca's historical bars endpoint
// (GET https://data.alpaca.markets/v2/stocks/{symbol}/bars?timeframe=1Day).
//
// Completed daily bars only change once a day, so results are cached for hours:
// the 60s pipeline never turns this into a poll loop.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MOCK_DAYS = 60;

const cache = new Map(); // symbol -> { at, value }

// Deterministic synthetic uptrend with a shallow pullback over the last few days:
// rises ~0.4%/day from BASE, then eases ~3% off the recent high.
const MOCK_BASE = Object.freeze({ NVDA: 100, AAPL: 180, SPY: 480 });

function mockBars(symbol) {
  const base = MOCK_BASE[symbol] || 100;
  const bars = [];
  for (let i = 0; i < MOCK_DAYS; i++) {
    const trend = base * (1 + 0.004 * i);
    const pullback = i >= MOCK_DAYS - 4 ? 1 - 0.01 * (i - (MOCK_DAYS - 5)) : 1;
    const wiggle = 1 + 0.003 * Math.sin(i * 1.7);
    const close = Math.round(trend * pullback * wiggle * 100) / 100;
    bars.push({
      day: i - MOCK_DAYS, // -60 .. -1 (yesterday)
      open: close,
      high: Math.round(close * 1.008 * 100) / 100,
      low: Math.round(close * 0.992 * 100) / 100,
      close,
    });
  }
  return bars;
}

async function fetchDailyBars(symbol) {
  // TODO: replace with the Alpaca REST call described above.
  return mockBars(symbol);
}

// Completed daily bars, oldest first. Returns copies so callers can't corrupt the cache.
async function getDailyBars(symbol, now = Date.now()) {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value.map((b) => ({ ...b }));
  const value = await fetchDailyBars(symbol);
  cache.set(symbol, { at: now, value });
  return value.map((b) => ({ ...b }));
}

module.exports = { getDailyBars, CACHE_TTL_MS };
