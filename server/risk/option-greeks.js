// Local Black-Scholes greeks and implied volatility: the fallback when Alpaca's
// indicative options feed omits greeks.delta or impliedVolatility for a contract
// (connectors/options-data.js). IV is solved from the real quote's MID by
// bisection (always converges: the call/put value is monotonic in volatility),
// then Delta, Gamma, Theta (per calendar day) and Vega (per 1 vol point) follow
// from the closed form at that IV. Pure functions; European exercise (US equity
// calls without a dividend inside the window are priced the same).
const { blackScholes, normCdf, RISK_FREE } = require('./option-pricing');

const normPdf = (x) => Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
const IV_MIN = 0.01;
const IV_MAX = 5;

// { delta, gamma, theta, vega } per share. T in years, iv as a fraction.
function greeks(type, S, K, T, iv, r = RISK_FREE) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return null;
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * T) / (iv * sq);
  const d2 = d1 - iv * sq;
  const disc = K * Math.exp(-r * T);
  const gamma = normPdf(d1) / (S * iv * sq);
  const vega = (S * normPdf(d1) * sq) / 100;
  const decay = -(S * normPdf(d1) * iv) / (2 * sq);
  if (type === 'put') return { delta: normCdf(d1) - 1, gamma, theta: (decay + r * disc * normCdf(-d2)) / 365, vega };
  return { delta: normCdf(d1), gamma, theta: (decay - r * disc * normCdf(d2)) / 365, vega };
}

// Volatility at which Black-Scholes matches `price`, or null (price outside the
// no-arbitrage range, e.g. below intrinsic value).
function impliedVol(price, type, S, K, T, r = RISK_FREE) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  let lo = IV_MIN;
  let hi = IV_MAX;
  if (price < blackScholes(type, S, K, T, lo, r) - 1e-9 || price > blackScholes(type, S, K, T, hi, r)) return null;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (blackScholes(type, S, K, T, mid, r) > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// Change in option value for an underlying move dS: the Delta-Gamma
// approximation Delta x dS + 0.5 x Gamma x dS^2 (System 5's stop and target maths).
const deltaGamma = (delta, gamma, dS) => delta * dS + 0.5 * (gamma || 0) * dS * dS;

// The move dS (same sign as `change`) whose Delta-Gamma change equals `change`:
// the root of 0.5 G dS^2 + D dS - change = 0 nearest the linear answer change/D.
function moveFor(change, delta, gamma) {
  if (!(Math.abs(delta) > 1e-6)) return null;
  const linear = change / delta;
  if (!(gamma > 0)) return linear;
  const disc = delta * delta + 2 * gamma * change;
  if (disc < 0) return linear; // the curve never falls that far: first-order answer
  const roots = [(-delta + Math.sqrt(disc)) / gamma, (-delta - Math.sqrt(disc)) / gamma];
  return roots.reduce((best, x) => (Math.abs(x - linear) < Math.abs(best - linear) ? x : best));
}

module.exports = { greeks, impliedVol, deltaGamma, moveFor, normPdf };
