// Portfolio-level risk (Phase 77): the risk engine sizes ONE trade; this caps the BOOK.
//   Open-risk ceiling  the dollars at risk across the book's open positions (what their stops would lose),
//                      plus the new setup's, may not pass settings.maxOpenRiskPct (default 6%) of the
//                      bankroll it is sized from. A stop moved up (ratchet / edit) counts only what is still
//                      at risk: dollarRisk x (distance to the stop now / at entry), 0 once it locks profit.
//                      Option spreads count their full dollarRisk (the debit that can be lost).
//   Direction limit    at most settings.maxEquityPerDirection (default 2) bullish and 2 bearish EQUITY trades
//                      (stocks + options; a put spread is bearish) open or staged at once, so the book cannot
//                      pile into one market move (the audit found 8 bearish spreads open together).
// A book is one pool of one account: paper stocks / options, paper crypto, or a LIVE venue's (the positions'
// execution vs the setup's sizing basis). Portfolio Pilot holdings / buys (long-term allocations with their
// own 30% cap), adopted and external holdings, and Manual Trade Ticket orders are outside both rules;
// manual positions still COUNT (they are real risk), they are just never blocked.
const PILOT = 'portfolio-pilot';
const DEFAULTS = { maxOpenRiskPct: 0.06, maxEquityPerDirection: 2 };
const EQUITY = new Set(['stocks', 'options']);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const poolOf = (market) => (market === 'crypto' ? 'crypto' : 'stocks');
const isLive = (x) => x.execution === 'LIVE' || (!!x.sizingBasis && x.sizingBasis !== 'paper' && x.execution !== 'PAPER'); // always a boolean
const holding = (p) => p.strategyId === PILOT || p.adopted || p.execution === 'EXTERNAL' || p.execution === 'BROKER' || p.strategyId === 'adopted-hold';
const manualOrder = (o) => String(o.id).startsWith('manual:');
const sameBook = (a, b) => poolOf(a.market) === poolOf(b.market) && isLive(a) === isLive(b);
const bullish = (x) => x.direction !== 'short';

// Dollars still at risk on one open position (0 for holdings and positions with no stop).
function riskOf(p) {
  if (holding(p) || !(p.dollarRisk > 0)) return 0;
  if (p.market === 'options') return p.dollarRisk;
  const init = Number.isFinite(p.initialStop) ? p.initialStop : p.invalidation;
  const sign = p.direction === 'short' ? -1 : 1;
  const d0 = sign * (p.fillPrice - init);
  const d = sign * (p.fillPrice - p.invalidation);
  return d0 > 0 ? p.dollarRisk * clamp01(d / d0) : p.dollarRisk;
}

const openRisk = (order, positions) => (positions || []).filter((p) => sameBook(order, p) && p.id !== order.id).reduce((s, p) => s + riskOf(p), 0);
const limits = (settings = {}) => ({ maxOpenRiskPct: settings.maxOpenRiskPct > 0 ? settings.maxOpenRiskPct : DEFAULTS.maxOpenRiskPct,
  maxEquityPerDirection: settings.maxEquityPerDirection > 0 ? settings.maxEquityPerDirection : DEFAULTS.maxEquityPerDirection });
const usd = (x) => `$${x.toFixed(2)}`;

// A sized setup (risk-engine result: dollarRisk, market, direction, sizingBasis) against the book.
// ctx: { positions, pending (staging only), bankroll, settings } -> null (allowed) or the rejection reason.
function check(order, { positions = [], pending = [], bankroll, settings } = {}) {
  if (!order || manualOrder(order) || order.strategyId === PILOT) return null;
  const lim = limits(settings);
  if (bankroll > 0) {
    const open = openRisk(order, positions);
    const cap = lim.maxOpenRiskPct * bankroll;
    const add = order.dollarRisk > 0 ? order.dollarRisk : 0;
    if (open + add > cap + 1e-9) {
      return `PORTFOLIO_RISK_CAP: ${usd(open)} already at risk on open trades + ${usd(add)} for this setup = ${((open + add) / bankroll * 100).toFixed(1)}% of the `
        + `${usd(bankroll)} bankroll, over the ${(lim.maxOpenRiskPct * 100).toFixed(1)}% portfolio ceiling (${usd(cap)}); new setups wait until open risk comes down`;
    }
  }
  if (EQUITY.has(order.market)) {
    const side = bullish(order);
    const same = (x) => EQUITY.has(x.market) && sameBook(order, x) && !holding(x) && x.id !== order.id && bullish(x) === side;
    const n = (positions || []).filter(same).length + (pending || []).filter((o) => same(o) && !manualOrder(o)).length;
    if (n >= lim.maxEquityPerDirection) {
      return `DIRECTION_LIMIT: ${n} ${side ? 'bullish' : 'bearish'} equity trade(s) already open or staged (max ${lim.maxEquityPerDirection} per direction); `
        + `a ${side ? 'bullish' : 'bearish'} ${order.asset} setup would pile further into the same market move`;
    }
  }
  return null;
}

// Snapshot for the Journal (PORTFOLIO_RISK): each book's open risk vs its ceiling, and the equity direction counts.
function summary(positions, settings, bankrolls) {
  const lim = limits(settings);
  const books = [];
  for (const [label, probe] of [['Stocks / options (paper)', { market: 'stocks' }], ['Crypto (paper)', { market: 'crypto' }],
    ['Stocks / options (LIVE)', { market: 'stocks', execution: 'LIVE' }], ['Crypto (LIVE)', { market: 'crypto', execution: 'LIVE' }]]) {
    const mine = (positions || []).filter((p) => sameBook(probe, p) && !holding(p));
    if (!mine.length && probe.execution) continue;
    const bankroll = bankrolls[`${poolOf(probe.market)}${probe.execution ? 'Live' : ''}`] || null;
    const risk = mine.reduce((s, p) => s + riskOf(p), 0);
    const eq = mine.filter((p) => EQUITY.has(p.market));
    books.push({ label, open: mine.length, risk, bankroll, pct: bankroll ? risk / bankroll : null, cap: bankroll ? lim.maxOpenRiskPct * bankroll : null,
      ...(probe.market === 'stocks' ? { bullish: eq.filter(bullish).length, bearish: eq.filter((p) => !bullish(p)).length } : {}) });
  }
  return { ...lim, books, at: Date.now() };
}

module.exports = { check, summary, riskOf, openRisk, limits, DEFAULTS, holding, sameBook, manualOrder };
