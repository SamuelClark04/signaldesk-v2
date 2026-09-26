// Broker reconciliation: brings LIVE positions in line with what the broker
// actually did. The broker is the source of truth for live trades; this module
// never guesses, and a failed status call changes nothing.
//
// Per LIVE position (brokerId = the ENTRY order; exits are its bracket/attached order):
//   1. Entry never filled (canceled/rejected/expired/failed, 0 filled) -> void it
//   2. Entry filled                -> sync the real average fill price + filled qty
//   3. Exit order FULLY filled     -> close at the exit's real average fill (BROKER_EXIT)
//      Exit ENDED part-filled (canceled / expired after a partial fill, Phase 67 P0-4)
//                                  -> book the filled part now (split off, BROKER_EXIT); the
//                                     rest stays open, UNARMORED. An ended exit leaving less
//                                     than DUST_USD unsold closes the whole record. A
//                                     part-filled exit still working waits for the rest.
//   4. A post-only LIMIT entry (brokerEntryType 'limit') still unfilled after
//      ENTRY_TTL_MS -> cancel it at the broker; the next pass voids it
//   5. Bracket check (Phase 67 P0-1): a filled entry whose stop / target order is missing,
//      canceled, expired or failed at the broker is flagged bracketStatus 'UNARMORED'
//      (position card warning + a CRITICAL log line); a working one is 'ARMED'
//   6. Anything else (working, broker unreachable) -> wait
// Coinbase manual sells ([Close at Coinbase]) still working, or whose outcome was unknown,
// are settled by coinbase-exit.js (settle / resolvePending).
const alpacaApi = require('../connectors/alpaca-api');
const be = require('../risk/break-even'); // Phase 63: expected vs actual exit (cashoutAudit)
const coinbaseApi = require('../connectors/coinbase-api');
const { entryShare } = require('./ledger-live');

const APIS = { Alpaca: alpacaApi, Coinbase: coinbaseApi };
const QTY_EPSILON = 1e-9;
const ENTRY_TTL_MS = 30 * 60 * 1000; // same window as the order guard
const DUST_USD = 1; // below any order minimum: an ended exit leaving less than this unsold closes the record
const ENDED = new Set(['filled', 'canceled', 'expired', 'failed', 'rejected']); // the exit order can fill no more

// One warning per position/condition, not one per 60s tick.
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

// Coinbase's single attached order serves both exits: infer which one filled.
function exitKind(pos, exit) {
  if (exit.kind) return exit.kind;
  const gain = pos.direction === 'short' ? exit.avgFillPrice < pos.fillPrice : exit.avgFillPrice > pos.fillPrice;
  return gain ? 'take_profit' : 'stop_loss';
}

// Real fees (this record's share of the entry fee + the exit order's) and the execution audit
// (Phase 63: the bracket leg's own level less its fee vs the real fill) for `qty` sold.
function exitBooking(current, kind, qty, exit, entryFee) {
  const exitFees = Number.isFinite(exit.fees) ? exit.fees : undefined;
  const actualFees = Number.isFinite(entryFee) && exitFees !== undefined ? entryFee * Math.min(1, qty / current.positionSize) + exitFees : undefined;
  const level = kind === 'take_profit' ? current.targets && current.targets[0] && current.targets[0].price : current.invalidation;
  const rate = current.broker === 'Coinbase' ? be.exactRate('crypto', kind === 'take_profit' ? 'maker' : 'taker') : 0;
  const cashoutAudit = current.direction === 'short' || !(level > 0) ? null : be.cashoutVariance({ expected: level * qty * (1 - rate), expectedQty: qty,
    filledQty: qty, avgFillPrice: exit.avgFillPrice, fees: exitFees !== undefined ? exitFees : level * qty * rate, expectedBid: level,
    basis: kind === 'take_profit' ? 'take-profit limit' : 'stop trigger' });
  return { actualFees, ...(cashoutAudit ? { cashoutAudit } : {}) };
}

