// Venue capital: the bankroll a candidate is sized against, by the venue it
// would execute on (order-router.js; Phase 69A: crypto by its ROUTED venue, crypto-router.js:
// 'coinbase-live', 'kraken-live' or 'okx-live').
//   paper venue -> the market's paper bankroll (Settings: stocks / options, crypto; Phase 70), capped at its paper cash
//   LIVE crypto -> the Coinbase account value: every spot balance incl. USD/USDC
//   LIVE stocks -> the Alpaca account equity (options follow the stock venue)
// Live values are cached for CACHE_MS so a scan over many candidates makes at
// most one call per broker; failures are cached for FAIL_CACHE_MS only.
// FAIL CLOSED: a live venue whose value can't be read returns ok:false, and the
// caller must reject the candidate. It never falls back to the paper bankroll.
// Real equity only (Phase 54): a LIVE venue is sized from that broker account
// + the manual external holdings (Robinhood / other, external-holdings.js), and
// returns its spendable CASH (Coinbase USD + USDC, Alpaca cash): the risk engine
// never sizes a live buy above it (options.cashCap). The paper bankroll never
// enters a live figure.
const coinbaseApi = require('../connectors/coinbase-api');
const alpacaApi = require('../connectors/alpaca-api');

const CACHE_MS = 60 * 1000;
const FAIL_CACHE_MS = 15 * 1000;
const UNAVAILABLE = 'LIVE_CAPITAL_UNAVAILABLE';

const VENUE_OF = { crypto: ['cryptoMode', 'coinbase'], stocks: ['stockMode', 'alpaca'], options: ['stockMode', 'alpaca'] };

const num = (x) => {
  const n = Number(x && typeof x === 'object' ? x.value : x);
  return Number.isFinite(n) ? n : 0;
};

const FETCHERS = {
  // Holdings + cash: the sum of every spot position's USD value (cash rows included).
  async coinbase() {
    const r = await coinbaseApi.getPortfolioBreakdown();
    if (!r.ok) return { ok: false, error: r.error };
    const value = (r.positions || []).reduce((s, p) => s + num(p.total_balance_fiat), 0);
    const cash = (r.positions || []).filter((p) => p.is_cash).reduce((s, p) => s + num(p.total_balance_fiat), 0);
    return value > 0 ? { ok: true, value, cash } : { ok: false, error: 'Coinbase account value is zero' };
  },
  // Phase 69A: Kraken Pro cash (ZUSD + USD + USDC) + every spot holding at its USD price.
  async kraken() {
    const r = await require('../connectors/kraken-api').getPortfolioValue();
    if (!r.ok) return { ok: false, error: r.error };
    return r.value > 0 ? { ok: true, value: r.value, cash: Number.isFinite(r.spendable) ? r.spendable : r.cash } : { ok: false, error: 'Kraken account value is zero' }; // cash one order can use
  },
  // Phase 69B: OKX US trading-account cash (USD + USDC + USDT) + every spot holding at its USD price.
  async okx() {
    const r = await require('../connectors/okx-api').getPortfolioValue();
    if (!r.ok) return { ok: false, error: r.error };
    return r.value > 0 ? { ok: true, value: r.value, cash: Number.isFinite(r.spendable) ? r.spendable : r.cash } : { ok: false, error: 'OKX trading account value is zero' }; // cash one order can use
  },
  async alpaca() {
    const r = await alpacaApi.getAccount();
    if (!r.ok) return { ok: false, error: r.error };
    return r.equity > 0 ? { ok: true, value: r.equity, cash: Math.max(0, r.cash || 0) } : { ok: false, error: 'Alpaca account equity is zero or missing' };
  },
};

const cache = new Map(); // broker -> { at, result }
const inflight = new Map(); // broker -> Promise (one fetch at a time per broker)

