// The single ledger. Only this module holds simulated orders, positions and the
// trade journal. It accepts only orders approved by the risk engine.
// Lifecycle: stageOrder -> pendingOrders -> executeOrder -> activePositions
//            -> closePosition -> tradeJournal
//            pendingOrders -> discardOrder -> discardedOrders (never traded)
const { isApproved } = require('../risk/risk-engine');
const { getRoundTripRate } = require('../risk/cost-authority');

const pendingOrders = [];
const activePositions = [];
const tradeJournal = [];
// Rejected orders are kept (outside the journal) so a strategy re-proposing the
// same deterministic id cannot put a rejected trade back in the queue.
const discardedOrders = [];

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
  return { ...order };
}

// fillPrice defaults to the risk engine's worst-case entry price.
function executeOrder(candidateId, fillPrice) {
  const i = findIndex(pendingOrders, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no pending order ${candidateId}`);

  const [order] = pendingOrders.splice(i, 1);
  const position = {
    ...order,
    status: 'open',
    fillPrice: fillPrice > 0 ? fillPrice : order.entryPrice,
    openedAt: Date.now(),
  };
  activePositions.push(position);
  return { ...position };
}

function discardOrder(candidateId) {
  const i = findIndex(pendingOrders, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no pending order ${candidateId}`);

  const [order] = pendingOrders.splice(i, 1);
  const discarded = { ...order, status: 'discarded', discardedAt: Date.now() };
  discardedOrders.push(discarded);
  return { ...discarded };
}

function closePosition(candidateId, exitPrice, exitReason) {
  if (!(exitPrice > 0)) throw new Error('paper-ledger: exitPrice must be a positive number');
  const i = findIndex(activePositions, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no open position ${candidateId}`);

  const [pos] = activePositions.splice(i, 1);
  const sign = pos.direction === 'short' ? -1 : 1;
  const grossPnl = (exitPrice - pos.fillPrice) * pos.positionSize * sign;

  // Round-trip rate is split evenly across the entry and exit legs.
  const halfRate = getRoundTripRate(pos.market) / 2;
  const fees = halfRate * pos.positionSize * (pos.fillPrice + exitPrice);
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
  };
  tradeJournal.push(entry);
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

// Read-only views: callers get copies, never the ledger's own arrays.
const getPendingOrders = () => pendingOrders.map((o) => ({ ...o }));
const getActivePositions = () => activePositions.map((p) => ({ ...p }));
const getTradeJournal = () => tradeJournal.map((t) => ({ ...t }));

module.exports = {
  stageOrder,
  executeOrder,
  discardOrder,
  closePosition,
  monitorPositions,
  getPendingOrders,
  getActivePositions,
  getTradeJournal,
};
