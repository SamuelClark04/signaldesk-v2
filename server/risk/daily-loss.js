// Daily loss kill switches (Phase 81; Phase 83: one PER BOOK). Two independent switches, never mixed:
//   paper  paper trades only (settings.dailyLossLimitPaper, $; default 150) -> pauses PAPER entries only
//   live   real-money trades only (settings.dailyLossLimitLive, $; default 25) -> pauses LIVE entries only
// A bad paper day can never lock out live crypto, and the reverse. Each book's P&L today (New York day): realized
// (journal closes since midnight ET) + unrealized for TODAY (a position opened today: all of its net P/L; one opened
// earlier: its move since the first mark of the day, scaled if part of it was sold since). At -limit the book TRIPS and
// stays tripped until the next New York day; only raising that limit past the loss (or 0 = off) in Settings releases it.
// Open trades, stops, targets and every close keep working. In memory: a restart re-measures (realized alone re-trips).
const et = require('../services/et-time');

const DEFAULTS = { paper: 150, live: 25 };
const KEYS = { paper: 'dailyLossLimitPaper', live: 'dailyLossLimitLive' };
const BOOKS = ['paper', 'live'];
const liveRecord = (x) => x.execution === 'LIVE' || x.execution === 'EXTERNAL' || x.execution === 'BROKER'; // adopted exchange holdings are real money
const bookOf = (x) => (liveRecord(x) ? 'live' : 'paper');
let day = null;
let state = null; // book -> { baseline: Map(id -> { v, size }), tripped: { at, pnl } | null }
let last = null;
const fresh = () => Object.fromEntries(BOOKS.map((b) => [b, { baseline: new Map(), tripped: null }]));

// Net P/L if the position were sold now (exit-quote: the same numbers the position shows), null: no price / working.
function markNet(p, now) {
  if (p.fillEstimated || !(p.positionSize > 0)) return null;
  const prices = require('../market/latest-prices');
  const px = prices.getLatestPrice(p.asset) || prices.getMarkPrice(p.asset);
  if (!(px > 0)) return null;
  const q = require('../execution/exit-quote').quote(p, px, 'stop', now);
  return q && Number.isFinite(q.net) ? q.net : null;
}

// One book's P&L today. -> { realized, unrealized, pnl, dayStart }. markOf: tests.
function measure({ journal = [], positions = [], now = Date.now(), markOf = markNet, book = 'paper' } = {}) {
  const start = et.dayStart(now);
  const d = et.ymd(now);
  if (d !== day || !state) { day = d; state = fresh(); }
  const s = state[book];
  const realized = journal.filter((t) => bookOf(t) === book && t.closedAt >= start && Number.isFinite(t.netPnl)).reduce((sum, t) => sum + t.netPnl, 0);
  let unrealized = 0;
  for (const p of positions.filter((x) => bookOf(x) === book)) {
    const v = markOf(p, now);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    let base = 0;
    if (!((p.openedAt || 0) >= start)) {
      if (!s.baseline.has(p.id)) s.baseline.set(p.id, { v, size: p.positionSize });
      const b = s.baseline.get(p.id);
      base = b.size > 0 ? (b.v * p.positionSize) / b.size : b.v;
    }
    unrealized += v - base;
  }
  return { realized, unrealized, pnl: realized + unrealized, dayStart: start };
}

const limitOf = (settings = {}, book) => { const v = settings[KEYS[book]]; return Number.isFinite(v) && v >= 0 ? v : DEFAULTS[book]; };

// Measure + trip both books. -> { paper: {...}, live: {...} }, each { book, enabled, active, pnl, realized, unrealized, limit, trippedAt, trippedPnl, day }
function refresh({ settings, ...rest } = {}) {
  const now = rest.now || Date.now();
  const out = {};
  for (const book of BOOKS) {
    const m = measure({ ...rest, book });
    const s = state[book];
    const limit = limitOf(settings, book);
    if (s.tripped && s.tripped.pnl > -limit) s.tripped = null; // the user raised this book's limit past the loss: released
    if (limit > 0 && !s.tripped && m.pnl <= -limit) {
      s.tripped = { at: now, pnl: m.pnl };
      console.warn(`[risk] DAILY KILL SWITCH (${book}): today's ${book} P/L $${m.pnl.toFixed(2)} reached the -$${limit} limit; no new ${book} entries until tomorrow (open trades, stops and closes keep working)`);
    }
    out[book] = { book, enabled: limit > 0, active: limit > 0 && !!s.tripped, pnl: m.pnl, realized: m.realized, unrealized: m.unrealized, limit,
      trippedAt: s.tripped ? s.tripped.at : null, trippedPnl: s.tripped ? s.tripped.pnl : null, day };
  }
  last = out;
  return out;
}

const current = () => last;
const reset = () => { day = null; state = null; last = null; }; // tests

module.exports = { refresh, current, measure, markNet, reset, bookOf, DEFAULTS, KEYS };
