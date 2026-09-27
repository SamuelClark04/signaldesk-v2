// Broker sync: real holdings from the live broker accounts (Coinbase, Alpaca, Kraken Pro, OKX US),
// mapped to the ledger's open-position shape so the Portfolio tab can list them
// beside SignalDesk's own trades. A read-only SNAPSHOT: it is never written into
// the ledger (the ledger only holds positions SignalDesk itself opened), and it
// changes only when someone presses "Sync Broker".
//
// Position fields added for broker holdings:
//   venue: 'Live Crypto', execution: 'BROKER', costBasis (Coinbase's), brokerValue
//   (USD value at sync), brokerUnrealizedPnl, syncedAt. No stop/targets: exits for
//   these holdings are whatever orders exist at Coinbase.
// Alpaca (stocks, when ALPACA_API_KEY is set): the same shape with broker
// 'Alpaca', venue 'Live Stocks', id alpaca:<SYMBOL>; cash from the account.
const coinbaseApi = require('./coinbase-api');
const krakenApi = require('./kraken-api'); // Phase 69A: Kraken Pro holdings + cash (when KRAKEN_API_KEY is set)
const okxApi = require('./okx-api'); // Phase 69B: OKX US holdings + cash (when OKX_API_KEY is set)
const alpacaApi = require('./alpaca-api');
const { feeModel } = require('../risk/scenarios');

const MIN_GAP_MS = 10000; // manual syncs at most every 10 s
const DUST_USD = 0.01;

// Coinbase sends numbers, or { value, currency } objects with string values.
const num = (x) => {
  const n = Number(x && typeof x === 'object' ? x.value : x);
  return Number.isFinite(n) ? n : null;
};

const NEVER = { ok: false, status: 'never', syncedAt: null, positions: [], cash: null, error: null };
let snapshot = { coinbase: NEVER, alpaca: NEVER, kraken: NEVER, okx: NEVER };
let running = null;
let lastStart = 0;

function mapPosition(p, now) {
  const qty = num(p.total_balance_crypto);
  const avg = num(p.average_entry_price);
  return {
    id: `coinbase:${p.asset}`,
    asset: `${p.asset}-USD`,
    market: 'crypto',
    direction: 'long',
    positionSize: qty,
    fillPrice: avg > 0 ? avg : null, // null: Coinbase has no entry price (e.g. coins transferred in)
    costBasis: num(p.cost_basis),
    invalidation: null,
    targets: [],
    execution: 'BROKER',
    broker: 'Coinbase',
    venue: 'Live Crypto',
    brokerValue: num(p.total_balance_fiat),
    brokerUnrealizedPnl: num(p.unrealized_pnl),
    syncedAt: now,
    openedAt: null,
    feeModel: feeModel('crypto'),
  };
}

async function fetchCoinbase(now) {
  const r = await coinbaseApi.getPortfolioBreakdown().catch((err) => ({ ok: false, error: err.message }));
  if (!r.ok) return { ok: false, status: 'error', syncedAt: now, positions: [], cash: null, error: r.error };
  const spot = r.positions || [];
  const positions = spot.filter((p) => !p.is_cash && num(p.total_balance_crypto) > 0 && (num(p.total_balance_fiat) || 0) >= DUST_USD)
    .map((p) => mapPosition(p, now));
  const cash = spot.filter((p) => p.is_cash).reduce((s, p) => s + (num(p.total_balance_fiat) || 0), 0);
  return { ok: true, status: 'ok', syncedAt: now, portfolio: r.portfolio, positions, cash, error: null };
}

