// Profit ratchet (Phase 68): a winning long's stop moves UP, never down, in two 1-click steps
// (1R = entry - the ORIGINAL stop; triggers are measured at the live bid):
//   A  bid reached entry + 1.0R  ->  "Lock Break-Even (+0.05R)": stop to the fee break-even
//                                     price + 0.05R (a stop-out nets ~+0.05R, not -1R)
//   B  bid reached entry + 1.5R  ->  "Lock Profit (+0.5R)": stop to entry + 0.5R (at least A's
//                                     stop + 0.1R: with fees over ~0.45R, A would sit above it)
// A step stays offered once its trigger was touched (ratchetReached, kept on the position), so
// it can still be taken on the pullback it protects against, while the new stop is below the
// bid. LIVE Coinbase positions move their bracket (bracket-ops.replaceStop: cancel -> verify ->
// new bracket; refused -> the old stop re-armed; both refused -> UNARMORED). PAPER and adopted
// positions move the ledger's stop (exit-monitor / alerts use it), so paper statistics carry the
// same protection. dollarRisk (1R) is never changed: R-multiples stay on the original risk.
// watch() (every POSITION_MARKS tick, 5 s): records triggers touched, and flags STOP_GAP_UNFILLED
// on a LIVE Coinbase bracket whose bid is > 5% under its stop (Coinbase's stop-limit sells
// at most 5% under the trigger, so past that the exit can rest unfilled).
// RATCHET_STOP { id, step, requestId } -> RATCHET_RESULT to the asker; POSITIONS_UPDATED to all.
const be = require('../risk/break-even');
const prices = require('../market/latest-prices');
const ops = require('./bracket-ops');

const STEPS = { A: { atR: 1.0, label: 'Lock Break-Even (+0.05R)' }, B: { atR: 1.5, label: 'Lock Profit (+0.5R)' } };
const BE_BUFFER_R = 0.05;
const LOCK_R = 0.5;
const B_OVER_A_R = 0.1; // B always locks more than A (fees > ~0.45R would put A's break-even lock above entry + 0.5R)
const GAP = 0.95;
const round = (x) => +x.toPrecision(8);
const fail = ops.fail;

// { r, entry, initialStop, A: { trigger, stop }, B: { ... }, step, reached } or null (shorts, options).
function plan(p, q = p && p.exitQuote) {
  if (!p || p.direction === 'short' || p.market === 'options') return null;
  const entry = p.fillPrice;
  const initialStop = p.initialStop > 0 ? p.initialStop : p.invalidation;
  const r = entry - initialStop;
  if (!(entry > 0 && r > 0)) return null;
  const rate = be.exactRate(require('../risk/cost-authority').feeKey(p), 'taker'); // the venue's own (69A)
  const bePx = q && q.breakEven > 0 ? q.breakEven
    : be.breakEvenPrice({ fillPrice: entry, size: p.positionSize, entryFee: Number.isFinite(p.entryFeeActual) ? p.entryFeeActual : entry * p.positionSize * rate, exitRate: rate }) || entry;
  const aStop = round(bePx + BE_BUFFER_R * r);
  return { r, entry, initialStop, step: p.ratchetStep || null, reached: p.ratchetReached || {},
    A: { trigger: round(entry + STEPS.A.atR * r), stop: aStop, label: STEPS.A.label },
    B: { trigger: round(entry + STEPS.B.atR * r), stop: round(Math.max(entry + LOCK_R * r, aStop + B_OVER_A_R * r)), label: STEPS.B.label } };
}

// The live bid a long would sell at (the exit quote's), else the last price.
const bidOf = (p) => { const q = p.exitQuote; return q && q.sellPrice > 0 ? q.sellPrice : prices.getLatestPrice(p.asset); };

// The step to offer now ('B' over 'A'), or null: touched (or at it now), above the current
// stop, and still under the bid.
function offer(p, bid = bidOf(p), pl = plan(p)) {
  if (!pl || !(bid > 0)) return null;
  for (const k of ['B', 'A']) {
    const s = pl[k];
    if ((pl.reached[k] || bid >= s.trigger) && s.stop > p.invalidation * (1 + 1e-9) && s.stop < bid) return k;
  }
  return null;
}

const venues = require('./crypto-venues');
const bracketed = (p) => p.execution === 'LIVE' && !p.adopted && venues.isLiveCrypto(p);
// Phase 69A / 69B: Kraken and OKX hold only the stop; SignalDesk sells at T1 itself (closeLive
// with reason TAKE_PROFIT), at most one attempt per position per T1_RETRY_MS.
const T1_RETRY_MS = 60 * 1000;
const t1Tries = new Map(); // position id -> last attempt (ms)
function takeT1(ledger, p, bid, now) {
  const t1 = p.targets && p.targets[0] && p.targets[0].price;
  // 70E: an OKX OCO (p.brokerOco) sells at T1 itself: never a second, local T1 sell.
  if (venues.of(p).restsTarget || p.brokerOco || p.adopted || (p.brokerEntryType === 'limit' && p.fillEstimated) || !(t1 > 0) || !(bid >= t1) || p.marketExitPending || p.brokerManualExitId || ops.isBusy(p.id)) return;
  if (now - (t1Tries.get(p.id) || 0) < T1_RETRY_MS) return;
  t1Tries.set(p.id, now);
  console.warn(`[ratchet] ${p.id}: T1 ${t1} reached at ${bid} on ${p.broker}: market sell (take profit)`);
  require('./coinbase-exit').closeLive(ledger, p.id, { reason: 'TAKE_PROFIT', leg: 'take_profit' })
    .then((r) => console.warn(`[ratchet] ${p.id}: T1 sell ${r.pending ? 'working' : r.alreadyClosed ? 'not needed (already closed)' : 'booked'}`))
    .catch((err) => console.error(`[ratchet] ${p.id}: T1 sell at ${p.broker} FAILED: ${err.message}`));
}