// P0-4: the exit order ENDED after selling only `sold`. That part is booked now as its own
// record (BROKER_EXIT); the rest stays open, flagged UNARMORED (nothing protects it), and
// remembers the booked quantity so the same order's fill is never booked twice.
function bookPartial(pos, current, exit, sold, booked, entryFee, ledger) {
  const kind = exitKind(current, exit);
  const part = ledger.splitPosition(pos.id, sold);
  const trade = ledger.closePosition(part.id, exit.avgFillPrice, 'BROKER_EXIT', {
    exitLeg: kind, brokerExitId: exit.brokerExitId, pnlSource: 'broker-fills', partialExit: true, ...exitBooking(current, kind, sold, exit, entryFee),
  });
  ledger.updatePositions((p) => (p.id === pos.id ? Object.assign(p, { brokerExitBookedId: exit.brokerExitId, brokerExitBookedQty: booked + sold }) && true : false));
  const rest = +(current.positionSize - sold).toFixed(8);
  const why = `the ${kind === 'take_profit' ? 'take-profit' : 'stop'} order ended ${exit.status} after selling ${sold} of ${current.positionSize}; the remaining ${rest} has no stop/target at ${pos.broker}`;
  ledger.setBracketStatus(pos.id, 'UNARMORED', why);
  console.error(`[reconcile] CRITICAL ${pos.id}: booked the ${sold} sold @ ${exit.avgFillPrice}; UNARMORED: ${why}.`);
  return { id: pos.id, action: 'booked', detail: `${kind} ended ${exit.status}: ${sold} booked @ ${exit.avgFillPrice}, ${rest} still open`, trade, flagged: true };
}

