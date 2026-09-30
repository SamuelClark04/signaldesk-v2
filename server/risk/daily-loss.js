// Daily loss kill switch (Phase 81). Today's P&L across the whole book (paper + live, every strategy): realized
// (journal closes since midnight ET) + unrealized for TODAY (a position opened today: all of its net P/L; one opened
// earlier: its move since the first mark of the day, scaled if part of it was sold since). When it reaches
// -settings.dailyLossLimit ($; 0 = off) the switch TRIPS and stays tripped until the next New York day: new setups are
// not staged or approved (entry-shields.js). Open trades, their stops / targets and every close keep working.
// Once tripped it stays tripped for the day even if prices recover; only raising the limit past the loss (or 0 = off)
// in Settings releases it. In memory: a restart re-measures (today's realized losses alone re-trip it).
const et = require('../services/et-time');

const DEFAULT_LIMIT = 150;
let day = null;
let baseline = new Map(); // position id -> { v: net P/L at the day's first mark, size }
let tripped = null; // { at, pnl }
let last = null;

// Net P/L if the position were sold now (exit-quote: the same numbers the position shows), null: no price / working.
function markNet(p, now) {
  if (p.fillEstimated || !(p.positionSize > 0)) return null;
  const prices = require('../market/latest-prices');
  const px = prices.getLatestPrice(p.asset) || prices.getMarkPrice(p.asset);
  if (!(px > 0)) return null;
  const q = require('../execution/exit-quote').quote(p, px, 'stop', now);
  return q && Number.isFinite(q.net) ? q.net : null;
}

// -> { realized, unrealized, pnl, dayStart }. markOf: tests.
function measure({ journal = [], positions = [], now = Date.now(), markOf = markNet } = {}) {
  const start = et.dayStart(now);
  const d = et.ymd(now);
  if (d !== day) { day = d; baseline = new Map(); tripped = null; }
  const realized = journal.filter((t) => t.closedAt >= start && Number.isFinite(t.netPnl)).reduce((s, t) => s + t.netPnl, 0);
  let unrealized = 0;
  for (const p of positions) {
    const v = markOf(p, now);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    let base = 0;
    if (!((p.openedAt || 0) >= start)) {
      if (!baseline.has(p.id)) baseline.set(p.id, { v, size: p.positionSize });
      const b = baseline.get(p.id);
      base = b.size > 0 ? (b.v * p.positionSize) / b.size : b.v;
    }
    unrealized += v - base;
  }
  return { realized, unrealized, pnl: realized + unrealized, dayStart: start };
}

const limitOf = (settings = {}) => (Number.isFinite(settings.dailyLossLimit) && settings.dailyLossLimit >= 0 ? settings.dailyLossLimit : DEFAULT_LIMIT);

// Measure + trip. -> { enabled, active, pnl, realized, unrealized, limit, trippedAt, day }
function refresh({ settings, ...rest } = {}) {
  const m = measure(rest);
  const limit = limitOf(settings);
  const now = rest.now || Date.now();
  if (tripped && tripped.pnl > -limit) tripped = null; // the user raised the limit past the loss (Settings): released
  if (limit > 0 && !tripped && m.pnl <= -limit) {
    tripped = { at: now, pnl: m.pnl };
    console.warn(`[risk] DAILY KILL SWITCH: today's P/L $${m.pnl.toFixed(2)} reached the -$${limit} limit; no new entries until tomorrow (open trades, stops and closes keep working)`);
  }
  last = { enabled: limit > 0, active: limit > 0 && !!tripped, pnl: m.pnl, realized: m.realized, unrealized: m.unrealized, limit, trippedAt: tripped ? tripped.at : null, trippedPnl: tripped ? tripped.pnl : null, day };
  return last;
}

const current = () => last;
const reset = () => { day = null; baseline = new Map(); tripped = null; last = null; }; // tests

module.exports = { refresh, current, measure, markNet, reset, DEFAULT_LIMIT };
