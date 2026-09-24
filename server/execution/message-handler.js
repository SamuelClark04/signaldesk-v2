// Client WebSocket message routing. The client only sends intents; this module
// asks the order guard and the ledger, then broadcasts the resulting state so
// every open client shows the same thing. Transport (send/broadcast) is injected
// by server.js, so this file never touches sockets directly.
const ledger = require('./paper-ledger');
const { validateApproval } = require('./order-guard');
const prices = require('../market/latest-prices');
const { calculateAllocation } = require('../strategies/4-portfolio-pilot');

// Guarded approval: fills at the live price, or retires the setup with a reason.
function approveWithGuard(id) {
  const order = ledger.getPendingOrders().find((o) => o.id === id);
  if (!order) throw new Error(`no pending order ${id}`);
  const livePrice = prices.getLatestPrice(order.asset);
  const check = validateApproval(order, livePrice);
  if (check.valid) return ledger.executeOrder(id, livePrice);
  // A missing price is a data gap, not a verdict on the setup: leave it pending.
  if (check.reason !== 'NO_LIVE_PRICE') ledger.discardOrder(id);
  throw new Error(check.reason);
}

const QUEUE_ACTIONS = {
  APPROVE: (id) => approveWithGuard(id),
  REJECT: (id) => ledger.discardOrder(id),
};

function createMessageHandler({ send, broadcast }) {
  function handleQueueAction(ws, { type, id }) {
    try {
      if (typeof id !== 'string' || !id) throw new Error('missing order id');
      const result = QUEUE_ACTIONS[type](id);
      console.log(`[ledger] ${type} ${id} -> ${result.status}`);
      if (result.status === 'open') broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
    } catch (err) {
      console.warn(`[ledger] ${type} ${id} failed: ${err.message}`);
      send(ws, 'ACTION_FAILED', { type, id, error: err.message });
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
    if (QUEUE_ACTIONS[msg.type]) return handleQueueAction(ws, msg);
    if (msg.type === 'CALCULATE_ALLOCATION') return handleAllocation(ws, msg);
    if (msg.type === 'UPDATE_SETTINGS') return handleSettings(ws, msg);
    send(ws, 'error', `unknown message type: ${msg.type}`);
  };
}

module.exports = { createMessageHandler };
