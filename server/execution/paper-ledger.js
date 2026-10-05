// The single ledger. Only this module holds simulated orders, positions and the
// trade journal. It accepts only orders approved by the risk engine.
// Lifecycle: stageOrder -> pendingOrders -> executeOrder -> activePositions
//            -> closePosition -> tradeJournal
//            pendingOrders -> discardOrder -> discardedOrders (never traded)
// Trading mechanics only: every change is persisted through ledger-store.js,
// which also owns the user-editable settings (currently the paper bankroll).
const { isApproved } = require('../risk/risk-engine');
const { estimateRoundTripFees, feeKey } = require('../risk/cost-authority'); // feeKey: the venue's fees (69A)
const store = require('./ledger-store');
const evidence = require('../strategies/strategy-evidence'); // Phase 91: each setup carries its strategy's test record
const { grossPnl, priceScenarios, costBreakdown, feeModel, feeLegs } = require('../risk/scenarios');
const { optionMark } = require('./option-marks');
const exitQuotes = require('./exit-quote'); // WYSIWYG: the one exit pricing for bookings and the screen (Phase 59)
const prices = require('../market/latest-prices');
const extras = require('./ledger-extras');
const exits = require('./exit-monitor');
const live = require('./ledger-live');
const ratchet = require('./ratchet'); // Phase 68: each long's profit-ratchet plan (derived on read)

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
  const order = { ...sizedCandidate, evidence: sizedCandidate.evidence || evidence.of(sizedCandidate.strategyId), status: 'pending', stagedAt: Date.now() };
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
  require('../research/decision-recorder').record('OPENED', position.id, { candidate: position }); // Phase 93: record-only
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

// exitPrice is always the UNDERLYING price (options are valued from their legs).
// `extra` is merged into the journal entry (e.g. which broker leg filled).
// Gross P/L and fees come from exit-quote.js quote(): the SAME numbers the open
// position showed as "Net if closed now" (Phase 59); `booked` is the exact quote a
// manual close was shown (exit-quote.closeManually), booked to the cent.
function closePosition(candidateId, exitPrice, exitReason, extra = {}, booked = null) {
  if (!(exitPrice > 0)) throw new Error('paper-ledger: exitPrice must be a positive number');
  const i = findIndex(activePositions, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no open position ${candidateId}`);

  // Compute everything before removing the position, so a failure leaves it open.
  const pos = activePositions[i];
  const q = booked || exitQuotes.quote(pos, exitPrice, /^TAKE_PROFIT/.test(exitReason) ? 'target' : 'stop');
  const grossPnl = q ? q.gross : grossPnlLinear(pos, exitPrice);
  const exitValue = pos.market === 'options' && q ? q.exitValue : undefined;
  const optionsExitBasis = q ? q.basis : null;
  // Broker-reconciled closes pass the broker's actual fees; real fill prices already
  // include slippage, so the estimate would double-count it.
  const fees = Number.isFinite(extra.actualFees) ? extra.actualFees
    : q ? q.fees : estimateRoundTripFees(feeKey(pos), pos.positionSize, pos.fillPrice, exitPrice, feeLegs(pos, /^TAKE_PROFIT/.test(exitReason) ? 'target' : 'stop'));
  const netPnl = Number.isFinite(extra.actualFees) || !q ? grossPnl - fees : q.net;

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
  // Phase 68 (P1-2): a broker's real fill time (extra.closedAt) is kept when it is plausible
  // (after the setup was staged, not in the future); otherwise the booking time.
  const t = entry.closedAt;
  if (!(Number.isFinite(t) && t >= (pos.stagedAt || pos.openedAt || 0) - 60000 && t <= Date.now() + 60000)) entry.closedAt = Date.now();
  activePositions.splice(i, 1);
  tradeJournal.push(entry);
  store.save();
  require('../research/decision-recorder').record('CLOSED', entry.id, { reason: entry.exitReason, candidate: entry, extra: { parentId: entry.parentId || null } }); // Phase 93
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
// LIVE bookkeeping (split, broker fill, void, bracket status) and adopted holdings: ledger-live.js (Phase 67).

// Read-only views: callers get copies, never the ledger's own arrays.
// Pending orders carry derived price scenarios (stop/T1/T2) for the Setups view;
// derived on read, never stored, so older saved orders get them too.
const getPendingOrders = () => pendingOrders.map((o) => ({ ...o, scenarios: priceScenarios(o), costs: costBreakdown(o), hurdle: require('../risk/break-even').hurdleFor(o), expiresAt: require('./setup-ttl').expiresAt(o) })); // + fee hurdle (63), approval deadline (66)
// Open positions carry their fee model (derived, not stored) for live P/L marks,
// and real option contracts their current value (optionMark, option-marks.js).
// exitQuote: what a manual close would book right now ("Net if closed now"), and its cashout.
const getActivePositions = () => activePositions.map((p) => {
  const v = { ...p, feeModel: feeModel(p.market === 'options' ? 'options' : feeKey(p), p.entryLiquidity, p.optionsData && p.optionsData.legs ? p.optionsData.legs.length : 1), optionMark: optionMark(p),
    exitQuote: exitQuotes.issue(p, prices.getLatestPrice(p.asset)) }; // LIVE too (display: [Close at Coinbase] cashout; closing refuses LIVE)
  return { ...v, ratchet: ratchet.plan(v) }; // Phase 68: +1.0R / +1.5R stop locks (ratchet.js)
});
const grossPnlLinear = (pos, exitPrice) => grossPnl(pos, pos.fillPrice, exitPrice);
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
live.bind({ pendingOrders, activePositions, tradeJournal, discardedOrders, isKnown, findIndex, save: store.save });

module.exports = {
  updatePositions,
  stageOrder,
  replacePending: live.replacePending,
  executeOrder,
  discardOrder,
  closePosition,
  reducePosition,
  splitPosition: live.splitPosition,
  monitorPositions,
  syncLiveFill: live.syncLiveFill,
  voidLivePosition: live.voidLivePosition,
  setBracketStatus: live.setBracketStatus,
  adoptPosition: live.adoptPosition,
  releaseAdopted: live.releaseAdopted,
  markSubmitting: live.markSubmitting,
  recoverable: live.recoverable,
  recoverLive: live.recoverLive,
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
  unrealizedPnl: (position, price) => { const q = exitQuotes.quote(position, price); return q ? q.gross : 0; },
  getSettings: store.getSettings,
  updateSettings: store.updateSettings,
};

