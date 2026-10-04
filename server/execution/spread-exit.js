// Limit exits for option positions at Alpaca Paper (Phase 83): never a market order.
//   Exit (stop / 2 DTE / manual close / a held 9:35 AM exit)
//     step 0   a limit at the package's current NBBO MID (fresh leg quotes; option-spread-width.js)
//     every STEP_MS (15 s) unfilled: re-priced STEP_SHARE (25%) of the bid / ask width lower: mid -> halfway -> the natural
//              bid -> below it, MAX_STEPS (4) steps = 60 s, never under FLOOR (10% below the natural bid). Past the last step it
//              rests at its last price (a day order: it ends at the close and the exit is tried again from 9:35 AM).
//   Target  a RESTING limit at exitRule.targetValue, placed while the exit window is open (options-exit-window.js) and none is
//           working; canceled (confirmed first) before any other exit is sent. A fill books TAKE_PROFIT.
// Position fields: paperExitOrderId / paperExitReason / paperExitLeg (the working close, as before) + exitWork { kind:
// 'target' | 'exit', limit, step, stepAt, placedAt, q }. One call per position at a time (the fast loop and the reconciler).
// deps: { api (alpaca-api.paper: getOrder, cancelOrder), place(pos, limit, clientId) -> { ok, brokerId }, refresh(symbols, now),
//         fresh(symbol, maxAgeMs, now), book(ledger, pos, order, reason, leg) -> trade }
const { spreadWidth } = require('../risk/option-spread-width');

const STEP_MS = 15 * 1000;
const MAX_STEPS = 4;
const STEP_SHARE = 0.25;
const FLOOR_BELOW_BID = 0.1;
const QUOTE_MAX_AGE_MS = 30 * 1000;
const busy = new Set();
const cents = (x) => Math.round(x * 100) / 100;
const legsOf = (od) => require('../connectors/alpaca-options').legsOf(od);
const patch = (ledger, id, f) => ledger.updatePositions((p) => (p.id === id ? Object.assign(p, f) && true : false));
const cleared = { paperExitOrderId: null, paperExitReason: null, paperExitLeg: null, exitWork: null };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// The package's natural bid / ask / mid to SELL it now, from fresh leg quotes. -> { bid, ask, mid, width } | null
async function quote(pos, deps, now) {
  const legs = legsOf(pos.optionsData);
  try { await deps.refresh(legs.map((l) => l.contract), now); } catch { /* the last fresh quotes, if any */ }
  const qs = legs.map((l) => deps.fresh(l.contract, QUOTE_MAX_AGE_MS, now));
  return qs.every(Boolean) ? spreadWidth({ legs }, qs) : null;
}

// Step k's limit: mid - 25% x width x k, never under 10% below the natural bid (and never under a cent).
function stepLimit(q, step) {
  const floor = Math.max(0.01, q.bid * (1 - FLOOR_BELOW_BID));
  return cents(Math.max(floor, q.mid - STEP_SHARE * q.width * step));
}

// Cancel the working close and wait for Alpaca to confirm. -> { ok } | { trade } (it filled first) | { pending }
async function cancelWorking(ledger, pos, deps, waitMs = 3000) {
  if (!pos.paperExitOrderId) return { ok: true };
  await deps.api.cancelOrder(pos.paperExitOrderId);
  const until = Date.now() + waitMs;
  for (;;) {
    const o = await deps.api.getOrder(pos.paperExitOrderId);
    if (o.ok && o.terminal && o.filledQty > 0) return { trade: deps.book(ledger, pos, o, pos.paperExitReason || 'TAKE_PROFIT', pos.paperExitLeg || 'take_profit') };
    if (o.ok && o.terminal) { patch(ledger, pos.id, cleared); return { ok: true }; }
    if (Date.now() >= until) return { pending: true, brokerExitId: pos.paperExitOrderId };
    await sleep(300);
  }
}

// A resting take-profit at the plan's target value. -> { placed } | { error } | null (nothing to do)
async function placeTarget(ledger, pos, deps, now = Date.now()) {
  const t = pos.optionsData && pos.optionsData.exitRule && pos.optionsData.exitRule.targetValue;
  if (!(t > 0) || pos.paperExitOrderId) return null;
  const limit = cents(t);
  const r = await deps.place(pos, limit, `${pos.id}:tp:${now}`);
  if (!r.ok) return { error: r.error };
  patch(ledger, pos.id, { paperExitOrderId: r.brokerId, paperExitReason: 'TAKE_PROFIT', paperExitLeg: 'take_profit', exitWork: { kind: 'target', limit, placedAt: now } });
  return { placed: true, brokerExitId: r.brokerId, limit };
}

// Start a stepped limit exit (a working target is canceled first). -> { pending, brokerExitId, limit } | { trade } | { error }
async function startExit(ledger, pos, reason, leg, deps, now = Date.now()) {
  const c = await cancelWorking(ledger, pos, deps);
  if (c.trade || c.pending) return c;
  const q = await quote(pos, deps, now);
  const model = () => { const m = require('./option-marks').saleValue(pos, require('../market/latest-prices').getLatestPrice(pos.asset)); return m ? cents(Math.max(0.01, m.value)) : null; };
  const limit = q ? stepLimit(q, 0) : model();
  if (!(limit > 0)) return { error: 'no fresh option quote and no model value to price the exit' };
  const r = await deps.place(pos, limit, `${pos.id}:x0:${now}`);
  if (!r.ok) return { error: r.error };
  patch(ledger, pos.id, { paperExitOrderId: r.brokerId, paperExitReason: reason, paperExitLeg: leg, exitWork: { kind: 'exit', reason, limit, step: 0, stepAt: now, placedAt: now, q } });
  console.log(`[paper] ${pos.id}: ${reason} as a limit at ${limit}${q ? ` (mid ${cents(q.mid)}, natural bid ${cents(q.bid)})` : ' (model value: no fresh quote)'}; re-priced every ${STEP_MS / 1000} s`);
  return { pending: true, brokerExitId: r.brokerId, limit };
}

