// Multi-venue crypto waterfall router (Phase 69A; OKX US live in 69B). Every crypto setup / Trade Ticket order goes
// to the CHEAPEST configured venue (crypto-venues.ORDER: OKX US -> Kraken Pro -> Coinbase) that
//   (a) lists the pair (a live / online book: suspended pairs are not listed), and
//   (b) at approval (liveRoute): has the cash for the order + its taker fee IN ONE CURRENCY the
//       pair's books settle in (venue.spendable: OKX ETH-USD takes USD or USDC, an X-USDT book
//       only USDT; Kraken X/USD or X/USDC): separate stablecoin / fiat pools are never summed.
// Staged setups and ticket previews are routed on (a) (preRoute); with crypto LIVE they also skip
// a venue whose last known cash (prepare(): at most one balance call per venue per CASH_TTL_MS)
// cannot fund even the $20 crypto minimum, so a setup is costed on the venue it can really use.
// Coinbase is the last venue and never skipped (the fallback; its own submit reports a short
// balance). A balance that cannot be read skips the venue (never an error for the order). The
// route rides on the order / position: venue + routeVenue, routeMakerFee, routeTakerFee,
// routeReason ("Route: Kraken Pro (0.25%/0.40%)", "Route: Coinbase (not listed on Kraken Pro)"),
// and the cost gate, break-even and net R-multiples use that venue's fees (cost-authority.feeKey).
const venues = require('./crypto-venues');

const CASH_TTL_MS = 30 * 1000;
const MIN_ORDER_USD = 20; // risk-engine MIN_CRYPTO_NOTIONAL: a venue that cannot fund it is not a route
const cashCache = new Map(); // venue id -> { at, value: { ok, cash, balances } | { ok: false, error } }

// A venue's account (cached): { ok, cash (the most one order can spend), balances } | { ok: false, error }.
async function accountOf(id, now = Date.now()) {
  const hit = cashCache.get(id);
  if (hit && now - hit.at < CASH_TTL_MS) return hit.value;
  const a = await Promise.resolve().then(() => venues.VENUES[id].api().getAccount()).catch((err) => ({ ok: false, error: err.message }));
  const value = a && a.ok ? { ok: true, cash: Number.isFinite(a.spendable) ? a.spendable : a.buyingPower, total: a.buyingPower, balances: a.balances || null, fundingCash: a.fundingCash ?? null }
    : { ok: false, error: (a && a.error) || 'no answer' };
  cashCache.set(id, { at: Date.now(), value });
  return value;
}
const cashOf = accountOf;
// What one order of `asset` can spend at venue `id` from account `a` (its books' currencies only).
function spendableFor(id, asset, a) {
  const v = venues.VENUES[id];
  return a.balances && v.spendable ? v.spendable(asset, a.balances) : a.cash;
}

function build(v, skipped) {
  const f = venues.fees(v.id);
  const loud = skipped.filter((s) => !s.quiet).map((s) => s.why);
  return { venue: v.id, label: v.label, broker: v.broker, maker: f.maker, taker: f.taker, skipped: skipped.map((s) => `${s.label}: ${s.why}`),
    reason: `Route: ${v.label} (${loud.length ? loud.join('; ') : venues.feeText(v.id)})` };
}

// Listing (+ with live: the last known cash) only, synchronous: staging and previews.
function preRoute(asset, { live = false } = {}) {
  const skipped = [];
  for (const id of venues.ORDER) {
    const v = venues.VENUES[id];
    if (id === 'coinbase') return build(v, skipped);
    if (!v.configured()) { skipped.push({ label: v.label, why: v.note || 'not configured', quiet: true }); continue; }
    if (!v.lists(asset)) { skipped.push({ label: v.label, why: `not listed on ${v.label}` }); continue; }
    const hit = live && cashCache.get(id);
    const cash = hit && hit.value.ok ? spendableFor(id, asset, hit.value) : null;
    if (cash !== null && cash + 1e-9 < MIN_ORDER_USD * (1 + venues.fees(id).taker)) { skipped.push({ label: v.label, why: `${v.label} cash $${cash.toFixed(2)} < the $${MIN_ORDER_USD} minimum` }); continue; }
    return build(v, skipped);
  }
  return build(venues.VENUES.coinbase, skipped);
}

// Before routing: the venues' pair lists (OKX instruments, Kraken AssetPairs, cached 6 h), so the
// first route after a restart never falls back for want of a list; with live, their cash too.
async function prepare({ live = false } = {}) {
  const ids = ['okx', 'kraken'].filter((id) => venues.VENUES[id].configured());
  const lists = { okx: '../connectors/okx-pairs', kraken: '../connectors/kraken-pairs' };
  await Promise.all(ids.map((id) => require(lists[id]).refresh().catch(() => null)));
  if (live) await Promise.all(ids.map((id) => accountOf(id)));
}

// At approval: listing AND enough cash for `notional` + the taker fee (Coinbase: the fallback).
async function liveRoute(asset, notional) {
  await prepare();
  const skipped = [];
  for (const id of venues.ORDER) {
    const v = venues.VENUES[id];
    if (id === 'coinbase') return build(v, skipped);
    if (!v.configured()) { skipped.push({ label: v.label, why: v.note || 'not configured', quiet: true }); continue; }
    if (!v.lists(asset)) { skipped.push({ label: v.label, why: `not listed on ${v.label}` }); continue; }
    const need = notional * (1 + venues.fees(id).taker);
    const a = await accountOf(id);
    const cash = a.ok ? spendableFor(id, asset, a) : 0;
    if (a.ok && cash + 1e-9 >= need) return build(v, skipped);
    skipped.push({ label: v.label, why: a.ok ? `${v.label} cash $${cash.toFixed(2)} < $${need.toFixed(2)} order` : `${v.label} balance unavailable (${a.error})` });
  }
  return build(venues.VENUES.coinbase, skipped);
}

// The fields a routed order carries (and its position keeps).
const fields = (r) => ({ venue: r.venue, routeVenue: r.venue, routeMakerFee: r.maker, routeTakerFee: r.taker, routeReason: r.reason });

module.exports = { preRoute, liveRoute, prepare, fields, cashOf, accountOf, spendableFor, clearCash: () => cashCache.clear(), CASH_TTL_MS, MIN_ORDER_USD };
