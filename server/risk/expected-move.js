// Expected Move and IV context for System 5 (5-options-system.js). Pure functions.
//   Expected Move  (ATM call mid + ATM put mid) x 0.85, from the REAL chain at one
//                  expiration: the market's own priced 1-sd range to that date
//                  (the straddle overstates it by ~15-20%, hence the 0.85).
//   IV percentile  PROXY: Alpaca serves no implied-volatility history, so the
//                  percentile compares today's ATM IV with a year of the stock's
//                  own 20-day REALIZED volatility (daily closes): the share of
//                  days whose realized vol sat below today's IV. Above 80 =
//                  options are expensive vs how the stock actually moves. It is
//                  labelled a proxy wherever it is shown.
const EM_FACTOR = 0.85;
const HV_WINDOW = 20;
const TRADING_DAYS = 252;

// calls / puts: contract records (options-data.js) at `expiration`.
// { ok, em, pct, strike, callMid, putMid, iv } or { ok:false, error }.
function expectedMove(calls, puts, spot, expiration) {
  const byStrike = (list) => new Map(list.filter((c) => c.expiration === expiration && c.mid > 0).map((c) => [c.strike, c]));
  const C = byStrike(calls);
  const P = byStrike(puts);
  const both = [...C.keys()].filter((k) => P.has(k));
  if (!both.length) return { ok: false, error: `no ATM call + put pair quoted for ${expiration}` };
  const strike = both.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), both[0]);
  const call = C.get(strike);
  const put = P.get(strike);
  const em = (call.mid + put.mid) * EM_FACTOR;
  const ivs = [call.iv, put.iv].filter((x) => x > 0);
  return { ok: true, em, pct: em / spot, strike, callMid: call.mid, putMid: put.mid, expiration,
    iv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null };
}

// Annualised 20-day realized volatility series from daily closes (oldest first).
function realizedVols(bars, n = HV_WINDOW) {
  const r = [];
  for (let i = 1; i < bars.length; i += 1) if (bars[i].close > 0 && bars[i - 1].close > 0) r.push(Math.log(bars[i].close / bars[i - 1].close));
  const out = [];
  for (let i = n; i <= r.length; i += 1) {
    const w = r.slice(i - n, i);
    const mean = w.reduce((a, b) => a + b, 0) / n;
    out.push(Math.sqrt((w.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) * TRADING_DAYS));
  }
  return out;
}

// { ok, pct (0-100), samples, hvNow } or { ok:false, error }.
function ivPercentile(atmIv, dailyBars) {
  if (!(atmIv > 0)) return { ok: false, error: 'no ATM implied volatility' };
  const hv = realizedVols(dailyBars || []);
  if (hv.length < 60) return { ok: false, error: `only ${hv.length} days of realized-vol history` };
  return { ok: true, pct: (hv.filter((v) => v < atmIv).length / hv.length) * 100, samples: hv.length, hvNow: hv[hv.length - 1] };
}

module.exports = { expectedMove, ivPercentile, realizedVols, EM_FACTOR };
