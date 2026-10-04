// Cross-market exposure limits (Phase 89), entry shields on NEW automated entries only (entry-shields.js: staging and approval).
//   COMBINED_RISK_CAP     PAPER book: open risk across BOTH paper pools (stocks / options + crypto: portfolio-risk.riskOf, option
//                         positions at their whole debit) plus the new setup's may not pass settings.maxOpenRiskPct of the COMBINED
//                         paper bankrolls (bankroll + cryptoBankroll). The per-pool rule (portfolio-risk.js) still applies; this
//                         stops options and crypto each filling their own ceiling at the same time. No new number: the existing
//                         maxOpenRiskPct is used until account-specific limits are agreed. (LIVE: options cannot trade live, so
//                         the live crypto venue rule in portfolio-risk.js already is the whole live book.)
//   MAX_OPEN_POSITIONS    settings.maxOpenPositions (0 = off, the default) automated positions open + staged per book (paper / live,
//                         every market). Manual, Pilot and adopted / external holdings are outside both (they still count as risk).
const { riskOf, holding, manualOrder } = require('./portfolio-risk');

const isLive = (x) => x.execution === 'LIVE' || x.execution === 'EXTERNAL' || x.execution === 'BROKER'
  || (!!x.sizingBasis && x.sizingBasis !== 'paper' && x.execution !== 'PAPER');
const usd = (x) => `$${x.toFixed(2)}`;
const automated = (x) => x && !manualOrder(x) && !holding(x);

function combinedReason(order, positions, settings) {
  if (isLive(order)) return null;
  const bank = (Number(settings.bankroll) || 0) + (Number(settings.cryptoBankroll) || 0);
  const pct = settings.maxOpenRiskPct > 0 ? settings.maxOpenRiskPct : 0.06;
  if (!(bank > 0)) return null;
  const open = positions.filter((p) => !isLive(p) && p.id !== order.id).reduce((s, p) => s + riskOf(p), 0);
  const add = order.market === 'options' ? riskOf(order) : order.dollarRisk > 0 ? order.dollarRisk : 0;
  if (!(add > 0) || open + add <= pct * bank + 1e-9) return null;
  return `COMBINED_RISK_CAP: ${usd(open)} at risk across paper options, stocks and crypto + ${usd(add)} for this setup = ${(((open + add) / bank) * 100).toFixed(1)}% `
    + `of the combined ${usd(bank)} paper bankrolls, over the ${(pct * 100).toFixed(1)}% ceiling; new setups wait until open risk comes down`;
}

function positionsReason(order, positions, pending, settings) {
  const max = Number.isInteger(settings.maxOpenPositions) ? settings.maxOpenPositions : 0;
  if (!(max > 0)) return null;
  const live = isLive(order);
  const mine = (x) => automated(x) && x.id !== order.id && isLive(x) === live;
  const n = positions.filter(mine).length + pending.filter(mine).length;
  if (n < max) return null;
  return `MAX_OPEN_POSITIONS: ${n} automated ${live ? 'live' : 'paper'} trade(s) already open or staged (max ${max}); a new setup waits until one closes`;
}

// -> null (allowed) or the rejection reason. ctx: { positions, pending, settings }
function check(order, { positions = [], pending = [], settings = {} } = {}) {
  if (!automated(order)) return null;
  return combinedReason(order, positions, settings) || positionsReason(order, positions, pending, settings);
}

module.exports = { check, combinedReason, positionsReason };
