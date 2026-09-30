// Macro News Shield calendar (Phase 81): high-impact USD releases, and the blackout around each one.
//   Source     the public weekly economic calendar feed (MACRO_CALENDAR_URL, default the Forex Factory JSON export:
//              [{ title, country, date: ISO with offset, impact }]), fetched at boot and daily at 06:00 ET with a
//              strict 5 s abort; kept in memory. Only country USD + impact High titles that name a major mover:
//              CPI, Core CPI, PCE, Core PCE, Non-Farm Payrolls, Unemployment Rate, FOMC, Fed Interest Rate Decision.
//   Fallback   the official schedule built in: FOMC decisions 2:00 PM ET and CPI 8:30 AM ET (connectors/macro-events.js,
//              federalreserve.gov / bls.gov), Employment Situation (payrolls + unemployment rate, bls.gov) and Personal
//              Income & Outlays (PCE, bea.gov) 8:30 AM ET; checked 2026-09-30. Always merged in: a failed feed never
//              hides a scheduled release (extend the lists when the agencies publish the next year).
//   Blackout   30 min BEFORE a release to 15 min AFTER it. isMacroBlackoutActive(ts) -> { active, event, releaseTime,
//              resumesAt } (epoch ms; overlapping releases merge, resumesAt = the last one's end).
//   Fail-open  a failed / slow / malformed feed is logged and ignored (the static schedule stays); any error while
//              checking returns { active: false }. A blackout is bounded (45 min): it can never pause the app for good.
const et = require('./et-time');
const { FOMC, CPI } = require('../connectors/macro-events');

const EVENTS = ['CPI', 'Core CPI', 'PCE', 'Core PCE', 'Non-Farm Payrolls', 'Unemployment Rate', 'FOMC', 'Fed Interest Rate Decision'];
const BEFORE_MS = 30 * 60 * 1000;
const AFTER_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const REFRESH_HOUR_ET = 6;
const DEFAULT_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
// Official 8:30 AM ET release days (checked 2026-09-30): BLS Employment Situation, BEA Personal Income and Outlays.
const NFP = ['2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05', '2026-07-02', '2026-08-07', '2026-09-04',
  '2026-10-02', '2026-11-06', '2026-12-04'];
const PCE = ['2026-09-30', '2026-10-29', '2026-11-25', '2026-12-23'];

let feed = []; // [{ event, title, releaseTime, source }]
let fetchedDay = null;
let lastError = null;
let fetchedAt = 0;
let timer = null;

// A feed title -> one of EVENTS, or null (not a major mover: GDP, earnings, speeches, ...).
function classify(title) {
  const t = String(title || '').trim();
  if (/^Core CPI\b/i.test(t)) return 'Core CPI';
  if (/^CPI\b/i.test(t)) return 'CPI';
  if (/^Core PCE\b/i.test(t)) return 'Core PCE';
  if (/^PCE\b/i.test(t)) return 'PCE';
  if (/^Non-?Farm (Employment Change|Payrolls)/i.test(t)) return 'Non-Farm Payrolls';
  if (/^Unemployment Rate\b/i.test(t)) return 'Unemployment Rate';
  if (/^(Federal Funds Rate|Fed Interest Rate Decision)/i.test(t)) return 'Fed Interest Rate Decision';
  if (/^FOMC (Statement|Press Conference|Meeting)/i.test(t)) return 'FOMC';
  return null;
}

// Feed rows -> events. Throws on a payload that is not a list (bad data); skips rows it cannot read.
function parseFeed(rows) {
  if (!Array.isArray(rows)) throw new Error('calendar feed is not a list');
  return rows.filter((r) => r && r.country === 'USD' && /^high$/i.test(String(r.impact || '')))
    .map((r) => ({ event: classify(r.title), title: String(r.title), releaseTime: Date.parse(r.date), source: 'feed' }))
    .filter((e) => e.event && Number.isFinite(e.releaseTime));
}

