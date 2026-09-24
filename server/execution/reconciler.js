// Broker reconciliation: brings LIVE positions in line with what the broker
// actually did. The broker is the source of truth for live trades; this module
// never guesses, and a failed status call changes nothing.
//
// Per LIVE position (brokerId = the ENTRY order; exits are its bracket/attached order):
//   1. Entry never filled (canceled/rejected/expired/failed, 0 filled) -> void it
//   2. Entry filled                -> sync the real average fill price + filled qty
//   3. Exit order FULLY filled     -> close at the exit's real average fill (BROKER_EXIT)
//   4. Anything else (working, partially filled, broker unreachable) -> wait
const alpacaApi = require('../connectors/alpaca-api');
const coinbaseApi = require('../connectors/coinbase-api');

const APIS = { Alpaca: alpacaApi, Coinbase: coinbaseApi };
const QTY_EPSILON = 1e-9;

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

async function reconcileOne(pos, ledger) {
  const api = APIS[pos.broker];
  if (!api) return { id: pos.id, action: 'error', detail: `unknown broker "${pos.broker}"` };

  const s = await api.getOrderStatus(pos.brokerId);
  if (!s.ok) {
    console.warn(`[reconcile] ${pos.id}: ${pos.broker} status unavailable (${s.error}); unchanged`);
    return { id: pos.id, action: 'error', detail: s.error };
  }

  // 1. Entry ended without filling anything: there is no position at the broker.
  if (s.terminal && !(s.filledQty > 0)) {
    ledger.voidLivePosition(pos.id, `ENTRY_${String(s.status).toUpperCase()}`);
    return { id: pos.id, action: 'voided', detail: `entry ${s.status} with nothing filled` };
  }

  // 2. Record the real entry fill once it is known (or if it changed).
  let current = pos;
  let synced = false;
  if (s.filledQty > 0 && s.avgFillPrice > 0
    && (pos.fillEstimated || Math.abs(pos.fillPrice - s.avgFillPrice) > QTY_EPSILON || s.filledQty < pos.positionSize - QTY_EPSILON)) {
    current = ledger.syncLiveFill(pos.id, { fillPrice: s.avgFillPrice, filledQty: Math.min(s.filledQty, pos.positionSize) });
    synced = true;
  }

  // 3. Protective exit filled in full: close with the broker's real price.
  const exit = s.exit;
  if (exit && exit.filledQty > 0 && exit.avgFillPrice > 0) {
    if (exit.filledQty + QTY_EPSILON < current.positionSize) {
      warnOnce(`${pos.id}:partial-exit`, `[reconcile] ${pos.id}: exit partially filled `
        + `(${exit.filledQty}/${current.positionSize}); waiting for the rest`);
      return { id: pos.id, action: synced ? 'synced' : 'waiting', detail: 'exit partially filled' };
    }
    const kind = exitKind(current, exit);
    // Real fees = entry order fees + exit order fees, when the broker reports them.
    const actualFees = Number.isFinite(s.fees) && Number.isFinite(exit.fees) ? s.fees + exit.fees : undefined;
    const closed = ledger.closePosition(pos.id, exit.avgFillPrice, 'BROKER_EXIT', {
      exitLeg: kind, brokerExitId: exit.brokerExitId, pnlSource: 'broker-fills', actualFees,
    });
    return { id: pos.id, action: 'closed', detail: `${kind} filled @ ${exit.avgFillPrice}`, trade: closed };
  }

  // 4. Still open. Flag a filled position that has no working exit at the broker.
  if (s.filledQty > 0 && exit && exit.status === 'none') {
    warnOnce(`${pos.id}:no-exit`, `[reconcile] WARNING ${pos.id}: filled at ${pos.broker} but no stop/target order is working. `
      + 'The position is unprotected; check the broker.');
  }
  return { id: pos.id, action: synced ? 'synced' : 'unchanged' };
}

// Returns one result per LIVE position: { id, action: closed|voided|synced|unchanged|waiting|error, ... }.
// Positions are checked concurrently so one slow broker call can't stall the loop.
async function reconcileLivePositions(activePositions, ledger) {
  const live = (activePositions || []).filter((p) => p.execution === 'LIVE');
  return Promise.all(live.map((pos) => reconcileOne(pos, ledger).catch((err) => {
    console.error(`[reconcile] ${pos.id} failed: ${err.message}`);
    return { id: pos.id, action: 'error', detail: err.message };
  })));
}

module.exports = { reconcileLivePositions };
