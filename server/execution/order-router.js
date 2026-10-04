// Order routing (Phase 67, out of message-handler.js): the guarded APPROVE / REJECT
// actions and the per-order in-flight lock. The client only sends intents; the order
// guard runs first, then the order is routed by its market's mode (paper / LIVE).
const ledger = require('./paper-ledger');
const { validateApproval, stackingConflict } = require('./order-guard');
const portfolioRisk = require('../risk/portfolio-risk'); // Phase 77
const entryShields = require('../risk/entry-shields'); // Phase 81
const prices = require('../market/latest-prices');
const { recordRejection } = require('./rejection-stats');
const { requiredBasis, sizingBankroll } = require('../risk/venue-capital');
const { resizeOrder, processCandidate } = require('../risk/risk-engine');
const cryptoRouter = require('./crypto-router'); // Phase 69A: OKX -> Kraken -> Coinbase
const cryptoVenues = require('./crypto-venues');
const alpacaApi = require('../connectors/alpaca-api');
const coinbaseApi = require('../connectors/coinbase-api');
const coinbaseSocket = require('../connectors/coinbase-socket');
const paperLock = require('../risk/paper-lock'); // Phase 91: no LIVE entry while locked

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
  if (!liveSized || (r.venue === staged && order.sizingBasis === `${r.venue}-live` && !r.fit)) return { venue, order, resized: null }; // fit: trimmed to the cash (70B)
  const capital = await sizingBankroll('crypto', settings, r.venue);
  const s = capital.ok ? processCandidate({ ...order, ...cryptoRouter.fields(r) }, capital.bankroll, { riskPct: settings.riskPct, maxCapitalPct: settings.maxCapitalPct, sizingBasis: capital.basis, cashCap: capital.cash })
    : { approved: false, reason: capital.reason };
  if (!s.approved && staged === 'coinbase' && order.sizingBasis === 'coinbase-live') { // Phase 70B: sized for Coinbase already: keep it there
    console.warn(`[LIVE] ${order.id}: ${v.label} could not take it (${s.reason}); sent to Coinbase as staged`);
    return routeCrypto.coinbase(order, `Route: Coinbase (${v.label}: ${s.reason})`);
  }
  if (!s.approved) throw new Error(`ROUTE_CHANGED: ${r.reason}; re-sized for ${v.label}: ${s.reason}`);
  // The user's Trade Amount ($) is kept on the new venue (re-applied by the risk engine).
  const z = order.amountOverride ? resizeOrder(s, order.notional || order.positionSize * order.entryPrice, { confirmed: true }) : s;
  if (!z.approved) throw new Error(`ROUTE_CHANGED: ${r.reason}; the Trade Amount on ${v.label}: ${z.reason}`);
  console.warn(`[LIVE] ${order.id}: re-routed ${staged} -> ${r.venue} (${r.reason}); re-sized ${order.positionSize} -> ${z.positionSize}`);
  return { venue, order: z, resized: z };
}

// The Coinbase venue for an order kept on it (a cheaper venue could not take it).
routeCrypto.coinbase = (order, reason) => {
  const f = cryptoVenues.fees('coinbase');
  const route = { venue: 'coinbase', label: 'Coinbase', broker: 'Coinbase', maker: f.maker, taker: f.taker, skipped: [], reason };
  return { venue: { modeKey: 'cryptoMode', broker: 'Coinbase', venueId: 'coinbase', route, api: { submitOrder: (...a) => coinbaseApi.submitOrder(...a) } }, order, resized: null };
};

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
  const paper = settings[venue.modeKey] === 'paper' || order.forcePaper; // forcePaper: a manual PAPER ticket (manual-trade.js)
  if (!paper) paperLock.assertPaperEntry(`${order.market} ${order.asset} at ${venue.broker}`); // Phase 91: refused before any broker call (stays pending)
  if (order.strategyId === 'options-quickflips' && !paper) throw new Error('QUICKFLIPS_PAPER_ONLY: Options Quick Flips trade on paper only; nothing was sent');
  if (paper) {
    const ap = require('./alpaca-paper'); // Phase 71: paper stocks / options execute at Alpaca Paper
    if (order.market !== 'crypto' && ap.enabled(settings)) return ap.open(ledger, order, livePrice, resized);
    return require('./paper-fills').fill(ledger, order, livePrice, resized); // Phase 89: crypto at the ask + taker, options at natural
  }
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
  if (order.market === 'stocks') { // Phase 73: a connected but unfunded Alpaca Live account: refused with a clear reason, nothing sent
    const a = await alpacaApi.getAccount();
    if (a.ok && !(a.buyingPower > 0)) throw new Error('LIVE_NO_BUYING_POWER: Alpaca Live has $0 buying power. Fund the account, or switch Alpaca mode to Paper in Settings; nothing was sent');
  }

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
      ...(result.oco !== undefined ? { brokerOco: !!result.oco } : {}), // 70E: T1 rests at OKX (OCO)
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
  // Phase 77: the book's open-risk ceiling / equity direction limit, again at approval (other trades may have opened).
  // Phase 81: + the entry shields (kill switch, macro blackout, sector cap); like the book limits, a shielded setup stays pending.
  entryShields.refresh(ledger, ledger.getSettings());
  const book = (o) => portfolioRisk.check(o, { positions: ledger.getActivePositions(), bankroll: o.sizingBankroll, settings: ledger.getSettings() })
    || entryShields.check(o, { positions: ledger.getActivePositions(), journal: ledger.getTradeJournal(), settings: ledger.getSettings() }); // entries only: no waiting setups
  const heat = stack ? null : book(order);
  const check = stack || heat ? { valid: false, reason: stack || heat } : validateApproval(order, livePrice);
  if (check.valid && amount !== undefined && amount !== null) {
    const paper = ledger.getSettings()[VENUES[order.market].modeKey] === 'paper';
    const resized = resizeOrder(order, amount, { confirmed: confirmed === true, fractional: paper && order.market === 'stocks' });
    if (!resized.approved) throw new Error(resized.reason);
    const heat2 = book(resized);
    if (heat2) throw new Error(heat2); // a bigger trade amount would pass the ceiling: the setup stays pending
    console.log(`[ledger] APPROVE ${id}: trade amount $${Number(amount).toFixed(2)} -> ${resized.positionSize} (was ${order.positionSize}), risk $${resized.dollarRisk.toFixed(2)}`);
    return routeApproved(resized, livePrice);
  }
  if (check.valid) return routeApproved(order, livePrice);
  // A missing price is a data gap, not a verdict on the setup: leave it pending.
  if (check.reason !== 'NO_LIVE_PRICE' && !heat) { // a book limit is temporary (close a trade, then approve): it stays pending
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
