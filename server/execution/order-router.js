// Order routing (Phase 67, out of message-handler.js): the guarded APPROVE / REJECT
// actions and the per-order in-flight lock. The client only sends intents; the order
// guard runs first, then the order is routed by its market's mode (paper / LIVE).
const ledger = require('./paper-ledger');
const { validateApproval, stackingConflict } = require('./order-guard');
const prices = require('../market/latest-prices');
const { recordRejection } = require('./rejection-stats');
const { requiredBasis, sizingBankroll } = require('../risk/venue-capital');
const { resizeOrder, processCandidate } = require('../risk/risk-engine');
const cryptoRouter = require('./crypto-router'); // Phase 69A: OKX -> Kraken -> Coinbase
const cryptoVenues = require('./crypto-venues');
const alpacaApi = require('../connectors/alpaca-api');
const coinbaseApi = require('../connectors/coinbase-api');
const coinbaseSocket = require('../connectors/coinbase-socket');

// Execution venue per market: which mode setting governs it, and which broker
// connector places LIVE orders. Options have no live path yet: the contract and
// premium are real (options-data.js), but no option order routing exists, and a
// stock bracket on the underlying would buy SHARES.
const VENUES = {
  stocks: { modeKey: 'stockMode', broker: 'Alpaca', api: alpacaApi },
  options: { modeKey: 'stockMode', broker: 'Alpaca', api: null },
  crypto: { modeKey: 'cryptoMode', broker: 'Coinbase', api: coinbaseApi }, // Phase 69A: the ROUTED venue's (routeCrypto)
};

// Phase 69A: a LIVE crypto order goes to the cheapest venue that lists it AND has the cash now
// (crypto-router.liveRoute). A venue other than the one it was staged / sized on re-sizes it on
// that venue's account (the risk engine again, same id), keeping a Trade Amount the user set.
async function routeCrypto(order, settings, livePrice) {
  const r = await cryptoRouter.liveRoute(order.asset, order.positionSize * livePrice);
  const staged = cryptoVenues.idOf(order);
  const v = cryptoVenues.VENUES[r.venue];
  const venue = { modeKey: 'cryptoMode', broker: v.broker, venueId: r.venue, route: r,
    api: { submitOrder: (...a) => (r.venue === 'coinbase' ? coinbaseApi.submitOrder(...a) : v.orders().submitOrder(...a)) } };
  // Same venue and sized from its live account: sent as staged. Sized from another venue's live
  // account (re-routed: cash moved, a pair listed / delisted): re-sized here. Sized from paper:
  // left as it is, so the SIZED_FOR_OTHER_VENUE check below refuses it (never auto-promoted).
  const liveSized = /-live$/.test(order.sizingBasis || '');
  if (!liveSized || (r.venue === staged && order.sizingBasis === `${r.venue}-live`)) return { venue, order, resized: null };
  const capital = await sizingBankroll('crypto', settings, r.venue);
  if (!capital.ok) throw new Error(capital.reason);
  const s = processCandidate({ ...order, ...cryptoRouter.fields(r) }, capital.bankroll, { riskPct: settings.riskPct, maxCapitalPct: settings.maxCapitalPct, sizingBasis: capital.basis, cashCap: capital.cash });
  if (!s.approved) throw new Error(`ROUTE_CHANGED: ${r.reason}; re-sized for ${v.label}: ${s.reason}`);
  // The user's Trade Amount ($) is kept on the new venue (re-applied by the risk engine).
  const z = order.amountOverride ? resizeOrder(s, order.notional || order.positionSize * order.entryPrice, { confirmed: true }) : s;
  if (!z.approved) throw new Error(`ROUTE_CHANGED: ${r.reason}; the Trade Amount on ${v.label}: ${z.reason}`);
  console.warn(`[LIVE] ${order.id}: re-routed ${staged} -> ${r.venue} (${r.reason}); re-sized ${order.positionSize} -> ${z.positionSize}`);
  return { venue, order: z, resized: z };
}

