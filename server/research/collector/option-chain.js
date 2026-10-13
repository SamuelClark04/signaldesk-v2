// Phase 95 Task 1.2 / 1.3 helpers (plan 5.2): pure functions of the research collector's option grid. No I/O here.
//   expiries   the Q expiry (nearest 1-7 DTE, never 0DTE) is read from the chain; D / W are standard monthlies (third Friday, the
//              Thursday before when that Friday is an NYSE holiday): D = the nearest with >= 14 DTE, W = the next with >= 42 DTE
//   selection  per (underlying, bucket, side) the contract closest to 0.50 |delta|, nearest the money when no delta is provided
//   Q grid     the 3 nearest strikes below and above the spot, calls and puts
const cal = require('../nyse-calendar');

const DAY = 86400000;
const OCC = /^([A-Z][A-Z.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

function parseOcc(sym) {
  const m = OCC.exec(sym || ''); if (!m) return null;
  return { contract: sym, root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, side: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}
const ymdUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd, n) => ymdUtc(Date.parse(`${ymd}T12:00:00Z`) + n * DAY);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

// The standard monthly expiry of a month: the third Friday, or the Thursday before when that Friday is an exchange holiday.
function monthlyExpiry(year, month) { // month 1-12
  const first = new Date(Date.UTC(year, month - 1, 1, 12)); const toFri = (5 - first.getUTCDay() + 7) % 7;
  const fri = ymdUtc(first.getTime() + (toFri + 14) * DAY);
  return cal.NYSE_HOLIDAYS.has(fri) ? addDays(fri, -1) : fri;
}
// D = nearest monthly with >= 14 calendar DTE; W = the next monthly after D with >= 42 DTE.
function monthlyBuckets(today) {
  const [y, m] = today.split('-').map(Number); const list = [];
  for (let k = 0; k < 6; k += 1) { const mm = ((m - 1 + k) % 12) + 1; const yy = y + Math.floor((m - 1 + k) / 12); list.push(monthlyExpiry(yy, mm)); }
  const d = list.find((e) => daysBetween(today, e) >= 14);
  const w = list.find((e) => e > d && daysBetween(today, e) >= 42);
  return { D: d, W: w };
}

// One chain snapshot entry -> a flat row (null when unparseable). Quote fields may be missing (no quote yet).
function toRow(sym, snap) {
  const p = parseOcc(sym); if (!p) return null;
  const q = (snap && snap.latestQuote) || {}; const g = (snap && snap.greeks) || {};
  return { ...p, tQuote: q.t ? Date.parse(q.t) : null, bid: Number.isFinite(q.bp) ? q.bp : null, ask: Number.isFinite(q.ap) ? q.ap : null,
    bidSize: q.bs ?? null, askSize: q.as ?? null, iv: Number.isFinite(snap && snap.impliedVolatility) ? snap.impliedVolatility : null,
    delta: Number.isFinite(g.delta) ? g.delta : null };
}

// The candidate of one side: closest to 0.50 |delta| (rows with a delta), else nearest the money. Ties: the lower strike.
function pick(rows, side, spot) {
  const mine = rows.filter((r) => r.side === side); if (!mine.length) return null;
  const withDelta = mine.filter((r) => r.delta !== null && r.delta !== 0);
  const score = withDelta.length ? (r) => Math.abs(Math.abs(r.delta) - 0.5) : (r) => Math.abs(r.strike - spot);
  const pool = withDelta.length ? withDelta : mine;
  return pool.slice().sort((a, b) => score(a) - score(b) || a.strike - b.strike)[0];
}

// The Q grid: the 3 nearest distinct strikes at or below the spot and the 3 nearest above, both sides, of the given rows.
function qGrid(rows, spot) {
  const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
  const below = strikes.filter((k) => k <= spot).slice(-3); const above = strikes.filter((k) => k > spot).slice(0, 3);
  const keep = new Set([...below, ...above]);
  return rows.filter((r) => keep.has(r.strike)).map((r) => r.contract);
}

// The nearest Q expiry in the rows (1-7 DTE; never the same day).
function qExpiry(rows, today) {
  const ex = [...new Set(rows.map((r) => r.expiry))].filter((e) => { const d = daysBetween(today, e); return d >= 1 && d <= 7; }).sort();
  return ex[0] || null;
}

// Quote rows as stored on an OPTION_QUOTES line: [contract, tQuote, bid, ask, bidSize, askSize, iv, delta]
const compact = (r) => [r.contract, r.tQuote, r.bid, r.ask, r.bidSize, r.askSize, r.iv, r.delta];

module.exports = { parseOcc, monthlyExpiry, monthlyBuckets, toRow, pick, qGrid, qExpiry, compact, addDays, daysBetween, ymdUtc };
