// Client WebSocket message routing. The client only sends intents; this module
// asks the order guard and the ledger, then broadcasts the resulting state so
// every open client shows the same thing. Transport (send/broadcast) is injected
// by server.js, so this file never touches sockets directly.
const ledger = require('./paper-ledger');
const { validateApproval } = require('./order-guard');
const prices = require('../market/latest-prices');
const { calculateAllocation } = require('../strategies/4-portfolio-pilot');
const { publishBrokerState } = require('./broker-state');
const { recordRejection } = require('./rejection-stats');
const { publishIntelligence } = require('../intelligence/dashboard-intel');
const { runPipeline, getScanStatus } = require('./pipeline');
const alpacaApi = require('../connectors/alpaca-api');
const coinbaseApi = require('../connectors/coinbase-api');

// Execution venue per market: which mode setting governs it, and which broker
// connector places LIVE orders. Options have no live path yet: their strikes and
// debit are simulated, and a stock bracket on the underlying would buy SHARES.
const VENUES = {
  stocks: { modeKey: 'stockMode', broker: 'Alpaca', api: alpacaApi },
  options: { modeKey: 'stockMode', broker: 'Alpaca', api: null },
  crypto: { modeKey: 'cryptoMode', broker: 'Coinbase', api: coinbaseApi },
};

// Route a guard-approved order by its venue's mode.
//   paper: fill in the paper ledger.
//   live:  submit to the broker first; only an ACCEPTED order is recorded in the
//          ledger (tagged execution LIVE + brokerId). A failed submit leaves the
//          order pending and nothing is filled anywhere.
async function routeApproved(order, livePrice) {
  const venue = VENUES[order.market];
  if (!venue) throw new Error(`no execution venue for market "${order.market}"`);
  if (ledger.getSettings()[venue.modeKey] === 'paper') return ledger.executeOrder(order.id, livePrice);
  if (!venue.api) throw new Error('LIVE_OPTIONS_UNSUPPORTED');

  console.warn(`[LIVE] submitting ${order.direction} ${order.positionSize} ${order.asset} to ${venue.broker} (${order.id})`);
  const result = await venue.api.submitOrder(order, order.positionSize, livePrice);
  if (!result.ok) {
    console.error(`[LIVE] ${venue.broker} order FAILED for ${order.id}: ${result.error}`);
    throw new Error(`LIVE_ORDER_FAILED: ${result.error}`);
  }
  console.warn(`[LIVE] ${venue.broker} accepted ${order.id} as ${result.brokerId}`);

  try {
    return ledger.executeOrder(order.id, livePrice, {
      execution: 'LIVE',
      brokerId: result.brokerId,
      broker: venue.broker,
      brokerEnvironment: result.environment,
      fillEstimated: true, // market order: the broker's actual fill price is not fetched yet
    });
  } catch (err) {
    // The broker holds a real position the ledger could not record. Never silent.
    console.error(`[LIVE] CRITICAL: ${venue.broker} order ${result.brokerId} was placed for ${order.id} `
      + `but the ledger could not record it (${err.message}). Reconcile manually in ${venue.broker}.`);
    throw new Error(`LIVE_UNRECORDED: ${venue.broker} order ${result.brokerId} placed but not recorded; check ${venue.broker}`);
  }
}

// Guarded approval: the order guard runs first whatever the venue, then the order
// is routed by its market's mode. Failed guards retire the setup with a reason.
async function approveWithGuard(id) {
  const order = ledger.getPendingOrders().find((o) => o.id === id);
  if (!order) throw new Error(`no pending order ${id}`);
  const livePrice = prices.getLatestPrice(order.asset);
  const check = validateApproval(order, livePrice);
  if (check.valid) return routeApproved(order, livePrice);
  // A missing price is a data gap, not a verdict on the setup: leave it pending.
  if (check.reason !== 'NO_LIVE_PRICE') {
    ledger.discardOrder(id);
    recordRejection(id, check.reason, order);
  }
  throw new Error(check.reason);
}

// Manual close from the Portfolio tab. PAPER positions only, at a fresh live
// price, booked by the ledger exactly like a stop/target exit (same fee model).
// A LIVE position is closed at the broker (its bracket orders live there); the
// reconciler then records the real fill.
function closeManually(id) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  if (!pos) throw new Error(`no open position ${id}`);
  if (pos.execution === 'LIVE') throw new Error('LIVE_CLOSE_UNSUPPORTED');
  const livePrice = prices.getLatestPrice(pos.asset);
  if (!(livePrice > 0)) throw new Error('NO_LIVE_PRICE');
  return ledger.closePosition(id, livePrice, 'MANUAL_CLOSE');
}

const QUEUE_ACTIONS = {
  APPROVE: (id) => approveWithGuard(id),
  REJECT: (id) => {
    const order = ledger.getPendingOrders().find((o) => o.id === id);
    const discarded = ledger.discardOrder(id);
    recordRejection(id, 'REJECTED_BY_USER', order);
    return discarded;
  },
};