function staticSchedule() {
  const at = (list, h, m, event, title) => list.map((d) => ({ event, title, releaseTime: et.toEpoch(d, h, m), source: 'schedule' }));
  return [...at(FOMC, 14, 0, 'FOMC', 'FOMC rate decision'), ...at(CPI.map(([d]) => d), 8, 30, 'CPI', 'CPI inflation report'),
    ...at(NFP, 8, 30, 'Non-Farm Payrolls', 'Employment Situation (payrolls + unemployment rate)'), ...at(PCE, 8, 30, 'PCE', 'Personal Income & Outlays (PCE)')];
}

// Feed + schedule, one entry per release time (the feed's names win; several titles at once are joined).
function events() {
  const byTime = new Map();
  for (const e of [...feed, ...staticSchedule()]) {
    const k = Math.round(e.releaseTime / 60000);
    const hit = byTime.get(k);
    if (!hit) byTime.set(k, { ...e, names: [e.event] });
    else if (!hit.names.includes(e.event) && (e.source === 'feed' || hit.source !== 'feed')) hit.names.push(e.event);
  }
  return [...byTime.values()].map((e) => ({ ...e, event: e.names.join(' + ') })).sort((a, b) => a.releaseTime - b.releaseTime);
}

// fetchImpl / url / timeoutMs: tests (the app always uses the 5 s abort). Never throws; on any failure the previous feed is kept and the schedule still applies.
async function refresh({ now = Date.now(), fetchImpl = globalThis.fetch, url = process.env.MACRO_CALENDAR_URL || DEFAULT_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': 'SignalDesk' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feed = parseFeed(JSON.parse(await res.text()));
    fetchedDay = et.ymd(now);
    fetchedAt = now;
    lastError = null;
    console.log(`[macro] calendar: ${feed.length} high-impact USD release(s) this week from the feed`);
    return { ok: true, count: feed.length };
  } catch (err) {
    lastError = ac.signal.aborted ? `timed out after ${timeoutMs / 1000} s` : err.message;
    fetchedDay = et.ymd(now); // retried tomorrow at 06:00 ET (or on restart); the built-in schedule covers the gap
    console.warn(`[macro] calendar feed unavailable (${lastError}): using the built-in FOMC / CPI / payrolls / PCE schedule`);
    return { ok: false, error: lastError };
  } finally { clearTimeout(kill); }
}

// -> { active, event, releaseTime, resumesAt } (active false: event / times null). Fail-open.
function isMacroBlackoutActive(timestamp = Date.now()) {
  const off = { active: false, event: null, releaseTime: null, resumesAt: null };
  try {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return off;
    const hits = events().filter((e) => ts >= e.releaseTime - BEFORE_MS && ts <= e.releaseTime + AFTER_MS);
    if (!hits.length) return off;
    return { active: true, event: hits.map((e) => e.event).join(' + '), releaseTime: hits[0].releaseTime, resumesAt: Math.max(...hits.map((e) => e.releaseTime)) + AFTER_MS };
  } catch (err) {
    console.warn(`[macro] blackout check failed (${err.message}): not blocking`);
    return off;
  }
}

// Releases from now to `hours` ahead (the banner's "next" line).
function upcoming(now = Date.now(), hours = 36) {
  try { return events().filter((e) => e.releaseTime + AFTER_MS >= now && e.releaseTime <= now + hours * 3600e3).map(({ event, releaseTime, source }) => ({ event, releaseTime, source })); } catch { return []; }
}

// Boot + every 10 min: refresh once per ET day, at or after 06:00 ET.
function start() {
  if (timer) return;
  refresh().catch(() => {});
  timer = setInterval(() => {
    const now = Date.now();
    if (fetchedDay !== et.ymd(now) && et.parts(now).h >= REFRESH_HOUR_ET) refresh({ now }).catch(() => {});
  }, 10 * 60 * 1000);
  timer.unref();
}
const stop = () => { clearInterval(timer); timer = null; };
const status = () => ({ feedEvents: feed.length, fetchedAt, lastError });
const _setFeed = (rows) => { feed = rows; }; // tests

module.exports = { isMacroBlackoutActive, upcoming, refresh, start, stop, status, classify, parseFeed, events, EVENTS, BEFORE_MS, AFTER_MS, FETCH_TIMEOUT_MS, _setFeed };
