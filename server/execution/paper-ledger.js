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
const { grossPnl, priceScenarios, costBreakdown, feeModel, feeLegs } = require('../risk/scenarios');
const { optionMark, saleValue } = require('./option-marks');
const extras = require('./ledger-extras');
const exits = require('./exit-monitor');

const pendingOrders = [];
const activePositions = [];
const tradeJournal = [];
// Rejected orders are kept (outside the journal) so a strategy re-proposing the
// same deterministic id cannot put a rejected trade back in the queue.
const discardedOrders = [];
// Bookmarks ("Saved" tab): snapshots of setups, NOT orders. Kept apart from the
// order lists, so they never count as a known id for staging.
const savedSetups = [];
// Portfolio Pilot SELL / TRIM proposals (Approvals queue); see ledger-extras.js.
const pilotActions = [];
const LISTS = { pendingOrders, activePositions, tradeJournal, discardedOrders, savedSetups, pilotActions };

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
// fill; paper fills are tagged { execution: 'PAPER' }. `resized`: the user's
// Trade Amount override of this order (risk-engine.js resizeOrder), which must
// come from the risk engine and carry the same id.
function executeOrder(candidateId, fillPrice, extra = {}, resized = null) {
  const i = findIndex(pendingOrders, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no pending order ${candidateId}`);
  if (resized && (!isApproved(resized) || resized.id !== candidateId)) throw new Error('paper-ledger: resized order was not approved by the risk engine');

  const [order] = pendingOrders.splice(i, 1);
  const position = {
    ...(resized || order),
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
// Options (option-marks.js): every leg at its fresh real quote (long legs at the
// BID, short legs bought back at the ASK), else the model's bid side.
function grossPnlAt(pos, exitPrice) {
  if (pos.market !== 'options') return { grossPnl: grossPnl(pos, pos.fillPrice, exitPrice) };
  const od = pos.optionsData;
  const m = saleValue(pos, exitPrice);
  return { grossPnl: (m.value - od.debit) * od.multiplier * pos.positionSize, optionsExitValue: m.value, optionsExitBasis: m.basis };
}

// exitPrice is always the UNDERLYING price (options are valued from their legs).
// `extra` is merged into the journal entry (e.g. which broker leg filled).
function closePosition(candidateId, exitPrice, exitReason, extra = {}) {
  if (!(exitPrice > 0)) throw new Error('paper-ledger: exitPrice must be a positive number');
  const i = findIndex(activePositions, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no open position ${candidateId}`);

  // Compute everything before removing the position, so a failure leaves it open.
  const pos = activePositions[i];
  const { grossPnl, optionsExitValue: exitValue, optionsExitBasis } = grossPnlAt(pos, exitPrice);
  // Broker-reconciled closes pass the broker's actual fees; real fill prices already
  // include slippage, so the estimate would double-count it.
  const fees = Number.isFinite(extra.actualFees)
    ? extra.actualFees
    : estimateRoundTripFees(pos.market, pos.positionSize, pos.fillPrice, exitPrice, feeLegs(pos, /^TAKE_PROFIT/.test(exitReason) ? 'target' : 'stop'));
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
    ...(exitValue === undefined ? {} : { optionsExitValue: exitValue, optionsExitBasis }),
  };
  activePositions.splice(i, 1);
  tradeJournal.push(entry);
  store.save();
  return { ...entry };
}

// Partial exit (Portfolio Pilot TRIM): `fraction` of a PAPER position is split
// off and closed through closePosition (same fees, P/L and journal entry, id
// "<id>:trim:<ms>"); the rest stays open with its size and dollar risk reduced.
function reducePosition(candidateId, fraction, exitPrice, exitReason) {
  const pos = activePositions.find((p) => p.id === candidateId);
  if (!pos) throw new Error(`paper-ledger: no open position ${candidateId}`);
  if (pos.market === 'options') throw new Error('paper-ledger: options positions cannot be reduced');
  if (!(fraction > 0 && fraction < 1)) throw new Error('paper-ledger: fraction must be between 0 and 1');
  const raw = pos.positionSize * fraction;
  const step = pos.market === 'stocks' ? (pos.fractional ? 1e4 : 1) : 1e8; // whole shares, 0.0001 share (fractional), or 8-decimal coins
  const q = Math.floor(raw * step + 1e-9) / step;
  if (!(q > 0) || q >= pos.positionSize) throw new Error('TRIM_TOO_SMALL: the position is too small to trim');
  const share = q / pos.positionSize;
  const part = { ...pos, id: `${pos.id}:trim:${Date.now()}`, parentId: pos.id, positionSize: q, dollarRisk: pos.dollarRisk * share };
  pos.positionSize -= q;
  pos.dollarRisk -= part.dollarRisk;
  activePositions.push(part);
  return closePosition(part.id, exitPrice, exitReason);
}

// Exit checks (stop, T1 partial, T2 runner, option values): exit-monitor.js.
const monitorPositions = (latestPricesMap) => exits.monitorPositions(latestPricesMap);

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
// Open positions carry their fee model (derived, not stored) for live P/L marks,
// and real option contracts their current value (optionMark, option-marks.js).
const getActivePositions = () => activePositions.map((p) => ({ ...p, feeModel: feeModel(p.market, p.entryLiquidity, p.optionsData && p.optionsData.legs ? p.optionsData.legs.length : 1), optionMark: optionMark(p) }));
const getTradeJournal = () => tradeJournal.map((t) => ({ ...t }));

// Data migrations (e.g. options-migration.js): mutate(position) returns true when it
// changed the live record; the ledger is saved once if anything changed. -> count changed.
function updatePositions(mutate) {
  let n = 0;
  for (const p of activePositions) if (mutate(p)) n += 1;
  if (n) store.save();
  return n;
}

// Hand the lists to the store once: it restores them from disk, then saves on every change.
store.attach(LISTS);
extras.bind({ pendingOrders, activePositions, tradeJournal, discardedOrders, savedSetups, pilotActions, save: store.save, backup: store.backup });
exits.bind({ activePositions, closePosition, reducePosition, save: store.save });

module.exports = {
  updatePositions,
  stageOrder,
  executeOrder,
  discardOrder,
  closePosition,
  reducePosition,
  monitorPositions,
  syncLiveFill,
  voidLivePosition,
  adoptPosition,
  releaseAdopted,
  getPendingOrders,
  getActivePositions,
  getTradeJournal,
  saveSetup: extras.saveSetup,
  unsaveSetup: extras.unsaveSetup,
  getSavedSetups: extras.getSavedSetups,
  getPilotActions: extras.getPilotActions,
  syncPilotActions: extras.syncPilotActions,
  resolvePilotAction: extras.resolvePilotAction,
  findPilotAction: extras.findPilotAction,
  resetPaper: extras.resetPaper,
  // Settings live in the store; re-exported so callers keep one ledger API.
  // Mark-to-market for monitoring (same math as closePosition, before fees).
  unrealizedPnl: (position, price) => grossPnlAt(position, price).grossPnl,
  getSettings: store.getSettings,
  updateSettings: store.updateSettings,
};