// The working close of `pos`: book a fill, clear an order that ended unfilled, or take the next price step.
// -> { trade } | { cleared } | { stepped, limit } | { waiting } | null
async function manage(ledger, pos, deps, now = Date.now()) {
  if (!pos.paperExitOrderId || busy.has(pos.id)) return null;
  busy.add(pos.id);
  try {
    const o = await deps.api.getOrder(pos.paperExitOrderId);
    if (!o.ok) return { waiting: true, detail: o.error };
    if (o.terminal && o.filledQty > 0) return { trade: deps.book(ledger, pos, o, pos.paperExitReason || `MANUAL_CLOSE @ Alpaca Paper`, pos.paperExitLeg || 'manual') };
    if (o.terminal) { patch(ledger, pos.id, cleared); return { cleared: true }; } // expired / canceled unfilled: tried again
    const w = pos.exitWork;
    if (!w || w.kind !== 'exit' || w.step >= MAX_STEPS || now - w.stepAt < STEP_MS) return { waiting: true };
    const q = (await quote(pos, deps, now)) || w.q;
    const limit = q ? stepLimit(q, w.step + 1) : w.limit;
    if (!(limit < w.limit - 0.005)) { patch(ledger, pos.id, { exitWork: { ...w, step: w.step + 1, stepAt: now } }); return { waiting: true, floor: true }; } // at the floor: rests
    const c = await cancelWorking(ledger, pos, deps);
    if (c.trade) return c;
    if (c.pending) return { waiting: true };
    const r = await deps.place(pos, limit, `${pos.id}:x${w.step + 1}:${now}`);
    if (!r.ok) { console.error(`[paper] ${pos.id}: re-priced exit refused (${r.error}); tried again next pass`); return { waiting: true, error: r.error }; }
    patch(ledger, pos.id, { paperExitOrderId: r.brokerId, paperExitReason: w.reason, paperExitLeg: pos.paperExitLeg, exitWork: { ...w, limit, step: w.step + 1, stepAt: now, q } });
    return { stepped: true, limit, step: w.step + 1 };
  } finally { busy.delete(pos.id); }
}

// Phase 89 URGENT re-price (an Options Quick Flip past its same-day deadline whose close has not filled): cancel the working close
// and re-place it `discount` under the best reference price we have: the natural bid from fresh quotes, else the LAST known
// quotes (any age), else the model value. A sell limit under the bid is marketable (Alpaca fills it at the bid), so this exits at
// the market while staying bounded: never a market order, never under a cent. -> { placed, limit } | { trade } | { waiting } | { error }
async function urgent(ledger, pos, deps, discount, now = Date.now()) {
  if (busy.has(pos.id)) return { waiting: true }; // manage() is stepping this close right now (one call per position at a time)
  busy.add(pos.id);
  try { return await urgentNow(ledger, pos, deps, discount, now); } finally { busy.delete(pos.id); }
}
async function urgentNow(ledger, pos, deps, discount, now) {
  const w = pos.exitWork || {};
  if (now - (w.urgentAt || w.placedAt || 0) < URGENT_EVERY_MS) return { waiting: true };
  const legs = legsOf(pos.optionsData);
  const q = (await quote(pos, deps, now)) || (() => { const qs = legs.map((l) => deps.fresh(l.contract, 24 * 3600e3, now)); return qs.every(Boolean) ? spreadWidth({ legs }, qs) : null; })();
  let ref = q ? q.bid : null;
  if (!(ref > 0)) { const m = require('./option-marks').saleValue(pos, require('../market/latest-prices').getLatestPrice(pos.asset)); ref = m ? m.value : null; }
  if (!(ref > 0)) return { error: 'no quote (fresh or last known) and no model value to price the deadline exit' };
  const limit = cents(Math.max(0.01, ref * (1 - discount)));
  if (pos.paperExitOrderId && w.kind === 'exit' && !(limit < w.limit - 0.005)) { patch(ledger, pos.id, { exitWork: { ...w, urgentAt: now } }); return { waiting: true }; }
  const c = await cancelWorking(ledger, pos, deps);
  if (c.trade) return c;
  if (c.pending) return { waiting: true };
  const reason = pos.paperExitReason || w.reason || 'QF_DEADLINE';
  const r = await deps.place(pos, limit, `${pos.id}:u${Math.round(discount * 100)}:${now}`);
  if (!r.ok) return { error: r.error };
  patch(ledger, pos.id, { paperExitOrderId: r.brokerId, paperExitReason: reason, paperExitLeg: pos.paperExitLeg || 'qf_deadline',
    exitWork: { kind: 'exit', reason, limit, step: MAX_STEPS, stepAt: now, placedAt: w.placedAt || now, urgentAt: now, urgent: discount, q } });
  console.warn(`[paper] ${pos.id}: deadline exit re-priced to ${limit} (${Math.round(discount * 100)}% under ${q ? 'the bid' : 'the model value'} ${cents(ref)})`);
  return { placed: true, limit };
}
const URGENT_EVERY_MS = 20 * 1000;

module.exports = { quote, stepLimit, placeTarget, startExit, manage, cancelWorking, urgent, STEP_MS, MAX_STEPS, STEP_SHARE, FLOOR_BELOW_BID, URGENT_EVERY_MS };
