// Options position statistics (Phase 58), from Black-Scholes across every leg,
// each at its own implied volatility. Pure functions; used for new setups (the
// strategy stores them on optionsData.stats), live on open positions (option-marks)
// and by the startup migration of older Phase 57 spreads.
//   Net Greeks      long legs minus short legs: delta (+$ per $1 move per spread),
//                   theta ($ per calendar day per spread), vega ($ per vol point),
//                   gamma. Computed whether or not Alpaca sent Greeks.
//   Expiry breakeven the long strike + debit (calls) / - debit (puts)
//   POP             probability the underlying finishes beyond the breakeven at
//                   expiry (lognormal at the long leg's IV, risk-neutral drift)
//   Max value       the strike width (a vertical), max profit = width - debit
//   Mid-hold        the time when max(1, round(0.65 x DTE)) days remain: where a
//                   swing's T1 is expected to be taken (not at expiry)
const { greeks } = require('./option-greeks');
const { normCdf, RISK_FREE } = require('./option-pricing');
const { expiryMs } = require('../connectors/options-data');

const DAY = 864e5;
const MID_HOLD = 0.65;
const yearsTo = (expiration, at) => Math.max(0, (expiryMs(expiration) - at) / (365 * DAY));
const signOf = (od) => ((od.type || (od.legs[0] && od.legs[0].type)) === 'put' ? -1 : 1);
const multiplier = (od) => od.multiplier || 100;

// Calendar days left at `at` (fractional).
const daysLeft = (od, at) => (expiryMs(od.expiration) - at) / DAY;

// The mid-hold moment: when max(1, round(0.65 x days left now)) days remain.
function midHoldAt(od, now = Date.now()) {
  const left = Math.max(1, Math.round(daysLeft(od, now) * MID_HOLD));
  return Math.max(now, expiryMs(od.expiration) - left * DAY);
}

// Net per-share greeks at underlying S and time `at` (null without IV / time).
function netGreeks(od, S, at = Date.now()) {
  const T = yearsTo(od.expiration, at);
  if (!(T > 0) || !(S > 0)) return null;
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const leg of od.legs || []) {
    const g = greeks(leg.type, S, leg.strike, T, leg.iv > 0 ? leg.iv : od.iv);
    if (!g) return null;
    const k = (leg.side === 'sell' ? -1 : 1) * (leg.ratio || 1);
    for (const key of Object.keys(out)) out[key] += k * g[key];
  }
  return out;
}

const breakeven = (od) => { const long = (od.legs || []).find((l) => l.side === 'buy') || { strike: od.strike }; return long.strike + signOf(od) * od.debit; };

// Probability the underlying is beyond `level` at expiry (calls: above, puts: below).
function pop(od, S, level, at = Date.now()) {
  const T = yearsTo(od.expiration, at);
  const long = (od.legs || []).find((l) => l.side === 'buy');
  const iv = long && long.iv > 0 ? long.iv : od.iv;
  if (!(T > 0 && iv > 0 && S > 0 && level > 0)) return null;
  const d2 = (Math.log(S / level) + (RISK_FREE - (iv * iv) / 2) * T) / (iv * Math.sqrt(T));
  return signOf(od) > 0 ? normCdf(d2) : normCdf(-d2);
}

// Every stat for the Setup / Approval card and the open-position panel.
// hv: the underlying's 20-day realized vol (optional).
function stats(od, S, at = Date.now(), hv = null) {
  const m = multiplier(od);
  const g = netGreeks(od, S, at);
  const be = breakeven(od);
  const width = od.width || (od.shortStrike ? Math.abs(od.shortStrike - od.strike) : null);
  const long = (od.legs || []).find((l) => l.side === 'buy');
  const iv = long && long.iv > 0 ? long.iv : od.iv;
  const p = pop(od, S, be, at);
  return {
    netDelta: g ? g.delta : null, deltaUsd: g ? g.delta * m : null, thetaDay: g ? g.theta * m : null, vegaUsd: g ? g.vega * m : null, gamma: g ? g.gamma : null,
    breakeven: Math.round(be * 100) / 100, breakevenPct: S > 0 ? be / S - 1 : null, pop: p,
    maxValue: width ? width * m : null, maxProfit: width ? (width - od.debit) * m : null, maxProfitPct: width ? (width - od.debit) / od.debit : null,
    iv: iv || null, hv: hv || od.hv20 || null, cheap: iv && (hv || od.hv20) ? iv <= (hv || od.hv20) : null, daysLeft: daysLeft(od, at), at,
  };
}

module.exports = { netGreeks, breakeven, pop, stats, midHoldAt, daysLeft, MID_HOLD };
