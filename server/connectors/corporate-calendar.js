// Corporate calendar: the next earnings date for a stock (REST, on demand),
// from Finnhub's earnings calendar (GET /api/v1/calendar/earnings). The key
// (FINNHUB_API_KEY) travels in the X-Finnhub-Token header, never in a URL.
// Only called when the swing strategy has a setup to shield, and cached for
// 24 hours per ticker (failures for 15 minutes), so the free tier (60 calls/min)
// is never at risk.
//
// getEarningsStatus(ticker) never throws:
//   { ok: true, date: 'YYYY-MM-DD' | null, hour, tradingDaysAway | null }
//     date null = no earnings reported in the next LOOKAHEAD_DAYS (safe)
//   { ok: false, error }  = unknown (missing key, HTTP error, timeout, bad data).
//     Callers must FAIL CLOSED on this: unknown is never treated as safe.
// Trading days are weekdays after today up to the report date (holidays are not
// skipped, which only makes the shield stricter); a report today is 0 days away.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 15 * 60 * 1000;
const LOOKAHEAD_DAYS = 60;
const TIMEOUT_MS = 8000;

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
const baseUrl = () => (process.env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1').replace(/\/+$/, '');
const cache = new Map(); // ticker -> { at, result: { ok, date, hour } | { ok: false, error } }
let warnedNoKey = false;

async function fetchNextEarnings(ticker, now) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    if (!warnedNoKey) console.warn('[earnings] FINNHUB_API_KEY is not set: the Earnings Shield fails closed and blocks every swing setup');
    warnedNoKey = true;
    return { ok: false, error: 'FINNHUB_API_KEY not set in .env' };
  }
  const from = etDate.format(now);
  const to = etDate.format(now + LOOKAHEAD_DAYS * 86400000);
  let res;
  try {
    res = await fetch(`${baseUrl()}/calendar/earnings?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}`,
      { headers: { 'X-Finnhub-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? `Finnhub timed out after ${TIMEOUT_MS / 1000}s` : `Finnhub unreachable: ${err.message}` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) return { ok: false, error: `Finnhub HTTP ${res.status}: ${(json && json.error) || res.statusText}` };
  if (!json || !Array.isArray(json.earningsCalendar)) return { ok: false, error: 'Finnhub: unexpected earnings calendar response' };
  const next = json.earningsCalendar
    .filter((e) => e && e.symbol === ticker && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  return { ok: true, date: next ? next.date : null, hour: next ? next.hour || '' : null };
}

// Weekdays strictly after `fromDate` up to and including `toDate` (both YYYY-MM-DD).
function tradingDaysBetween(fromDate, toDate) {
  if (toDate <= fromDate) return 0;
  let n = 0;
  const d = new Date(`${fromDate}T12:00:00Z`);
  const end = new Date(`${toDate}T12:00:00Z`);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n += 1;
  }
  return n;
}

async function getEarningsStatus(ticker, now = Date.now()) {
  let hit = cache.get(ticker);
  if (!hit || now - hit.at >= (hit.result.ok ? CACHE_TTL_MS : FAIL_TTL_MS)) {
    const result = await fetchNextEarnings(ticker, now).catch((err) => ({ ok: false, error: err.message }));
    hit = { at: now, result };
    cache.set(ticker, hit);
  }
  const r = hit.result;
  if (!r.ok) return { ...r };
  // Days are recomputed on every read, so a cached date stays correct as days pass.
  return { ...r, tradingDaysAway: r.date ? tradingDaysBetween(etDate.format(now), r.date) : null };
}

module.exports = { getEarningsStatus, tradingDaysBetween, CACHE_TTL_MS, LOOKAHEAD_DAYS };
