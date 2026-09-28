// Edit an open long's levels (Phase 70D): TIGHTEN its stop (up only, still under the live bid)
// and / or move its T1 (above the bid). For a manual trade whose default levels were too wide
// (MORPHO: -12.8% / +31.8%), without waiting for the +1R ratchet.
//   LIVE OKX US / Kraken Pro  a new stop is cancel -> verify -> re-placed at the venue
//                             (bracket-ops.replaceStop: a refused new stop re-arms the old one);
//                             T1 is SignalDesk's to take (ratchet T1 watcher): a ledger change
//   LIVE Coinbase             stop and T1 live in one bracket: either change re-places it
//   PAPER / adopted           the ledger's levels (the exit monitor / alerts use them)
// 1R (dollarRisk, initialStop) stays the original risk, as with the ratchet.
// EDIT_LEVELS { id, stop?, t1?, requestId } -> LEVELS_RESULT to the asker; POSITIONS_UPDATED to all.
const ops = require('./bracket-ops');
const venues = require('./crypto-venues');
const { bidOf } = require('./ratchet');

const fail = ops.fail;
const GAP = 0.001; // a new stop at least 0.1% under the bid; a new T1 0.1% over it
const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

async function apply(ledger, id, { stop, t1 } = {}) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  if (!pos) throw fail('NO_POSITION', `no open position ${id}`);
  if (pos.direction === 'short' || pos.market === 'options') throw fail('EDIT_UNSUPPORTED', 'only open long stock / crypto positions can be edited here');
  const live = pos.execution === 'LIVE' && !pos.adopted;
  if (live && !venues.isLiveCrypto(pos)) throw fail('EDIT_UNSUPPORTED', `${pos.broker} levels are moved at ${pos.broker}`);
  if (pos.marketExitPending || pos.brokerManualExitId) throw fail('SELL_IN_PROGRESS', 'a sell of this position is still being settled');
  const s = num(stop);
  const t = num(t1);
  if (s === null && t === null) throw fail('NOTHING_TO_EDIT', 'send a new stop and / or T1');
  const bid = bidOf(pos);
  if (!(bid > 0)) throw fail('NO_PRICE', 'no live price to check the new levels against');
  if (s !== null) {
    if (!(Number.isFinite(s) && s > pos.invalidation)) throw fail('STOP_DOWN_REFUSED', `the stop is ${pos.invalidation}: it can only be tightened (moved up)`);
    if (!(s < bid * (1 - GAP))) throw fail('STOP_AT_BID', `the new stop ${s} must be under the bid ${bid}: close the position instead`);
  }
  if (t !== null && !(Number.isFinite(t) && t > bid * (1 + GAP) && t > (s ?? pos.invalidation))) throw fail('T1_UNDER_BID', `the new T1 ${t} must be above the bid ${bid}`);
  const targets = t === null ? pos.targets : [{ level: 1, allocation: 1, ...((pos.targets || [])[0] || {}), price: t }, ...(pos.targets || []).slice(1)];
  const newStop = s ?? pos.invalidation;
  let venue = 'ledger';
  if (live && (s !== null || (t !== null && venues.of(pos).restsTarget))) {
    ops.claim(id);
    let r;
    try { r = await ops.replaceStop(ledger, { ...pos, targets }, newStop, 'edit', { allowSame: s === null }); } finally { ops.release(id); }
    if (r.alreadyClosed) return { id, alreadyClosed: true, detail: `its stop / target already filled at ${pos.broker}; the reconciler books it` };
    venue = venues.idOf(pos);
  }
  const initialStop = pos.initialStop > 0 ? pos.initialStop : pos.invalidation;
  const history = s === null ? pos.stopHistory : [...(pos.stopHistory || []), { at: Date.now(), from: pos.invalidation, to: s, step: 'edit', venue }];
  ops.patch(ledger, id, { invalidation: newStop, targets, initialStop, ...(history ? { stopHistory: history } : {}), levelsEditedAt: Date.now() });
  console.warn(`[levels] ${id}: ${s !== null ? `stop ${pos.invalidation} -> ${s}` : ''}${s !== null && t !== null ? ', ' : ''}${t !== null ? `T1 ${(pos.targets[0] || {}).price} -> ${t}` : ''} (${venue})`);
  return { id, stop: newStop, fromStop: pos.invalidation, t1: t, venue, broker: pos.broker || null };
}

function handle(ws, msg, send, broadcast, ledger) {
  if (msg.type !== 'EDIT_LEVELS') return false;
  const id = String(msg.id || '');
  apply(ledger, id, { stop: msg.stop, t1: msg.t1 })
    .then((r) => send(ws, 'LEVELS_RESULT', { requestId: msg.requestId, ok: true, ...r }))
    .catch((err) => { console.warn(`[levels] ${id} failed: ${err.message}`); send(ws, 'LEVELS_RESULT', { requestId: msg.requestId, ok: false, id, error: err.message }); })
    .finally(() => broadcast('POSITIONS_UPDATED', ledger.getActivePositions()));
  return true;
}

module.exports = { apply, handle, GAP };
