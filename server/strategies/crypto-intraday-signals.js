// Crypto intraday signal detectors (2-crypto-intraday.js), pure: completed bars
// in (oldest first), one signal or a skip reason out. Every archetype runs on
// 15m AND on 1h, each timeframe on its own (a 1h bar without a fresh cross never
// hides a 15m setup). Each signal: { kind, setupType, level (the trigger the
// live price must hold above), swingLow (the chart structure the stop goes
// under), relVol, breakout? }.
//   SQUEEZE   the 12 bars before the latest sat in a tight range (<= 2% of price
//             on 15m, 3.5% on 1h); the latest closed above it on >= 1.8x volume
//   SWEEP     liquidity sweep: the latest bar traded under the lowest low of the
//             prior 20 bars (the stops resting there) and CLOSED back above it,
//             in the upper half of its range, on >= 1.5x volume
//   RANGEFAIL range failure: within the last 3 bars a close BELOW the 24-bar range
//             low, and the latest bar closed back inside the range on >= 1.2x
//             volume (a failed breakdown traps the shorts)
//   PULLBACK  EMA9 > EMA21 > EMA50 uptrend; a dip to the EMA21 or the rolling 24h
//             VWAP within 6 bars, then a close back ABOVE it on >= 1.2x volume
const CONFIG = { pullbackBars: 6, volBars: 20, reclaimVol: 1.2, squeezeBars: 12, breakoutVol: 1.8, sweepBars: 20, sweepVol: 1.5, rangeBars: 24, failBars: 3, failVol: 1.2 };
const SQUEEZE_PCT = { '15m': 0.02, '1h': 0.035 };

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const relVolAt = (b, i) => b[i].volume / avg(b.slice(Math.max(0, i - CONFIG.volBars), i).map((x) => x.volume));

// EMA series aligned with `values` (null until the first full window).
function ema(values, n) {
  const k = 2 / (n + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  out[n - 1] = avg(values.slice(0, n));
  for (let i = n; i < values.length; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// Rolling VWAP of the `win` bars ending at i (typical price x volume).
function vwapAt(b, i, win) {
  const w = b.slice(Math.max(0, i - win + 1), i + 1);
  const vol = w.reduce((s, x) => s + (x.volume || 0), 0);
  return vol > 0 ? w.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / vol : null;
}

// Average bar range of the last n bars (the timeframe's own ATR proxy).
const barAtr = (b, n = 14) => avg(b.slice(-n).map((x) => x.high - x.low));

function squeeze(b, tf, coils, key) {
  const n = b.length;
  const box = b.slice(n - 1 - CONFIG.squeezeBars, n - 1);
  const high = Math.max(...box.map((x) => x.high)); const low = Math.min(...box.map((x) => x.low));
  const L = b[n - 1];
  if ((high - low) / L.close > SQUEEZE_PCT[tf]) { coils.delete(key); return { skip: `no tight ${CONFIG.squeezeBars}-bar range` }; }
  coils.set(key, { high, low });
  if (!(L.close > high)) return { skip: 'coiled, no breakout yet' };
  const relVol = relVolAt(b, n - 1);
  if (!(relVol >= CONFIG.breakoutVol)) return { skip: `breakout on ${relVol.toFixed(1)}x volume (needs ${CONFIG.breakoutVol}x)` };
  return { kind: 'SQUEEZE', setupType: `${tf} squeeze breakout`, level: high, swingLow: low, relVol, range: (high - low) / L.close, breakout: true };
}

function sweep(b, tf) {
  const n = b.length;
  const L = b[n - 1];
  const priorLow = Math.min(...b.slice(n - 1 - CONFIG.sweepBars, n - 1).map((x) => x.low));
  if (!(L.low < priorLow)) return { skip: 'no sweep of the 20-bar low' };
  if (!(L.close > priorLow) || L.close < (L.high + L.low) / 2) return { skip: 'swept the low, no strong close back above it' };
  const relVol = relVolAt(b, n - 1);
  if (!(relVol >= CONFIG.sweepVol)) return { skip: `sweep on ${relVol.toFixed(1)}x volume (needs ${CONFIG.sweepVol}x)` };
  return { kind: 'SWEEP', setupType: `${tf} liquidity sweep`, level: priorLow, swingLow: L.low, relVol };
}

function rangeFailure(b, tf) {
  const n = b.length;
  const range = b.slice(n - 1 - CONFIG.failBars - CONFIG.rangeBars, n - 1 - CONFIG.failBars);
  const rangeLow = Math.min(...range.map((x) => x.low));
  const fail = b.slice(n - 1 - CONFIG.failBars, n - 1);
  if (!fail.some((x) => x.close < rangeLow)) return { skip: 'no breakdown below the 24-bar range' };
  const L = b[n - 1];
  if (!(L.close > rangeLow)) return { skip: 'broke down, not back inside the range' };
  const relVol = relVolAt(b, n - 1);
  if (!(relVol >= CONFIG.failVol)) return { skip: `range reclaim on ${relVol.toFixed(1)}x volume (needs ${CONFIG.failVol}x)` };
  return { kind: 'RANGEFAIL', setupType: `${tf} range failure`, level: rangeLow, swingLow: Math.min(...[...fail, L].map((x) => x.low)), relVol };
}

function pullback(b, tf) {
  const n = b.length;
  const closes = b.map((x) => x.close);
  const e9 = ema(closes, 9); const e21 = ema(closes, 21); const e50 = ema(closes, 50);
  const L = n - 1; const P = n - 2;
  if (!(e50[L] > 0)) return { skip: 'not enough history' };
  if (!(e9[L] > e21[L] && e21[L] > e50[L])) return { skip: 'no uptrend (EMA9 > EMA21 > EMA50)' };
  const win = tf === '15m' ? 96 : 24; // 24 hours of bars
  for (const [name, series] of [['EMA21', e21], ['24h VWAP', b.map((_, i) => vwapAt(b, i, win))]]) {
    const dipped = b.slice(n - 1 - CONFIG.pullbackBars, n - 1).some((x, j) => x.low <= series[n - 1 - CONFIG.pullbackBars + j]);
    if (!dipped || !(closes[P] <= series[P]) || !(closes[L] > series[L])) continue;
    const relVol = relVolAt(b, L);
    if (!(relVol >= CONFIG.reclaimVol)) return { skip: `${name} reclaim on ${relVol.toFixed(1)}x volume (needs ${CONFIG.reclaimVol}x)` };
    return { kind: 'PULLBACK', setupType: `${tf} ${name} reclaim`, level: series[L], swingLow: Math.min(...b.slice(-CONFIG.pullbackBars - 1).map((x) => x.low)), relVol };
  }
  return { skip: 'uptrend, no fresh EMA21 / VWAP reclaim' };
}

// Every archetype on one timeframe's bars, in priority order.
const detectAll = (b, tf, coils, key) => [squeeze(b, tf, coils, key), sweep(b, tf), rangeFailure(b, tf), pullback(b, tf)];

module.exports = { detectAll, squeeze, sweep, rangeFailure, pullback, ema, vwapAt, barAtr, CONFIG, SQUEEZE_PCT };
