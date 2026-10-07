// Crypto waterfall status (Phase 70): the Settings strip "Crypto Waterfall Routing & Broker
// Status". One row per venue in route order (OKX US -> Kraken Pro -> Coinbase):
//   { rank, id, label, status: CONNECTED | NOT CONFIGURED | UNAVAILABLE, cash (the most one
//     order can spend), fundingCash (OKX funding account, not tradable), maker, taker,
//     bePct (round-trip break-even: taker in + taker out), role, error,
//     fee: { verified, source, at (the account read in force), lookupOk, lookupAt, lookupError } (Phase 92) }
// and the venue a standard $20 ETH order would take right now (crypto-router.liveRoute: listing
// + cash), with the reason. Balances come from the router's cache (at most one account call per
// venue per 30 s); read-only, whatever the crypto mode.
const venues = require('./crypto-venues');
const router = require('./crypto-router');
const be = require('../risk/break-even');

const PROBE = { asset: 'ETH-USD', notional: 20 }; // "a standard $20 trade"
const ROLES = {
  okx: 'Primary: majors & listed alts when funded',
  kraken: 'Secondary: mid-caps not on OKX, or when OKX cash < the order',
  coinbase: 'Fallback: micro-cap Moonshots & existing Coinbase positions',
};
const LABELS = { okx: 'OKX US', kraken: 'Kraken Pro', coinbase: 'Coinbase Advanced' };
const coinbaseConfigured = () => !!(process.env.COINBASE_API_KEY && process.env.COINBASE_API_SECRET);
// Where a venue's rates come from (Phase 92): the account read in force + the LATEST lookup (it may have failed since).
function feeProvenance(id) {
  const s = id === 'coinbase' ? require('../connectors/coinbase-fees').status() : require('../connectors/venue-fees').status(id);
  const f = require('../risk/cost-authority').feeInfo(id);
  return { verified: f.verified, source: f.source, at: f.at, lookupOk: s.at ? !!s.ok : null, lookupAt: s.at || null, lookupError: s.ok || !s.at ? null : s.error || null }; // not read yet: null
}

// Break-even move for a round trip at the taker rate both ways (as a fraction of the entry).
const bePct = (key) => { const r = be.exactRate(key, 'taker'); return (1 + r) / (1 - r) - 1; };

async function status() {
  await router.prepare().catch(() => {});
  const rows = await Promise.all(venues.ORDER.map(async (id, i) => {
    const v = venues.VENUES[id];
    const configured = id === 'coinbase' ? coinbaseConfigured() : v.configured();
    const a = configured ? await router.accountOf(id) : null;
    const f = venues.fees(id);
    return { rank: i + 1, id, label: LABELS[id] || v.label, configured, status: !configured ? 'NOT CONFIGURED' : a.ok ? 'CONNECTED' : 'UNAVAILABLE',
      cash: a && a.ok ? router.spendableFor(id, PROBE.asset, a) : null, totalCash: a && a.ok ? a.total : null, fundingCash: a && a.ok ? a.fundingCash : null,
      maker: f.maker, taker: f.taker, bePct: bePct(id === 'coinbase' ? 'crypto' : `crypto:${id}`), fee: feeProvenance(id),
      role: ROLES[id], error: a && !a.ok ? a.error : null };
  }));
  const r = await router.liveRoute(PROBE.asset, PROBE.notional).catch((err) => ({ venue: 'coinbase', label: 'Coinbase', reason: `Route: Coinbase (${err.message})` }));
  return { rows, active: { venue: r.venue, label: LABELS[r.venue] || r.label, reason: r.reason, asset: PROBE.asset, notional: PROBE.notional }, at: Date.now() };
}

module.exports = { status, PROBE, ROLES };
