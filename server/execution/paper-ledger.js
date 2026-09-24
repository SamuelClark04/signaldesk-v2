// The single ledger. Only this module holds simulated orders, positions and the
// trade journal. It accepts only orders approved by the risk engine.
// Lifecycle: stageOrder -> pendingOrders -> executeOrder -> activePositions
//            -> closePosition -> tradeJournal
//            pendingOrders -> discardOrder -> discardedOrders (never traded)
// Every change is persisted to server/data/ledger-state.json and restored on start,
// together with the user-editable settings (currently the paper bankroll).
const fs = require('fs');
const path = require('path');
const { isApproved } = require('../risk/risk-engine');
const { estimateRoundTripFees } = require('../risk/cost-authority');

const STATE_PATH = process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', 'data', 'ledger-state.json');
const STATE_VERSION = 2; // v2 adds settings; v1 files load with default settings

// Editable settings: default value and the accepted range for each key.
const SETTINGS_RULES = {
  bankroll: { default: 50000, min: 100, max: 100000000 },
};
const settings = Object.fromEntries(Object.entries(SETTINGS_RULES).map(([k, r]) => [k, r.default]));

// Validate a partial settings object; returns only the known, valid keys.
function cleanSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('settings must be an object');
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = SETTINGS_RULES[key];
    if (!rule) throw new Error(`unknown setting "${key}"`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
      throw new Error(`${key} must be a number between ${rule.min} and ${rule.max}`);
    }
    clean[key] = n;
  }
  return clean;
}

const pendingOrders = [];
const activePositions = [];
const tradeJournal = [];
// Rejected orders are kept (outside the journal) so a strategy re-proposing the
// same deterministic id cannot put a rejected trade back in the queue.
const discardedOrders = [];
const LISTS = { pendingOrders, activePositions, tradeJournal, discardedOrders };

// ---------- Persistence ----------
// Write to a temp file then rename, so a crash mid-write never leaves a torn file.
// A failed save is logged, not thrown: the in-memory ledger stays authoritative.
function saveState() {
  const state = { version: STATE_VERSION, savedAt: new Date().toISOString(), settings, ...LISTS };
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    console.error(`[ledger] FAILED to save state to ${STATE_PATH}: ${err.message}`);
  }
}

// Settings are restored key by key: a missing (v1 file) or invalid value keeps its
// default instead of discarding the whole ledger.
function restoreSettings(saved) {
  if (!saved) return;
  for (const [key, value] of Object.entries(saved)) {
    try {
      Object.assign(settings, cleanSettings({ [key]: value }));
    } catch (err) {
      console.warn(`[ledger] ignoring saved setting: ${err.message}; keeping ${settings[key] ?? 'default'}`);
    }
  }
}

// An unreadable file is moved aside (never silently overwritten) and the ledger starts empty.
function loadState() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const key of Object.keys(LISTS)) {
      if (!Array.isArray(state[key])) throw new Error(`"${key}" is missing or not an array`);
    }
    for (const [key, list] of Object.entries(LISTS)) list.push(...state[key]);
    restoreSettings(state.settings);
    console.log(`[ledger] restored ${pendingOrders.length} pending, ${activePositions.length} open, `
      + `${tradeJournal.length} closed, ${discardedOrders.length} rejected, bankroll $${settings.bankroll} from ${STATE_PATH}`);
  } catch (err) {
    const aside = `${STATE_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(STATE_PATH, aside); } catch { /* leave it in place */ }
    console.error(`[ledger] could not load ${STATE_PATH} (${err.message}); moved to ${aside}, starting empty`);
  }
}

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
  saveState();
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
  saveState();
  return { ...position };
}

function discardOrder(candidateId) {
  const i = findIndex(pendingOrders, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no pending order ${candidateId}`);

  const [order] = pendingOrders.splice(i, 1);
  const discarded = { ...order, status: 'discarded', discardedAt: Date.now() };
  discardedOrders.push(discarded);
  saveState();
  return { ...discarded };
}

// Options value at exit, per share of underlying: each leg's intrinsic value at
// the underlying exit price (buy legs +, sell legs -). Intrinsic ignores the time
// value left in the options, so exits are valued as if at expiry: a spread
// is worth at most its strike width and a stopped-out long call is worth 0.
function optionsExitValue(legs, underlyingPrice) {
  return legs.reduce((v, leg) => {
    const intrinsic = leg.type === 'put'
      ? Math.max(0, leg.strike - underlyingPrice)
      : Math.max(0, underlyingPrice - leg.strike);
    return v + (leg.side === 'sell' ? -1 : 1) * (leg.ratio || 1) * intrinsic;
  }, 0);
}

// Gross P/L before fees, plus the per-share option value at exit (options only).
function grossPnlAt(pos, exitPrice) {
  if (pos.market !== 'options') {
    const sign = pos.direction === 'short' ? -1 : 1;
    return { grossPnl: (exitPrice - pos.fillPrice) * pos.positionSize * sign };
  }
  const { debit, multiplier, legs } = pos.optionsData;
  const exitValue = optionsExitValue(legs || [], exitPrice);
  return { grossPnl: (exitValue - debit) * multiplier * pos.positionSize, optionsExitValue: exitValue };
}

// exitPrice is always the UNDERLYING price (options are valued from their legs).
function closePosition(candidateId, exitPrice, exitReason) {
  if (!(exitPrice > 0)) throw new Error('paper-ledger: exitPrice must be a positive number');
  const i = findIndex(activePositions, candidateId);
  if (i === -1) throw new Error(`paper-ledger: no open position ${candidateId}`);

  // Compute everything before removing the position, so a failure leaves it open.
  const pos = activePositions[i];
  const { grossPnl, optionsExitValue: exitValue } = grossPnlAt(pos, exitPrice);
  const fees = estimateRoundTripFees(pos.market, pos.positionSize, pos.fillPrice, exitPrice);
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
    ...(exitValue === undefined ? {} : { optionsExitValue: exitValue }),
  };
  activePositions.splice(i, 1);
  tradeJournal.push(entry);
  saveState();
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

// ---------- Settings ----------
const getSettings = () => ({ ...settings });

// Validates, applies and persists. Throws (changing nothing) if any value is invalid.
function updateSettings(newSettings) {
  const clean = cleanSettings(newSettings);
  Object.assign(settings, clean);
  saveState();
  return getSettings();
}

// Restore persisted state once, when the module is first required.
loadState();

module.exports = {
  stageOrder,
  executeOrder,
  discardOrder,
  closePosition,
  monitorPositions,
  getPendingOrders,
  getActivePositions,
  getTradeJournal,
  getSettings,
  updateSettings,
};

