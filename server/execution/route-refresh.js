// Staged crypto setups follow the waterfall (Phase 70B). A setup is routed and sized when it is
// staged; if the cheapest funded venue changes afterwards (a deposit at OKX US / Kraken Pro, cash
// spent, a pair listed), every pipeline pass re-routes each still-pending crypto setup
// (crypto-router.preRoute: listing + the last known cash) and, when the venue differs, re-sizes it
// on that venue's capital (the risk engine again: fees, caps, the $20 / cash-bound floor) and
// replaces the pending order in place (same id, same staging time). A setup that would not pass on
// the new venue keeps its old route (approval re-routes it anyway, crypto-router.liveRoute).
// Never touched: setups being approved / submitted, Manual Trade Ticket orders, other markets, and
// setups sized for the other mode (a paper-sized setup is never re-sized as a live one).
const cryptoRouter = require('./crypto-router');
const cryptoVenues = require('./crypto-venues');
const { sizingBankroll } = require('../risk/venue-capital');
const { processCandidate } = require('../risk/risk-engine');

// Returns [{ id, from, to, reason }] for each setup re-routed.
async function refreshRoutes(ledger, settings, { live = settings.cryptoMode === 'live', isBusy = () => false } = {}) {
  const out = [];
  const sizedForMode = (o) => (live ? /-live$/.test(o.sizingBasis || '') : (o.sizingBasis || 'paper') === 'paper'); // never promotes paper sizing to live
  const pending = ledger.getPendingOrders().filter((o) => o.market === 'crypto' && o.status === 'pending' && !o.submittingAt && !o.manual && !isBusy(o.id) && sizedForMode(o));
  if (pending.length) await cryptoRouter.prepare({ live }).catch(() => {}); // pair lists + venue cash (cached 30 s)
  for (const o of pending) {
    const r = cryptoRouter.preRoute(o.asset, { live });
    const from = cryptoVenues.idOf(o);
    if (r.venue === from) continue;
    const capital = await sizingBankroll('crypto', settings, r.venue);
    if (!capital.ok) continue;
    const s = processCandidate({ ...o, ...cryptoRouter.fields(r) }, capital.bankroll, { riskPct: settings.riskPct, maxCapitalPct: settings.maxCapitalPct, sizingBasis: capital.basis, cashCap: capital.cash });
    if (!s.approved) { console.log(`[route] ${o.id}: stays on ${from} (${r.label}: ${s.reason})`); continue; }
    if (!ledger.replacePending(o.id, s)) continue;
    console.warn(`[route] ${o.id}: re-routed ${from} -> ${r.venue} (${r.reason}); ${o.positionSize} -> ${s.positionSize} ($${s.notional.toFixed(2)})`);
    out.push({ id: o.id, from, to: r.venue, reason: r.reason });
  }
  return out;
}

module.exports = { refreshRoutes };
