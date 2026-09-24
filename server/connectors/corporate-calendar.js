// Corporate calendar: on-demand "days until next earnings" (REST by design).
// MOCK for now. The real version will call an earnings-calendar endpoint and
// count trading days from today to the next report date.
//
// Earnings dates change rarely, so results are cached per ticker for the day.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const MOCK_DAYS_TO_EARNINGS = Object.freeze({ NVDA: 2 });
const MOCK_DEFAULT_DAYS = 14;

const cache = new Map(); // ticker -> { at, value }

async function fetchDaysToEarnings(ticker) {
  // TODO: replace with a real earnings-calendar REST call.
  return MOCK_DAYS_TO_EARNINGS[ticker] ?? MOCK_DEFAULT_DAYS;
}

async function getDaysToEarnings(ticker, now = Date.now()) {
  const hit = cache.get(ticker);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fetchDaysToEarnings(ticker);
  cache.set(ticker, { at: now, value });
  return value;
}

module.exports = { getDaysToEarnings, CACHE_TTL_MS };
