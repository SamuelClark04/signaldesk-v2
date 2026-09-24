// The single ledger. Only this module holds simulated orders, positions and the
// trade journal. It accepts only orders approved by the risk engine.
// Lifecycle: stageOrder -> pendingOrders -> executeOrder -> activePositions
//            -> closePosition -> tradeJournal
//            pendingOrders -> discardOrder -> discardedOrders (never traded)
// Trading mechanics only: every change is persisted through ledger-store.js,
// which also owns the user-editable settings (currently the paper bankroll).
const { isApproved } = require('../risk/risk-engine');
const { estimateRoundTripFees } = require('../risk/cost-authority');
const store = require('./ledger-store');
const { grossPnl, optionsValueAt, priceScenarios, costBreakdown, feeModel } = require('../risk/scenarios');

const pendingOrders = [];
const activePositions = [];
const tradeJournal = [];
// Rejected orders are kept (outside the journal) so a strategy re-proposing the
// same deterministic id cannot put a rejected trade back in the queue.
const discardedOrders = [];
const LISTS = { pendingOrders, activePositions, tradeJournal, discardedOrders };

function findIndex(list, candidateId) {
  return list.findIndex((o) => o.id === candidateId);
}

function isKnown(candidateId) {
  return [pendingOrders, activePositions, tradeJournal, discardedOrders]
    .some((l) => findIndex(l, candidateId) !== -1);
}

function stageOrder(sizedCandidate) {
  if (!isApproved(sizedCandidate)) {
    throw new Error('paper-ledger: order was not approved by the risk engine');
  }
  if (isKnown(sizedCandidate.id)) {
    throw new Error(`paper-ledger: duplicate candidate id ${sizedCandidate.id}`);
  }
  const order = { ...sizedCandidate, status: 'pending', stagedAt: Date.now() };
  pendingOrders.push(order);
  store.save();
  return { ...order, scenarios: priceScenarios(order), costs: costBreakdown(order) };
}

// fillPrice defaults to the risk engine's worst-case entry price. `extra` records
// how the order was executed, e.g. { execution: 'LIVE', brokerId } for a broker
// fill; paper fills are tagged { execution: 'PAPER' }.
function executeOrder(candidateId, fillPrice, extra = {}) {
  const i = findIndex(pendingOrders, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no pending order ${candidateId}`);

  const [order] = pendingOrders.splice(i, 1);
  const position = {
    ...order,
    execution: 'PAPER',
    ...extra,
    status: 'open',
    fillPrice: fillPrice > 0 ? fillPrice : order.entryPrice,
    openedAt: Date.now(),
  };
  activePositions.push(position);
  store.save();
  return { ...position };
}

function discardOrder(candidateId) {
  const i = findIndex(pendingOrders, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no pending order ${candidateId}`);

  const [order] = pendingOrders.splice(i, 1);
  const discarded = { ...order, status: 'discarded', discardedAt: Date.now() };
  discardedOrders.push(discarded);
  store.save();
  return { ...discarded };
}

// Gross P/L before fees, plus the per-share option value at exit (options only).
// The maths lives in risk/scenarios.js, shared with the Setups view's previews.
function grossPnlAt(pos, exitPrice) {
  const result = { grossPnl: grossPnl(pos, pos.fillPrice, exitPrice) };
  if (pos.market === 'options') result.optionsExitValue = optionsValueAt(pos.optionsData.legs, exitPrice);
  return result;
}

