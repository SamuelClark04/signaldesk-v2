// Client WebSocket message routing. The client only sends intents; this module
// asks the order guard and the ledger, then broadcasts the resulting state so
// every open client shows the same thing. Transport (send/broadcast) is injected
// by server.js, so this file never touches sockets directly.
const ledger = require('./paper-ledger');
const { validateApproval } = require('./order-guard');
const prices = require('../market/latest-prices');
const { createPilotHandler } = require('./pilot-handler');
const { publishBrokerState } = require('./broker-state');
const { recordRejection } = require('./rejection-stats');
const { publishIntelligence } = require('../intelligence/dashboard-intel');
const { runPipeline, getScanStatus } = require('./pipeline');
const { requiredBasis } = require('../risk/venue-capital');
const alpacaApi = require('../connectors/alpaca-api');
const coinbaseApi = require('../connectors/coinbase-api');
const brokerSync = require('../connectors/broker-sync');
const adoption = require('./adoption');
const { suggestLevels } = require('../risk/adoption-levels');
const newsSentiment = require('../connectors/news-sentiment');

// Execution venue per market: which mode setting governs it, and which broker
// connector places LIVE orders. Options have no live path yet: the contract and
// premium are real (options-data.js), but no option order routing exists, and a
// stock bracket on the underlying would buy SHARES.
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
  const settings = ledger.getSettings();
  if (settings[venue.modeKey] === 'paper') return ledger.executeOrder(order.id, livePrice);
  if (!venue.api) throw new Error('LIVE_OPTIONS_UNSUPPORTED');
  // A LIVE order must have been sized from that live account. One staged while
  // the venue was on paper (or before this check existed) is refused, never sent.
  const needed = requiredBasis(order.market, settings);
  if (order.sizingBasis !== needed) throw new Error(`SIZED_FOR_OTHER_VENUE: sized from ${order.sizingBasis || 'the paper bankroll'}, venue needs ${needed}`);

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

  // Adopt an external holding / stop managing it. Ledger changes only: no order
  // is placed at the broker either way (see execution/adoption.js).
  function handleAdoption(ws, msg) {
    const type = msg.type;
    try {
      const result = type === 'ADOPT_POSITION' ? adoption.adopt(msg.payload) : ledger.releaseAdopted(String(msg.id || ''));
      console.log(`[ledger] ${type} ${result.id}: ${result.positionSize} ${result.asset}${type === 'ADOPT_POSITION' ? ` stop ${result.invalidation} T1 ${result.targets[0].price}` : ''}`);
      broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
      try { publishIntelligence(broadcast); } catch (err) { console.error('[intel] publish failed:', err.message); }
    } catch (err) {
      console.warn(`[ledger] ${type} failed: ${err.message}`);
      send(ws, 'ACTION_FAILED', { type, id: msg.id || (msg.payload && msg.payload.asset), error: err.message });
    }
  }

  // Bookmarks: every client gets the new list (SAVED_SETUPS).
  function handleSaved(ws, { type, id }) {
    try {
      const list = type === 'SAVE_SETUP' ? ledger.saveSetup(String(id || '')) : ledger.unsaveSetup(String(id || ''));
      broadcast('SAVED_SETUPS', list);
    } catch (err) {
      send(ws, 'ACTION_FAILED', { type, id, error: err.message });
    }
  }

  // Suggested stop/target for an adoption (read-only maths on real candles),
  // answered to the requesting client; requestId lets it drop stale answers.
  async function handleSuggest(ws, { requestId, payload = {} }) {
    const asset = String(payload.asset || '').toUpperCase();
    const strategy = adoption.STRATEGIES[payload.strategy];
    const reply = (body) => send(ws, 'ADOPTION_SUGGESTIONS', { requestId, asset, strategy: payload.strategy, ...body });
    if (!/^[A-Z0-9]{1,10}-USD$/.test(asset) || !strategy) return reply({ ok: false, error: 'invalid asset or strategy' });
    const result = await suggestLevels({ asset, timeframe: strategy.timeframe, livePrice: prices.getLatestPrice(asset) })
      .catch((err) => ({ ok: false, error: err.message }));
    return reply(result);
  }

  // "Sync Broker": read-only fetch of real broker holdings; every client gets the
  // new snapshot (BROKER_HOLDINGS). A repeat within 10 s is answered, not re-fetched.
  async function handleSync(ws) {
    send(ws, 'BROKER_HOLDINGS', { ...brokerSync.getSnapshot(), syncing: true });
    const result = await brokerSync.syncPortfolio();
    if (result.busy) return send(ws, 'BROKER_HOLDINGS', { ...result.snapshot, notice: 'A sync just ran. Try again in a few seconds.' });
    return broadcast('BROKER_HOLDINGS', result.snapshot);
  }

  // Portfolio Pilot: deposit -> staged BUY setups; SELL / TRIM approvals (pilot-handler.js).
  const handlePilot = createPilotHandler({ send, broadcast });

  // Settings: the ledger validates and persists; every client sees the new values.
  function handleSettings(ws, { payload }) {
    try {
      const settings = ledger.updateSettings(payload);
      const { riskProfiles, strictnessLevels, ...shown } = settings;
      console.log(`[settings] updated: ${JSON.stringify(shown)}`);
      broadcast('SETTINGS_UPDATED', settings);
      // Modes or bankroll changed: refresh what each venue has to trade with.
      publishBrokerState(broadcast, { force: true })
        .catch((err) => console.error('[broker] publish after settings update failed:', err.message));
    } catch (err) {
      console.warn(`[settings] rejected update ${JSON.stringify(payload)}: ${err.message}`);
      send(ws, 'SETTINGS_ERROR', { error: err.message, settings: ledger.getSettings() });
    }
  }

  // Paper reset: destructive, so it needs the typed confirmation word as well.
  function handleReset(ws, { confirm }) {
    if (confirm !== 'RESET') return send(ws, 'LEDGER_RESET', { ok: false, error: 'Type RESET to confirm.' });
    try {
      const r = ledger.resetPaper();
      console.warn(`[ledger] PAPER RESET: removed ${JSON.stringify(r.removed)}; kept LIVE ${JSON.stringify(r.keptLive)}; backup ${r.backupPath}`);
      broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
      broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
      broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
      broadcast('PILOT_ACTIONS', ledger.getPilotActions());
      try { publishIntelligence(broadcast); } catch (err) { console.error('[intel] publish failed:', err.message); }
      publishBrokerState(broadcast, { force: true }).catch(() => {});
      // Only the backup's file name goes to clients, not the server's directory layout.
      return broadcast('LEDGER_RESET', { ok: true, removed: r.removed, keptLive: r.keptLive, backupFile: r.backupPath ? require('path').basename(r.backupPath) : null });
    } catch (err) {
      return send(ws, 'LEDGER_RESET', { ok: false, error: err.message });
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
    if (handlePilot(ws, msg)) return undefined;
    if (msg.type === 'UPDATE_SETTINGS') return handleSettings(ws, msg);
    if (msg.type === 'RUN_SCAN') return handleRunScan(ws);
    if (msg.type === 'RESET_LEDGER') return handleReset(ws, msg);
    if (msg.type === 'CLOSE_POSITION') return handleClose(ws, msg);
    if (msg.type === 'ADOPT_POSITION' || msg.type === 'RELEASE_POSITION') return handleAdoption(ws, msg);
    if (msg.type === 'SAVE_SETUP' || msg.type === 'UNSAVE_SETUP') return handleSaved(ws, msg);
    // News sentiment for one symbol (read-only, cached ~90 min server-side), to the asker only.
    if (msg.type === 'GET_SENTIMENT') return newsSentiment.getSentiment(msg.symbol).then((r) => send(ws, 'NEWS_SENTIMENT', r));
    if (msg.type === 'GET_ADOPTION_SUGGESTIONS') return handleSuggest(ws, msg).catch((err) => console.error('[adopt] suggestions crashed:', err));
    if (msg.type === 'SYNC_PORTFOLIO') return handleSync(ws).catch((err) => console.error('[broker-sync] sync crashed:', err));
    send(ws, 'error', `unknown message type: ${msg.type}`);
  };
}

module.exports = { createMessageHandler };
