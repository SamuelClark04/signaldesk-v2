// Option valuation for previews, marks and paper exits. Pure functions.
// Positions carry their contract's real data (strike, expiration, implied
// volatility, the bid/ask spread and mid seen at selection, and the underlying
// price then: refSpot/refMid/refAt). Between quotes, the value is ANCHORED to
// that real quote: real mid + (Black-Scholes at S now - Black-Scholes at
// refSpot then), at the real IV. So the model only supplies the CHANGE from a
// real price, and matches the real mid exactly at the moment it was quoted.
// A sale is assumed to fill half the spread under the mid (i.e. at the bid).
// With no IV/expiration (older positions) a leg falls back to intrinsic value.
const { expiryMs } = require('../connectors/options-data');

const RISK_FREE = 0.04;
const YEAR_MS = 365 * 864e5;

// Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7).
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Black-Scholes value per share. T in years, iv as a fraction (0.25 = 25%).
function blackScholes(type, S, K, T, iv, r = RISK_FREE) {
  const intrinsic = type === 'put' ? Math.max(0, K - S) : Math.max(0, S - K);
  if (!(T > 0) || !(iv > 0) || !(S > 0) || !(K > 0)) return intrinsic;
  const v = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * T) / v;
  const d2 = d1 - v;
  const value = type === 'put'
    ? K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1)
    : S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return Math.max(intrinsic * Math.exp(-r * T), value);
}

const yearsLeft = (od, at) => (od && od.expiration ? Math.max(0, (expiryMs(od.expiration) - at) / YEAR_MS) : 0);
const modelled = (od) => !!(od && od.expiration && od.iv > 0);

// Raw model value per share of the whole position (all legs) at underlying S.
// Each leg at its own IV when it has one (vertical spreads), else the position's.
function rawModel(od, S, at) {
  const T = yearsLeft(od, at);
  return (od.legs || []).reduce((sum, leg) => {
    const v = modelled(od) ? blackScholes(leg.type, S, leg.strike, T, leg.iv > 0 ? leg.iv : od.iv) : (leg.type === 'put' ? Math.max(0, leg.strike - S) : Math.max(0, S - leg.strike));
    return sum + (leg.side === 'sell' ? -1 : 1) * (leg.ratio || 1) * v;
  }, 0);
}

// Mid value per share at underlying S and time `at`, anchored to the real quote.
function modelMid(od, S, at = Date.now()) {
  const raw = rawModel(od, S, at);
  if (!(od.refMid > 0 && od.refSpot > 0 && od.refAt > 0)) return raw;
  return Math.max(0, od.refMid + raw - rawModel(od, od.refSpot, od.refAt));
}

// What selling the position would fetch per share at underlying S: the mid
// less half the entry spread (the bid side; for a spread, half the net
// bid/ask), never below zero.
function exitValue(od, S, at = Date.now()) {
  const half = modelled(od) && od.spread > 0 ? od.spread / 2 : 0;
  return Math.max(0, modelMid(od, S, at) - half);
}

module.exports = { normCdf, blackScholes, modelMid, exitValue, modelled, RISK_FREE };