async function liveValue(broker, now = Date.now()) {
  const hit = cache.get(broker);
  if (hit && now - hit.at < (hit.result.ok ? CACHE_MS : FAIL_CACHE_MS)) return hit.result;
  if (!inflight.has(broker)) {
    inflight.set(broker, FETCHERS[broker]()
      .catch((err) => ({ ok: false, error: err.message }))
      .then((result) => {
        cache.set(broker, { at: Date.now(), result: { ...result, fetchedAt: Date.now() } });
        inflight.delete(broker);
        if (!result.ok) console.warn(`[venue-capital] ${broker} live account value unavailable: ${result.error}`);
        return cache.get(broker).result;
      }));
  }
  return inflight.get(broker);
}

// { ok: true, bankroll, basis: 'paper'|'coinbase-live'|'alpaca-live', fetchedAt? }
// or { ok: false, reason: 'LIVE_CAPITAL_UNAVAILABLE: <why>', basis }.
// venue: the crypto venue the order is routed to ('okx' / 'kraken'; default Coinbase).
const brokerOf = (market, venue) => (market === 'crypto' && FETCHERS[venue] ? venue : (VENUE_OF[market] || [])[1]);
async function sizingBankroll(market, settings, venue = null) {
  const [modeKey] = VENUE_OF[market] || [];
  const broker = brokerOf(market, venue);
  if (!modeKey || settings[modeKey] !== 'live') return paperCapital(market, settings);
  const basis = `${broker}-live`;
  const r = await liveValue(broker);
  if (!r.ok) return { ok: false, reason: `${UNAVAILABLE}: ${r.error}`, basis };
  const external = manualValue();
  // Phase 70B: LIVE crypto risk is a share of ALL the live crypto equity (Coinbase + Kraken Pro +
  // OKX US: routing only picks where an order executes); the cash cap stays the routed venue's.
  // Another venue that cannot be read now is left out (never fails the order).
  const others = market === 'crypto' ? await otherCryptoValue(broker) : 0;
  return { ok: true, bankroll: r.value + others + external, accountValue: r.value, otherVenuesValue: others, externalValue: external, cash: r.cash, basis, fetchedAt: r.fetchedAt };
}

const CRYPTO_VENUES = { coinbase: () => true, kraken: () => require('../connectors/kraken-api').configured(), okx: () => require('../connectors/okx-api').configured() };
async function otherCryptoValue(broker) {
  const ids = Object.keys(CRYPTO_VENUES).filter((id) => id !== broker && CRYPTO_VENUES[id]());
  const vals = await Promise.all(ids.map((id) => liveValue(id).catch(() => ({ ok: false }))));
  return vals.reduce((sum, v) => sum + (v.ok ? v.value : 0), 0);
}

// Phase 70: PAPER sizing uses the market's own paper pool (stocks / options, or crypto): its
// bankroll, and never more than its paper cash (paper-pools.js), so one pool cannot spend the other's.
function paperCapital(market, settings) {
  const pools = require('../execution/paper-pools');
  const pool = pools.poolOf(market);
  const bankroll = pools.bankrollOf(settings, pool);
  if (!(bankroll > 0)) return { ok: false, reason: 'Invalid bankroll', basis: 'paper' };
  let cash = null;
  try { cash = Math.max(0, pools.cashOf(pool, undefined, settings)); } catch { /* ledger not loaded (tests): no cash cap */ }
  return { ok: true, bankroll, basis: 'paper', pool, ...(Number.isFinite(cash) ? { cash } : {}) };
}

// Market value of the manual external holdings (live price, else last close, else cost).
function manualValue() {
  try {
    const prices = require('../market/latest-prices');
    return require('../execution/external-holdings').positions().filter((p) => p.external === 'manual')
      .reduce((s, p) => s + p.positionSize * (prices.getMarkPrice(p.asset) || p.fillPrice || 0), 0);
  } catch { return 0; }
}

// The basis an order MUST have been sized with to execute on its venue now.
function requiredBasis(market, settings, venue = null) {
  const [modeKey] = VENUE_OF[market] || [];
  return modeKey && settings[modeKey] === 'live' ? `${brokerOf(market, venue)}-live` : 'paper';
}

const clearCache = () => cache.clear(); // tests / after settings changes

module.exports = { sizingBankroll, requiredBasis, clearCache, UNAVAILABLE, CACHE_MS };
