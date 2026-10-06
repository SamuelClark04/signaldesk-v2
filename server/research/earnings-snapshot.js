// Earnings calendar snapshots (Phase 94 Stage 1, RECORD-ONLY): once per New York day at / after 07:00 ET, ONE Finnhub call for the next
// 30 days (all US); the capture-universe rows are recorded with their estimates, so later research has a POINT-IN-TIME consensus
// (spec 4 / 6). Key in the X-Finnhub-Token header only; through net-guard; never inside a pipeline pass.
// One query PER capture symbol (24 a day, sequential): an all-US calendar answer is capped (1,500 rows seen 2026-10-06) and could
// silently miss pilot symbols. A symbol that fails makes the snapshot complete: false (named in errors); every 10 min only the failed
// symbols are retried, the day's good rows kept, and a snapshot is recorded again only when it completes or the error set changes.
// C4: a failure (no key, HTTP error, timeout) is RECORDED as POLL_STATUS { source: 'finnhub-earnings', ok: false } so the pilot health
// check sees an unhealthy source; it is retried every 10 min until one snapshot of the day succeeds.
const rec = require('./event-recorder');
const universe = require('./capture-universe');

const HOUR_ET = 7;
const DAYS_AHEAD = 30;
const TIMEOUT_MS = 8000;
let timer = null; let takenDay = null; let failedDay = null;
let partial = null; // { day, rows: Map(symbol -> rows), failed: [symbols], errorsKey } of the day so far (review: retries only the failed symbols)
const st = { lastOkAt: null, lastError: null };
const base = () => (process.env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1').replace(/\/+$/, '');
const ymd = (ms) => require('../services/et-time').ymd(ms);

function failed(day, error) {
  st.lastError = error;
  if (failedDay !== `${day}|${error}`) { failedDay = `${day}|${error}`; rec.record('POLL_STATUS', { source: 'finnhub-earnings', ok: false, error }); } // once per day + error
  return { ok: false, error };
}

async function take({ now = Date.now() } = {}) {
  const from = ymd(now); const to = ymd(now + DAYS_AHEAD * 86400000);
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return failed(from, 'FINNHUB_API_KEY not set');
  if (!partial || partial.day !== from) partial = { day: from, rows: new Map(), failed: universe.symbols().slice(), errorsKey: null };
  const errors = []; const syms = universe.symbols();
  for (const symbol of partial.failed) {
    try {
      const res = await require('../connectors/net-guard').guardedFetch(`${base()}/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`,
        { headers: { 'X-Finnhub-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const fetchedAt = Date.now(); // review: a completed snapshot may join rows fetched at different times: each keeps its own
      partial.rows.set(symbol, (Array.isArray(body.earningsCalendar) ? body.earningsCalendar : []).filter((e) => e && e.symbol === symbol).map((e) => ({ symbol, fetchedAt, date: e.date, hour: e.hour || null,
        epsEstimate: e.epsEstimate ?? null, revenueEstimate: e.revenueEstimate ?? null, epsActual: e.epsActual ?? null, revenueActual: e.revenueActual ?? null, quarter: e.quarter ?? null, year: e.year ?? null })));
    } catch (err) { errors.push({ symbol, error: String(err.message || err).slice(0, 120) }); }
  }
  partial.failed = errors.map((e) => e.symbol);
  if (errors.length === syms.length) return failed(from, `every symbol failed (${errors[0].error})`);
  const complete = errors.length === 0; const rows = [...partial.rows.values()].flat();
  const errorsKey = errors.map((e) => `${e.symbol}:${e.error}`).sort().join('|');
  if (!complete && errorsKey === partial.errorsKey) return { ok: false, error: `${errors.length} symbol(s) still failing (unchanged: not recorded again)`, rows: rows.length };
  const ok = rec.record('EARNINGS_SNAPSHOT', { source: 'finnhub', from, to, rows, queried: syms.length, complete, errors, t_recv: Date.now(), symbols: universe.VERSION });
  if (!ok) return { ok: false, error: 'recorder refused the snapshot' }; // retried at the next tick
  partial.errorsKey = errorsKey;
  if (!complete) return { ok: false, error: `${errors.length} symbol(s) failed`, rows: rows.length }; // recorded as incomplete; the day is retried
  st.lastOkAt = now; st.lastError = null; takenDay = from;
  return { ok: true, rows: rows.length };
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    try { if (takenDay !== ymd(now) && require('../services/et-time').parts(now).h >= HOUR_ET) take({ now }).catch(() => {}); } catch { /* record-only */ }
  }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { take, start, stop, status: () => ({ ...st, takenDay }), _test: { reset: () => { takenDay = null; failedDay = null; partial = null; st.lastOkAt = null; st.lastError = null; } } };
