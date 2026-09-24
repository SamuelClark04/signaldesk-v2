// Macro & FDA catalyst calendar: scheduled events that can move a setup while it
// is held. Three sources, merged:
//   1. Built-in schedule (official, published a year ahead):
//      FOMC rate decisions: federalreserve.gov/monetarypolicy/fomccalendars.htm
//        (statement 2:00 PM ET on the second meeting day)
//      CPI releases: bls.gov/schedule/news_release/cpi.htm (8:30 AM ET)
//      Checked 2026-09-24; extend the lists when the next year is published.
//   2. server/data/catalysts.json (optional, user-edited): extra events such as
//      FDA PDUFA dates, e.g.
//      [{ "date": "2026-11-12", "type": "FDA", "symbol": "PFE", "title": "PDUFA date: ..." }]
//   3. Finnhub FDA advisory committee calendar, when FINNHUB_API_KEY is set and
//      the plan allows it (a refusal is logged once and skipped, never invented).
// FOMC and CPI apply to every market (rates move stocks, options and crypto).
// An FDA date with a symbol applies to that symbol only; Finnhub's advisory
// committee meetings name no company, so they apply to the universe's
// healthcare names (HEALTHCARE) only. REST on demand, cached for hours.
const fs = require('fs');
const path = require('path');

const FOMC = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'];
const SEP = new Set(['2026-03-18', '2026-06-17', '2026-09-16', '2026-12-09', '2027-03-17', '2027-06-09', '2027-09-15', '2027-12-08']);
const CPI = [['2026-01-13', 'Dec 2025'], ['2026-02-13', 'Jan'], ['2026-03-11', 'Feb'], ['2026-04-10', 'Mar'], ['2026-05-12', 'Apr'], ['2026-06-10', 'May'],
  ['2026-07-14', 'Jun'], ['2026-08-12', 'Jul'], ['2026-09-11', 'Aug'], ['2026-10-14', 'Sep'], ['2026-11-10', 'Oct'], ['2026-12-10', 'Nov']];

const FILE = process.env.CATALYSTS_PATH || path.join(__dirname, '..', 'data', 'catalysts.json');
const REFRESH_MS = 6 * 60 * 60 * 1000;
const LOOKAHEAD_DAYS = 60;
// How far ahead an event matters, by how long the setup is expected to be held.
const HORIZON_DAYS = { 'equity-day': 1, 'crypto-swing': 7, 'equity-swing': 10, 'options-system': 21, 'portfolio-pilot': 30, 'speculative-crypto': 1 };
const DEFAULT_HORIZON = 10;
const HEALTHCARE = ['UNH', 'PFE']; // healthcare / pharma names in market/universe.js

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
let fdaEvents = [];
let fileEvents = [];
let refreshedAt = 0;
const warned = new Set();

function builtIn() {
  return [
    ...FOMC.map((d) => ({ id: `FOMC:${d}`, date: d, time: '14:00 ET', type: 'FOMC', scope: 'macro', symbol: null,
      title: `FOMC rate decision${SEP.has(d) ? ' + economic projections' : ''}`, source: 'federalreserve.gov' })),
    ...CPI.map(([d, m]) => ({ id: `CPI:${d}`, date: d, time: '08:30 ET', type: 'CPI', scope: 'macro', symbol: null,
      title: `CPI inflation report (${m} data)`, source: 'bls.gov' })),
  ];
}

function readFile() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (Array.isArray(rows) ? rows : []).filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.title).map((r) => ({
      id: `${r.type || 'EVENT'}:${r.symbol || 'ALL'}:${r.date}`, date: r.date, time: r.time || null, type: String(r.type || 'EVENT').toUpperCase(),
      scope: r.symbol ? 'symbol' : 'macro', symbol: r.symbol ? String(r.symbol).toUpperCase() : null, title: String(r.title).slice(0, 200), source: 'catalysts.json' }));
  } catch (err) {
    if (!warned.has('file')) console.warn(`[macro-events] ${FILE} unreadable (${err.message}); ignored`);
    warned.add('file');
    return [];
  }
}

async function fetchFda() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];
  const base = (process.env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/fda-advisory-committee-calendar`, { headers: { 'X-Finnhub-Token': key }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).filter((r) => r.fromDate).map((r) => ({
      id: `FDA:${r.fromDate}:${String(r.eventDescription || '').slice(0, 40)}`, date: String(r.fromDate).slice(0, 10), time: null, type: 'FDA', scope: 'sector',
      symbol: null, symbols: HEALTHCARE, title: `FDA advisory committee: ${String(r.eventDescription || 'meeting').slice(0, 160)}`, source: 'Finnhub', url: r.url || null }));
  } catch (err) {
    if (!warned.has('fda')) console.warn(`[macro-events] Finnhub FDA calendar unavailable (${err.message}); using the built-in schedule and catalysts.json`);
    warned.add('fda');
    return [];
  }
}

// Re-reads the file and Finnhub at most every REFRESH_MS (the pipeline calls it each pass).
async function refresh(now = Date.now()) {
  if (now - refreshedAt < REFRESH_MS) return false;
  refreshedAt = now;
  fileEvents = readFile();
  fdaEvents = await fetchFda();
  return true;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

// Upcoming events (today onwards, next LOOKAHEAD_DAYS), soonest first, with daysAway.
function upcoming(now = Date.now(), lookahead = LOOKAHEAD_DAYS) {
  const today = etDate.format(now);
  return [...builtIn(), ...fileEvents, ...fdaEvents]
    .map((e) => ({ ...e, daysAway: daysBetween(today, e.date) }))
    .filter((e) => e.daysAway >= 0 && e.daysAway <= lookahead)
    .sort((a, b) => a.daysAway - b.daysAway || a.date.localeCompare(b.date));
}

const appliesTo = (e, asset) => e.scope === 'macro' || e.symbol === asset || (e.symbols || []).includes(asset);

// Events inside a setup's expected hold: macro events for every market, symbol
// events (FDA) for that symbol only. [{ type, title, date, time, daysAway, source }].
function catalystsFor(candidate, now = Date.now()) {
  const horizon = HORIZON_DAYS[candidate.strategyId] || DEFAULT_HORIZON;
  const asset = String(candidate.asset || '').toUpperCase();
  return upcoming(now, horizon).filter((e) => appliesTo(e, asset))
    .map(({ type, title, date, time, daysAway, source }) => ({ type, title, date, time, daysAway, source }));
}

module.exports = { refresh, upcoming, catalystsFor, appliesTo, HORIZON_DAYS };
