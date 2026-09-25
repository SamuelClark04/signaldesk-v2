// Strategy reality gate (Phase 54): the checks that keep a setup's levels
// honest, shared by the strategies and the risk engine.
//   chartStop    the stop comes from the CHART (swing low less an ATR buffer).
//                Tighter than MIN_CHART_STOP (3.2%) -> rejected ("Chart stop
//                too tight for Coinbase fee tier"): a 0.7% range is never
//                stretched to the 4.6% fee floor, which would inflate T1 / T2
//                into fantasy targets. Between 3.2% and the floor it may widen
//                to the floor (at most ~1.44x).
//   atrCap       T1 distance vs the DAILY ATR(14): intraday (1-6h / 1-24h
//                holds) <= 1.0x, multi-day swings <= 2.5x
//   dailyCeiling the 30- and 100-day highs above entry: an intraday breakout is
//                only exempt from them when the entry is breaking above (or
//                within 0.5% of) that high; otherwise T1 must sit under it
//   t1NetRR      the NET reward : risk of T1 ALONE after fees (live brackets exit
//                100% at T1): every trade needs >= MIN_T1_NET_RR (1.25 : 1)
// Pure functions.
const MIN_CHART_STOP = 0.032;
const MIN_T1_NET_RR = 1.25;
const ATR_CAP = { intraday: 1.0, swing: 2.5 };
const BREAKOUT_WITHIN = 0.005;
const CHART_STOP_REASON = 'Chart stop too tight for Coinbase fee tier';

// { ok, invalidation, pct, widened } or { ok: false, reason, pct }.
function chartStop(entry, structural, floorPct) {
  const pct = (entry - structural) / entry;
  if (!(pct > 0)) return { ok: false, pct, reason: 'Structural stop is not below entry' };
  if (pct < MIN_CHART_STOP) {
    return { ok: false, pct, reason: `${CHART_STOP_REASON}: the chart stop is ${(pct * 100).toFixed(1)}% below entry (needs >= ${MIN_CHART_STOP * 100}%; never stretched)` };
  }
  const floor = entry * (1 - floorPct);
  return { ok: true, invalidation: Math.min(structural, floor), pct: Math.max(pct, floorPct), widened: structural > floor };
}

// Wilder-style average true range over the last n daily bars (oldest first).
function dailyAtr(bars, n = 14) {
  if (!bars || bars.length < n + 1) return null;
  const w = bars.slice(-n - 1);
  let sum = 0;
  for (let i = 1; i < w.length; i += 1) sum += Math.max(w[i].high - w[i].low, Math.abs(w[i].high - w[i - 1].close), Math.abs(w[i].low - w[i - 1].close));
  return sum / n;
}

// { ok, mult } or { ok: false, reason, mult }.
function atrCap(entry, t1, atr, kind) {
  if (!(atr > 0)) return { ok: false, mult: null, reason: 'No daily ATR (not enough daily history) to check the target against' };
  const mult = (t1 - entry) / atr;
  const cap = ATR_CAP[kind];
  return mult <= cap ? { ok: true, mult }
    : { ok: false, mult, reason: `T1 is ${mult.toFixed(2)}x the daily ATR ${atr.toPrecision(4)} away; a ${kind === 'intraday' ? '1-24h intraday' : 'multi-day swing'} trade allows <= ${cap}x` };
}

// The 30- / 100-day highs over entry. { ceiling | null, exempt, text }.
function dailyCeiling(bars, entry) {
  const highs = [30, 100].map((d) => ({ days: d, high: Math.max(...bars.slice(-d).map((b) => b.high)) })).filter((h) => Number.isFinite(h.high));
  const over = highs.filter((h) => h.high > entry);
  if (!over.length) return { ceiling: null, exempt: false, text: 'Above its 30- and 100-day highs (no daily ceiling)' };
  const near = over[0];
  if (entry >= near.high * (1 - BREAKOUT_WITHIN)) return { ceiling: null, exempt: true, text: `Breaking its ${near.days}-day high ${near.high} (within ${BREAKOUT_WITHIN * 100}%): exempt` };
  return { ceiling: near.high, exempt: false, text: `${near.days}-day high ${near.high} overhead` };
}

// NET reward : risk of T1 alone, from the ledger's own scenarios ({ stop, t1 }).
function t1NetRR(scenarios) {
  const s = scenarios || {};
  if (!s.t1 || !s.stop || !(s.stop.net < 0)) return null;
  return s.t1.net / -s.stop.net;
}

module.exports = { chartStop, dailyAtr, atrCap, dailyCeiling, t1NetRR, MIN_CHART_STOP, MIN_T1_NET_RR, ATR_CAP, BREAKOUT_WITHIN, CHART_STOP_REASON };