async function fetchAlpaca(now) {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) return { ...NEVER, status: 'not configured' };
  const [pos, acct] = await Promise.all([alpacaApi.getPositions(), alpacaApi.getAccount()]).catch((err) => [{ ok: false, error: err.message }, {}]);
  if (!pos.ok) return { ok: false, status: 'error', syncedAt: now, positions: [], cash: null, error: pos.error };
  const positions = pos.positions.filter((p) => p.qty > 0 && (p.marketValue || 0) >= DUST_USD).map((p) => ({
    id: `alpaca:${p.asset}`, asset: p.asset, market: 'stocks', direction: 'long', positionSize: p.qty, fillPrice: p.avgEntry > 0 ? p.avgEntry : null,
    costBasis: p.costBasis, invalidation: null, targets: [], execution: 'BROKER', broker: 'Alpaca', venue: 'Live Stocks', brokerValue: p.marketValue,
    brokerUnrealizedPnl: p.unrealizedPnl, syncedAt: now, openedAt: null, feeModel: feeModel('stocks') }));
  return { ok: true, status: 'ok', syncedAt: now, environment: pos.environment, positions, cash: acct && acct.ok ? acct.cash : null, error: null };
}

// Kraken Pro (Phase 69A) / OKX US (69B): spot balances at their USD price; neither reports a
// cost basis. OKX's funding-account cash (fundingCash) is shown; only trading cash is spendable.
async function fetchVenue(api, id, broker, now) {
  if (!api.configured()) return { ...NEVER, status: 'not configured' };
  const r = await api.getPortfolioValue().catch((err) => ({ ok: false, error: err.message }));
  if (!r.ok) return { ok: false, status: 'error', syncedAt: now, positions: [], cash: null, error: r.error };
  const positions = r.holdings.filter((h) => h.qty > 0 && h.qty * h.price >= DUST_USD).map((h) => ({
    id: `${id}:${h.asset}`, asset: `${h.asset}-USD`, market: 'crypto', direction: 'long', positionSize: h.qty, fillPrice: null, costBasis: null, invalidation: null, targets: [],
    execution: 'BROKER', broker, venue: 'Live Crypto', brokerValue: h.qty * h.price, brokerUnrealizedPnl: null, syncedAt: now, openedAt: null, feeModel: feeModel(`crypto:${id}`) }));
  return { ok: true, status: 'ok', syncedAt: now, positions, cash: r.cash, fundingCash: r.fundingCash ?? null, error: null };
}

const getSnapshot = () => JSON.parse(JSON.stringify(snapshot));

// Fetches all venues (one sync at a time, at most every MIN_GAP_MS).
// Returns { ok, snapshot } or { ok: false, busy: true, snapshot }.
async function syncPortfolio(now = Date.now()) {
  if (running || now - lastStart < MIN_GAP_MS) return { ok: false, busy: true, snapshot: getSnapshot() };
  lastStart = now;
  running = Promise.all([fetchCoinbase(now), fetchAlpaca(now), fetchVenue(krakenApi, 'kraken', 'Kraken', now), fetchVenue(okxApi, 'okx', 'OKX', now)]);
  try {
    const [coinbase, alpaca, kraken, okx] = await running;
    snapshot = { coinbase, alpaca, kraken, okx };
  } finally {
    running = null;
  }
  const { coinbase: cb, alpaca: al } = snapshot;
  if (cb.ok) console.log(`[broker-sync] Coinbase: ${cb.positions.length} holding(s), cash ${cb.cash.toFixed(2)}`);
  else console.warn(`[broker-sync] Coinbase sync failed: ${cb.error}`);
  if (al.ok) console.log(`[broker-sync] Alpaca: ${al.positions.length} holding(s)`);
  else if (al.status !== 'not configured') console.warn(`[broker-sync] Alpaca sync failed: ${al.error}`);
  for (const [key, name] of [['kraken', 'Kraken'], ['okx', 'OKX']]) {
    const v = snapshot[key];
    if (v.ok) console.log(`[broker-sync] ${name}: ${v.positions.length} holding(s), cash ${v.cash.toFixed(2)}${v.fundingCash > 0 ? `, funding ${v.fundingCash.toFixed(2)}` : ''}`);
    else if (v.status !== 'not configured') console.warn(`[broker-sync] ${name} sync failed: ${v.error}`);
  }
  return { ok: true, snapshot: getSnapshot() };
}

module.exports = { syncPortfolio, getSnapshot, mapPosition, MIN_GAP_MS };