// Route a guard-approved order by its venue's mode (`order` may be the user's
// resized copy: risk-engine.js resizeOrder, same id, a new quantity).
//   paper: fill in the paper ledger.
//   live:  submit to the broker first; only an ACCEPTED order is recorded in the
//          ledger (tagged execution LIVE + brokerId). A failed submit leaves the
//          order pending and nothing is filled anywhere.
async function routeApproved(order, livePrice) {
  let venue = VENUES[order.market];
  if (!venue) throw new Error(`no execution venue for market "${order.market}"`);
  const settings = ledger.getSettings();
  let resized = order.amountOverride ? order : null;
  if (settings[venue.modeKey] === 'paper' || order.forcePaper) return ledger.executeOrder(order.id, livePrice, {}, resized); // forcePaper: a manual PAPER ticket (manual-trade.js)
  if (!venue.api) throw new Error('LIVE_OPTIONS_UNSUPPORTED');
  if (order.market === 'crypto') {
    const rc = await routeCrypto(order, settings, livePrice);
    ({ venue } = rc);
    if (rc.resized) { order = rc.resized; resized = rc.resized; }
  }
  // A LIVE order must have been sized from that live account. One staged while
  // the venue was on paper (or before this check existed) is refused, never sent.
  const needed = requiredBasis(order.market, settings, venue.venueId);
  if (order.sizingBasis !== needed) throw new Error(`SIZED_FOR_OTHER_VENUE: sized from ${order.sizingBasis || 'the paper bankroll'}, venue needs ${needed}`);

  console.warn(`[LIVE] submitting ${order.direction} ${order.positionSize} ${order.asset} to ${venue.broker} (${order.id})`);
  const tick = order.market === 'crypto' ? coinbaseSocket.getLatest()[order.asset] : null; // best bid for a post-only limit entry
  ledger.markSubmitting(order.id, Date.now()); // Phase 68 (P1-5): saved BEFORE the broker call, so a crash here is recoverable at boot
  const result = await venue.api.submitOrder(order, order.positionSize, livePrice, { bid: tick && tick.bid, ask: tick && tick.ask });
  if (!result.ok && !result.uncertain) ledger.markSubmitting(order.id, null);
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
      fillEstimated: true, // the broker's actual fill price is not fetched yet
      ...(result.entryType ? { brokerEntryType: result.entryType, limitPrice: result.limitPrice } : {}), ...(result.product ? { brokerProduct: result.product } : {}),
      ...(venue.route ? cryptoRouter.fields(venue.route) : {}), // Phase 69A: venue 'okx' | 'kraken' | 'coinbase' + the route taken
    }, resized);
  } catch (err) {
    // The broker holds a real position the ledger could not record. Never silent.
    console.error(`[LIVE] CRITICAL: ${venue.broker} order ${result.brokerId} was placed for ${order.id} `
      + `but the ledger could not record it (${err.message}). Reconcile manually in ${venue.broker}.`);
    throw new Error(`LIVE_UNRECORDED: ${venue.broker} order ${result.brokerId} placed but not recorded; check ${venue.broker}`);
  }
}

// Guarded approval: the order guard runs first whatever the venue, then the order
// is routed by its market's mode. Failed guards retire the setup with a reason.
// amount: the user's Trade Amount ($) for this order (Setups / Approvals); the
// risk engine re-sizes it (fractional shares on paper only: live Alpaca brackets
// need whole shares). An invalid amount leaves the order pending.
async function approveWithGuard(id, { amount, confirmed } = {}) {
  const order = ledger.getPendingOrders().find((o) => o.id === id);
  if (!order) throw new Error(`no pending order ${id}`);
  const livePrice = prices.getLatestPrice(order.asset);
  const stack = stackingConflict(order, ledger.getActivePositions()); // Phase 68: e.g. a Pilot rotation into a coin already held
  const check = stack ? { valid: false, reason: stack } : validateApproval(order, livePrice);
  if (check.valid && amount !== undefined && amount !== null) {
    const paper = ledger.getSettings()[VENUES[order.market].modeKey] === 'paper';
    const resized = resizeOrder(order, amount, { confirmed: confirmed === true, fractional: paper && order.market === 'stocks' });
    if (!resized.approved) throw new Error(resized.reason);
    console.log(`[ledger] APPROVE ${id}: trade amount $${Number(amount).toFixed(2)} -> ${resized.positionSize} (was ${order.positionSize}), risk $${resized.dollarRisk.toFixed(2)}`);
    return routeApproved(resized, livePrice);
  }
  if (check.valid) return routeApproved(order, livePrice);
  // A missing price is a data gap, not a verdict on the setup: leave it pending.
  if (check.reason !== 'NO_LIVE_PRICE') {
    ledger.discardOrder(id);
    recordRejection(id, check.reason, order);
  }
  throw new Error(check.reason);
}

const QUEUE_ACTIONS = {
  APPROVE: (id, msg) => approveWithGuard(id, msg),
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

module.exports = { routeApproved, approveWithGuard, QUEUE_ACTIONS, VENUES, inFlight, isBusy: (id) => inFlight.has(id) }; // isBusy: expiry-sweeper.js
