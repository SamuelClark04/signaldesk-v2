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
    recordRejection(id, check.reason);
  }
  throw new Error(check.reason);
}

const QUEUE_ACTIONS = {
  APPROVE: (id) => approveWithGuard(id),
  REJECT: (id) => {
    const discarded = ledger.discardOrder(id);
    recordRejection(id, 'REJECTED_BY_USER');
    return discarded;
  },
};

// Orders with an APPROVE/REJECT in progress. A live submit awaits the broker, so
// without this a double-click could send two orders, or a REJECT could remove an
// order the broker is filling.
const inFlight = new Set();

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
      if (result.status === 'open') broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
    } catch (err) {
      console.warn(`[ledger] ${type} ${id} failed: ${err.message}`);
      send(ws, 'ACTION_FAILED', { type, id, error: err.message });
    } finally {
      inFlight.delete(id);
    }
    broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
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
    send(ws, 'error', `unknown message type: ${msg.type}`);
  };
}

module.exports = { createMessageHandler };