// Orders with an APPROVE/REJECT in progress. A live submit awaits the broker, so
// without this a double-click could send two orders, or a REJECT could remove an
// order the broker is filling.
const inFlight = new Set();

// Manual "Run scan": one extra pipeline pass (the same pass the 60s timer runs),
// at most once per MANUAL_SCAN_GAP_MS and never on top of a running pass.
const MANUAL_SCAN_GAP_MS = 10000;
let lastManualScan = 0;

function createMessageHandler({ send, broadcast }) {
  async function handleQueueAction(ws, { type, id }) {
    if (typeof id === 'string' && inFlight.has(id)) {
      send(ws, 'ACTION_FAILED', { type, id, error: 'ORDER_BUSY' });
      return;
    }
    if (typeof id === 'string') inFlight.add(id);
    try {
      if (typeof id !== 'string' || !id) throw new Error('missing order id');
      const result = await QUEUE_ACTIONS[type](id);
      console.log(`[ledger] ${type} ${id} -> ${result.status}${result.execution === 'LIVE' ? ` (LIVE ${result.brokerId})` : ''}`);
      if (result.status === 'open') {
        broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
        try { publishIntelligence(broadcast); } catch (err) { console.error('[intel] publish failed:', err.message); }
      }
    } catch (err) {
      console.warn(`[ledger] ${type} ${id} failed: ${err.message}`);
      send(ws, 'ACTION_FAILED', { type, id, error: err.message });
    } finally {
      inFlight.delete(id);
    }
    broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
  }

  function handleClose(ws, { id }) {
    if (typeof id !== 'string' || !id) return send(ws, 'ACTION_FAILED', { type: 'CLOSE_POSITION', id, error: 'missing position id' });
    if (inFlight.has(id)) return send(ws, 'ACTION_FAILED', { type: 'CLOSE_POSITION', id, error: 'ORDER_BUSY' });
    inFlight.add(id);
    try {
      const trade = closeManually(id);
      console.log(`[ledger] CLOSE_POSITION ${id} @ ${trade.exitPrice}: net ${trade.netPnl.toFixed(2)} (${trade.rMultiple.toFixed(2)}R)`);
      broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
      broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
      try { publishIntelligence(broadcast); } catch (err) { console.error('[intel] publish failed:', err.message); }
    } catch (err) {
      console.warn(`[ledger] CLOSE_POSITION ${id} failed: ${err.message}`);
      send(ws, 'ACTION_FAILED', { type: 'CLOSE_POSITION', id, error: err.message });
    } finally {
      inFlight.delete(id);
    }
    return undefined;
  }

  // Allocator: read-only math, answered to the requesting client only.
  function handleAllocation(ws, { amount }) {
    try {
      const proposal = calculateAllocation(amount, ledger.getActivePositions(), prices.getLatestPrices());
      send(ws, 'ALLOCATION_PROPOSAL', proposal);
    } catch (err) {
      send(ws, 'ALLOCATION_PROPOSAL', { error: err.message });
    }
  }

  // Settings: the ledger validates and persists; every client sees the new values.
  function handleSettings(ws, { payload }) {
    try {
      const settings = ledger.updateSettings(payload);
      console.log(`[settings] updated: ${JSON.stringify(settings)}`);
      broadcast('SETTINGS_UPDATED', settings);
      // Modes or bankroll changed: refresh what each venue has to trade with.
      publishBrokerState(broadcast, { force: true })
        .catch((err) => console.error('[broker] publish after settings update failed:', err.message));
    } catch (err) {
      console.warn(`[settings] rejected update ${JSON.stringify(payload)}: ${err.message}`);
      send(ws, 'SETTINGS_ERROR', { error: err.message, settings: ledger.getSettings() });
    }
  }

  function handleRunScan(ws) {
    const status = getScanStatus();
    if (status.running || Date.now() - lastManualScan < MANUAL_SCAN_GAP_MS) {
      return send(ws, 'SCAN_STATUS', { ...status, notice: 'A scan just ran or is running. Try again in a few seconds.' });
    }
    lastManualScan = Date.now();
    console.log('[pipeline] manual scan requested');
    return runPipeline({ trigger: 'manual' }).catch((err) => console.error('[pipeline] manual scan failed:', err));
  }

  // Entry point for every raw client frame.
  return function handleMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, 'error', 'invalid JSON'); }
    if (msg.type === 'ping') return send(ws, 'pong', Date.now());
    if (QUEUE_ACTIONS[msg.type]) {
      return handleQueueAction(ws, msg).catch((err) => console.error('[ledger] queue action crashed:', err));
    }
    if (msg.type === 'CALCULATE_ALLOCATION') return handleAllocation(ws, msg);
    if (msg.type === 'UPDATE_SETTINGS') return handleSettings(ws, msg);
    if (msg.type === 'RUN_SCAN') return handleRunScan(ws);
    if (msg.type === 'CLOSE_POSITION') return handleClose(ws, msg);
    send(ws, 'error', `unknown message type: ${msg.type}`);
  };
}

module.exports = { createMessageHandler };