// Every MARK tick: triggers touched, stop gaps. true when something was saved (broadcast then).
function watch(ledger, positions = ledger.getActivePositions(), now = Date.now()) {
  let changed = false;
  for (const p of positions) {
    const pl = plan(p);
    const bid = bidOf(p);
    if (!pl || !(bid > 0)) continue;
    const touched = ['A', 'B'].filter((k) => !pl.reached[k] && bid >= pl[k].trigger);
    if (touched.length) {
      ops.patch(ledger, p.id, { ratchetReached: { ...pl.reached, ...Object.fromEntries(touched.map((k) => [k, now])) } });
      console.log(`[ratchet] ${p.id}: +${STEPS[touched[touched.length - 1]].atR}R reached at ${bid}: ${touched.map((k) => `[${STEPS[k].label}]`).join(' ')} available`);
      changed = true;
    }
    if (!bracketed(p)) continue;
    takeT1(ledger, p, bid, now);
    if (p.broker !== 'Coinbase') continue; // a Kraken / OKX stop sells at market: no stop-limit gap
    const gap = bid < GAP * p.invalidation;
    if (gap !== !!p.stopGap) {
      const detail = `STOP_GAP_UNFILLED: Live price fell > 5% below stop threshold without fill; check Coinbase order book (bid ${bid}, stop ${p.invalidation})`;
      ops.patch(ledger, p.id, { stopGap: gap ? { at: now, bid, stop: p.invalidation, detail } : null });
      if (gap) console.error(`[ratchet] CRITICAL ${p.id}: ${detail}`);
      changed = true;
    }
  }
  return changed;
}

async function apply(ledger, id, step) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  if (!pos) throw fail('NO_POSITION', `no open position ${id}`);
  const pl = plan(pos);
  if (!pl) throw fail('RATCHET_UNSUPPORTED', 'only open long stock / crypto positions ratchet');
  const s = pl[step];
  if (!s) throw fail('RATCHET_UNSUPPORTED', `unknown step "${step}"`);
  if (pos.execution === 'LIVE' && !pos.adopted && !bracketed(pos)) throw fail('RATCHET_UNSUPPORTED', `${pos.broker} stops are moved at ${pos.broker}`);
  const bid = bidOf(pos);
  if (!(pl.reached[step] || bid >= s.trigger)) throw fail('RATCHET_NOT_REACHED', `the bid ${bid} has not reached +${STEPS[step].atR}R (${s.trigger})`);
  if (!(s.stop > pos.invalidation)) throw fail('RATCHET_DOWN_REFUSED', `the stop is already ${pos.invalidation}, at or above ${s.stop}: a stop only moves up`);
  if (!(bid > s.stop)) throw fail('PRICE_BELOW_LOCK', `the bid ${bid} is already at or under the lock level ${s.stop}: close the position instead`);
  let venue = 'ledger';
  if (bracketed(pos)) {
    ops.claim(id);
    let r;
    try { r = await ops.replaceStop(ledger, pos, s.stop, `ratchet${step}`); } finally { ops.release(id); }
    if (r.alreadyClosed) return { id, alreadyClosed: true, detail: 'its stop/target already filled at Coinbase; the reconciler books it' };
    venue = venues.idOf(pos); // 'coinbase' | 'kraken' | 'okx' (69A / 69B)
  }
  const history = [...(pos.stopHistory || []), { at: Date.now(), from: pos.invalidation, to: s.stop, step, venue }];
  ops.patch(ledger, id, { invalidation: s.stop, initialStop: pl.initialStop, ratchetStep: step, stopHistory: history });
  console.warn(`[ratchet] ${id}: ${STEPS[step].label}: stop ${pos.invalidation} -> ${s.stop} (${venue})`);
  return { id, step, label: STEPS[step].label, from: pos.invalidation, stop: s.stop, venue, broker: pos.broker || null };
}

// RATCHET_STOP from a client: answer the asker, refresh everyone. true when handled.
function handle(ws, msg, send, broadcast, ledger) {
  if (msg.type !== 'RATCHET_STOP') return false;
  const id = String(msg.id || '');
  apply(ledger, id, String(msg.step || ''))
    .then((r) => send(ws, 'RATCHET_RESULT', { requestId: msg.requestId, ok: true, ...r }))
    .catch((err) => { console.warn(`[ratchet] ${id} failed: ${err.message}`); send(ws, 'RATCHET_RESULT', { requestId: msg.requestId, ok: false, id, step: msg.step, error: err.message }); })
    .finally(() => broadcast('POSITIONS_UPDATED', ledger.getActivePositions()));
  return true;
}

module.exports = { plan, offer, watch, apply, handle, bidOf, STEPS, BE_BUFFER_R, LOCK_R, GAP };