// exitPrice is always the UNDERLYING price (options are valued from their legs).
// `extra` is merged into the journal entry (e.g. which broker leg filled).
function closePosition(candidateId, exitPrice, exitReason, extra = {}) {
  if (!(exitPrice > 0)) throw new Error('paper-ledger: exitPrice must be a positive number');
  const i = findIndex(activePositions, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no open position ${candidateId}`);

  // Compute everything before removing the position, so a failure leaves it open.
  const pos = activePositions[i];
  const { grossPnl, optionsExitValue: exitValue } = grossPnlAt(pos, exitPrice);
  // Broker-reconciled closes pass the broker's actual fees; real fill prices already
  // include slippage, so the estimate would double-count it.
  const fees = Number.isFinite(extra.actualFees)
    ? extra.actualFees
    : estimateRoundTripFees(pos.market, pos.positionSize, pos.fillPrice, exitPrice);
  const netPnl = grossPnl - fees;

  const entry = {
    ...pos,
    status: 'closed',
    exitPrice,
    exitReason: exitReason || 'unspecified',
    closedAt: Date.now(),
    grossPnl,
    fees,
    netPnl,
    rMultiple: netPnl / pos.dollarRisk,
    ...extra,
    ...(exitValue === undefined ? {} : { optionsExitValue: exitValue }),
  };
  activePositions.splice(i, 1);
  tradeJournal.push(entry);
  store.save();
  return { ...entry };
}

// Nearest target in the trade's favor (T1). For now T1 closes the whole position.
function firstTarget(pos) {
  const prices = (pos.targets || []).map((t) => t.price).filter((p) => p > 0);
  if (!prices.length) return null;
  return pos.direction === 'short' ? Math.max(...prices) : Math.min(...prices);
}

// Exit check on the latest prices (Map or object of asset -> price). The stop
// is checked first, so a price that somehow satisfies both is treated as a loss.
// Returns the journal entries for any positions closed on this pass.
function monitorPositions(latestPricesMap) {
  const priceOf = (asset) => (latestPricesMap instanceof Map
    ? latestPricesMap.get(asset)
    : latestPricesMap && latestPricesMap[asset]);
  const closed = [];

  // Iterate over a snapshot: closePosition removes from activePositions.
  for (const pos of [...activePositions]) {
    // LIVE positions exit at the broker (bracket orders); the reconciler records
    // those real fills. Closing them here on a local price would be a fiction.
    if (pos.execution === 'LIVE') continue;
    const price = priceOf(pos.asset);
    if (!(price > 0)) continue;

    const isLong = pos.direction !== 'short';
    const target = firstTarget(pos);
    const hitStop = isLong ? price <= pos.invalidation : price >= pos.invalidation;
    const hitTarget = target !== null && (isLong ? price >= target : price <= target);

    if (hitStop) closed.push(closePosition(pos.id, price, 'STOP_LOSS'));
    else if (hitTarget) closed.push(closePosition(pos.id, price, 'TAKE_PROFIT'));
  }
  return closed;
}

// ---------- Broker reconciliation (LIVE positions only) ----------
function findLive(candidateId) {
  const pos = activePositions.find((p) => p.id === candidateId);
  if (!pos) throw new Error(`paper-ledger: no open position ${candidateId}`);
  if (pos.execution !== 'LIVE') throw new Error(`paper-ledger: ${candidateId} is not a LIVE position`);
  return pos;
}

// Replace the estimated entry with the broker's actual fill. A partial fill
// shrinks the position (and its dollar risk) to what was really bought.
function syncLiveFill(candidateId, { fillPrice, filledQty }) {
  const pos = findLive(candidateId);
  if (!(fillPrice > 0) || !(filledQty > 0)) throw new Error('paper-ledger: broker fill needs price and quantity');
  if (filledQty < pos.positionSize) {
    pos.dollarRisk *= filledQty / pos.positionSize;
    pos.positionSize = filledQty;
  }
  Object.assign(pos, { fillPrice, fillEstimated: false, brokerFillSyncedAt: Date.now() });
  store.save();
  return { ...pos };
}

// The broker never filled the entry (rejected / canceled / expired): nothing was
// traded, so the record leaves the book without entering the trade journal.
function voidLivePosition(candidateId, reason) {
  findLive(candidateId);
  const i = findIndex(activePositions, candidateId);
  const [pos] = activePositions.splice(i, 1);
  const voided = { ...pos, status: 'void', voidReason: reason, voidedAt: Date.now() };
  discardedOrders.push(voided);
  store.save();
  return { ...voided };
}

// ---------- Adopted holdings (external LIVE positions) ----------
// A holding bought outside SignalDesk, put under its watch with user-chosen
// levels. Recorded as a LIVE position flagged `adopted`: no broker order exists,
// so the reconciler skips it and monitorPositions (paper exits) skips it too;
// SignalDesk ALERTS on it (attention engine) but never places or sends orders.
// Not a risk-engine order: it records money already invested, so isApproved()
// does not apply. The caller (execution/adoption.js) validates everything.
function adoptPosition(position) {
  if (!position || !position.id || isKnown(position.id)) throw new Error('paper-ledger: invalid or duplicate adoption id');
  const pos = { ...position, execution: 'LIVE', adopted: true, status: 'open', openedAt: Date.now() };
  activePositions.push(pos);
  store.save();
  return { ...pos };
}

// Stop managing an adopted holding (the coins stay at the broker). It leaves the
// book without a journal entry: SignalDesk never traded it.
function releaseAdopted(candidateId) {
  const i = findIndex(activePositions, candidateId);
  if (i === -1 || !activePositions[i].adopted) throw new Error(`paper-ledger: ${candidateId} is not an adopted position`);
  const [pos] = activePositions.splice(i, 1);
  const released = { ...pos, status: 'released', releasedAt: Date.now() };
  discardedOrders.push(released);
  store.save();
  return { ...released };
}

// Read-only views: callers get copies, never the ledger's own arrays.
// Pending orders carry derived price scenarios (stop/T1/T2) for the Setups view;
// derived on read, never stored, so older saved orders get them too.
const getPendingOrders = () => pendingOrders.map((o) => ({ ...o, scenarios: priceScenarios(o), costs: costBreakdown(o) }));
// Open positions carry their fee model (derived, not stored) for live P/L marks.
const getActivePositions = () => activePositions.map((p) => ({ ...p, feeModel: feeModel(p.market) }));
const getTradeJournal = () => tradeJournal.map((t) => ({ ...t }));

// Hand the lists to the store once: it restores them from disk, then saves on every change.
store.attach(LISTS);

module.exports = {
  stageOrder,
  executeOrder,
  discardOrder,
  closePosition,
  monitorPositions,
  syncLiveFill,
  voidLivePosition,
  adoptPosition,
  releaseAdopted,
  getPendingOrders,
  getActivePositions,
  getTradeJournal,
  // Settings live in the store; re-exported so callers keep one ledger API.
  // Mark-to-market for monitoring (same math as closePosition, before fees).
  unrealizedPnl: (position, price) => grossPnlAt(position, price).grossPnl,
  getSettings: store.getSettings,
  updateSettings: store.updateSettings,
};

