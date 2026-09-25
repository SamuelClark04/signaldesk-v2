// Venue capital: the bankroll a candidate is sized against, by the venue it
// would execute on (the same routing as message-handler's VENUES).
//   paper venue -> the configured paper bankroll (Settings)
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
async function sizingBankroll(market, settings) {
  const [modeKey, broker] = VENUE_OF[market] || [];
  if (!modeKey || settings[modeKey] !== 'live') {
    return settings.bankroll > 0 ? { ok: true, bankroll: settings.bankroll, basis: 'paper' }
      : { ok: false, reason: 'Invalid bankroll', basis: 'paper' };
  }
  const basis = `${broker}-live`;
  const r = await liveValue(broker);
  if (!r.ok) return { ok: false, reason: `${UNAVAILABLE}: ${r.error}`, basis };
  const external = manualValue();
  return { ok: true, bankroll: r.value + external, accountValue: r.value, externalValue: external, cash: r.cash, basis, fetchedAt: r.fetchedAt };
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
function requiredBasis(market, settings) {
  const [modeKey, broker] = VENUE_OF[market] || [];
  return modeKey && settings[modeKey] === 'live' ? `${broker}-live` : 'paper';
}

const clearCache = () => cache.clear(); // tests / after settings changes

module.exports = { sizingBankroll, requiredBasis, clearCache, UNAVAILABLE, CACHE_MS };