async function reconcileOne(pos, ledger) {
  const api = APIS[pos.broker];
  if (!api) return { id: pos.id, action: 'error', detail: `unknown broker "${pos.broker}"` };

  // A manual [Close at Coinbase] sell whose outcome was unknown (timeout / 429 / 5xx, P0-2), or
  // one still working when it returned (coinbase-exit.js).
  if (pos.marketExitPending && pos.broker === 'Coinbase') return require('./coinbase-exit').resolvePending(pos, ledger);
  if (pos.brokerManualExitId && pos.broker === 'Coinbase') return require('./coinbase-exit').settle(pos, ledger);
  if (pos.adopted) return { id: pos.id, action: 'unchanged' };

  const s = await api.getOrderStatus(pos.brokerId, { exitId: pos.brokerBracketId }); // a re-armed stand-alone bracket, if any
  if (!s.ok) {
    console.warn(`[reconcile] ${pos.id}: ${pos.broker} status unavailable (${s.error}); unchanged`);
    return { id: pos.id, action: 'error', detail: s.error };
  }

  // 1. Entry ended without filling anything: there is no position at the broker.
  if (s.terminal && !(s.filledQty > 0)) {
    ledger.voidLivePosition(pos.id, `ENTRY_${String(s.status).toUpperCase()}`);
    return { id: pos.id, action: 'voided', detail: `entry ${s.status} with nothing filled` };
  }

  // Unfilled resting limit entry past its window: cancel (voided once Coinbase confirms).
  if (!s.terminal && !(s.filledQty > 0) && pos.brokerEntryType === 'limit' && Date.now() - pos.openedAt > ENTRY_TTL_MS && api.cancelOrder) {
    const c = await api.cancelOrder(pos.brokerId);
    if (!c.ok) warnOnce(`${pos.id}:cancel`, `[reconcile] ${pos.id}: could not cancel the unfilled limit entry (${c.error})`);
    return { id: pos.id, action: 'waiting', detail: c.ok ? 'unfilled limit entry canceled after 30 minutes' : c.error };
  }

  // 2. Record the real entry fill once it is known (or if it changed). A split record
  // (Phase 67) is a part of the entry: never grown back to the entry's size.
  let current = pos;
  let synced = false;
  if (s.filledQty > 0 && s.avgFillPrice > 0
    && (pos.fillEstimated || Math.abs(pos.fillPrice - s.avgFillPrice) > QTY_EPSILON || (!pos.parentId && s.filledQty < pos.positionSize - QTY_EPSILON))) {
    current = ledger.syncLiveFill(pos.id, { fillPrice: s.avgFillPrice, filledQty: Math.min(s.filledQty, pos.positionSize) });
    synced = true;
  }
  // Phase 63: the entry order's real fee (the net P&L and break-even use it, not the model's);
  // a split record carries only its share of it (entryFeeShare, Phase 67).
  const entryFee = Number.isFinite(s.fees) ? s.fees * entryShare(current) : undefined;
  if (s.filledQty > 0 && entryFee > 0 && Math.abs((current.entryFeeActual || 0) - entryFee) > 1e-12) {
    ledger.updatePositions((p) => (p.id === pos.id ? Object.assign(p, { entryFeeActual: entryFee }) && true : false));
    current = { ...current, entryFeeActual: entryFee };
  }

  // 3. Protective exit filled: close, or book the part an ended exit sold. What an earlier
  // pass already booked from the same order (brokerExitBooked*) is not sold again.
  const exit = s.exit;
  const booked = exit && exit.brokerExitId && current.brokerExitBookedId === exit.brokerExitId ? current.brokerExitBookedQty || 0 : 0;
  const sold = exit ? exit.filledQty - booked : 0;
  const ended = !!exit && ENDED.has(String(exit.status));
  if (exit && sold > QTY_EPSILON && exit.avgFillPrice > 0) {
    const rest = current.positionSize - sold;
    const dust = ended && rest * exit.avgFillPrice < DUST_USD;
    if (rest > QTY_EPSILON && !dust) {
      if (ended) return bookPartial(pos, current, exit, sold, booked, entryFee, ledger);
      warnOnce(`${pos.id}:partial-exit`, `[reconcile] ${pos.id}: exit partially filled (${sold}/${current.positionSize}); waiting for the rest`);
      return { id: pos.id, action: synced ? 'synced' : 'waiting', detail: 'exit partially filled' };
    }
    const kind = exitKind(current, exit);
    const closed = ledger.closePosition(pos.id, exit.avgFillPrice, 'BROKER_EXIT', {
      exitLeg: kind, brokerExitId: exit.brokerExitId, pnlSource: 'broker-fills', ...exitBooking(current, kind, Math.min(sold, current.positionSize), exit, entryFee),
      ...(dust && rest > QTY_EPSILON ? { dustQty: rest } : {}),
    });
    return { id: pos.id, action: 'closed', detail: `${kind} filled @ ${exit.avgFillPrice}`, trade: closed };
  }

  // 5. Still open: is a stop / target working at the broker for the filled entry?
  if (s.filledQty > 0 && s.terminal) {
    const armed = !!exit && exit.status === 'open';
    const why = armed ? null : !exit ? `no stop/target order exists at ${pos.broker}`
      : exit.status === 'none' ? `no stop/target order is working at ${pos.broker}` : `the stop/target order is ${exit.status} at ${pos.broker}`;
    const was = current.bracketStatus;
    // Already UNARMORED: keep the (more specific) reason it was flagged with; alarm on transitions only.
    if ((armed || was !== 'UNARMORED') && ledger.setBracketStatus(pos.id, armed ? 'ARMED' : 'UNARMORED', why)) {
      if (!armed) console.error(`[reconcile] CRITICAL ${pos.id}: UNARMORED: ${why}. The position is unprotected; set a stop at ${pos.broker} or close it.`);
      if (!armed || was === 'UNARMORED') return { id: pos.id, action: 'flagged', detail: armed ? 'stop/target working again' : why };
    }
  }
  return { id: pos.id, action: synced ? 'synced' : 'unchanged' };
}

// Returns one result per LIVE position: { id, action: closed|booked|flagged|voided|synced|unchanged|waiting|error, ... }.
// Positions are checked concurrently so one slow broker call can't stall the loop.
async function reconcileLivePositions(activePositions, ledger) {
  // Adopted holdings have no broker order to poll (they are watched, not traded) unless a
  // manual sell of one is working; a position mid-[Close at Coinbase] is left to that close.
  const closing = require('./coinbase-exit').isClosing;
  const live = (activePositions || []).filter((p) => p.execution === 'LIVE' && (!p.adopted || p.brokerManualExitId || p.marketExitPending) && !closing(p.id));
  return Promise.all(live.map((pos) => reconcileOne(pos, ledger).catch((err) => {
    console.error(`[reconcile] ${pos.id} failed: ${err.message}`);
    return { id: pos.id, action: 'error', detail: err.message };
  })));
}

module.exports = { reconcileLivePositions, DUST_USD };
