// Multi-venue crypto waterfall router (Phase 69A; OKX US live in 69B). Every crypto setup / Trade Ticket order goes
// to the CHEAPEST configured venue (crypto-venues.ORDER: OKX US -> Kraken Pro -> Coinbase) that
//   (a) lists the pair, and
//   (b) at approval (liveRoute): has the spendable USD / USDC for the order + its taker fee.
// Staged setups and ticket previews are routed on (a) alone (preRoute): no balance call per scan.
// Coinbase is the last venue and never skipped (the fallback; its own submit reports a short
// balance). The route rides on the order / position: venue + routeVenue, routeMakerFee,
// routeTakerFee, routeReason ("Route: Kraken Pro (0.25%/0.40%)", "Route: Coinbase (not listed on
// Kraken Pro)"), and the cost gate, break-even and net R-multiples use that venue's fees
// (cost-authority.feeKey).
const venues = require('./crypto-venues');

const CASH_TTL_MS = 30 * 1000;
const cashCache = new Map(); // venue id -> { at, value: { ok, cash } | { ok: false, error } }

async function cashOf(id, now = Date.now()) {
  const hit = cashCache.get(id);
  if (hit && now - hit.at < CASH_TTL_MS) return hit.value;
  const a = await venues.VENUES[id].api().getAccount().catch((err) => ({ ok: false, error: err.message }));
  const value = a.ok ? { ok: true, cash: Number.isFinite(a.spendable) ? a.spendable : a.buyingPower } : { ok: false, error: a.error }; // one order pays in one currency
  cashCache.set(id, { at: Date.now(), value });
  return value;
}

function build(v, skipped) {
  const f = venues.fees(v.id);
  const loud = skipped.filter((s) => !s.quiet).map((s) => s.why);
  return { venue: v.id, label: v.label, broker: v.broker, maker: f.maker, taker: f.taker, skipped: skipped.map((s) => `${s.label}: ${s.why}`),
    reason: `Route: ${v.label} (${loud.length ? loud.join('; ') : venues.feeText(v.id)})` };
}

// Listing only (staging, previews): the first configured venue that lists `asset`.
function preRoute(asset) {
  const skipped = [];
  for (const id of venues.ORDER) {
    const v = venues.VENUES[id];
    if (!v.configured()) { skipped.push({ label: v.label, why: v.note || 'not configured', quiet: true }); continue; }
    if (!v.lists(asset)) { skipped.push({ label: v.label, why: `not listed on ${v.label}` }); continue; }
    return build(v, skipped);
  }
  return build(venues.VENUES.coinbase, skipped);
}

// The venues' pair lists loaded (OKX's instruments, Kraken's AssetPairs, cached 6 h): before any
// routing, so the first route after a restart never falls back for want of a list.
async function prepare() {
  await Promise.all([
    venues.VENUES.okx.configured() ? require('../connectors/okx-pairs').refresh() : null,
    venues.VENUES.kraken.configured() ? require('../connectors/kraken-pairs').refresh() : null,
  ]);
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
    const c = await cashOf(id);
    if (c.ok && c.cash + 1e-9 >= need) return build(v, skipped);
    skipped.push({ label: v.label, why: c.ok ? `${v.label} cash $${c.cash.toFixed(2)} < $${need.toFixed(2)} order` : `${v.label} balance unavailable (${c.error})` });
  }
  return build(venues.VENUES.coinbase, skipped);
}

// The fields a routed order carries (and its position keeps).
const fields = (r) => ({ venue: r.venue, routeVenue: r.venue, routeMakerFee: r.maker, routeTakerFee: r.taker, routeReason: r.reason });

module.exports = { preRoute, liveRoute, prepare, fields, cashOf, clearCash: () => cashCache.clear(), CASH_TTL_MS };
