// Chart structure: the nearest major resistance above a price, from daily bars.
// A "major" swing high is a pivot: a daily high with PIVOT_K lower highs on each
// side (a 7-day local top); the last PIVOT_K days' top counts too (a fresh high).
// The nearest resistance is the LOWEST such level above the price, within the
// bars given (the swing strategies pass ~100 days).
// Used to reject setups whose target sits beyond resistance the price must
// first break through (strategies: equity-swing, crypto-swing, options-system).
// Lookback: the strictness dial (strictness.js, a live setting read per call).
// Strict uses every bar given; moderate only the last resistanceLookbackDays.
const { getStrictness } = require('./strictness');

const PIVOT_K = 3;

// Pivot highs, oldest first: [{ price, time }]. The last PIVOT_K bars cannot
// qualify yet (their right side has not printed).
function pivotHighs(bars, k = PIVOT_K) {
  const out = [];
  for (let i = k; i < bars.length - k; i += 1) {
    const h = bars[i].high;
    let pivot = true;
    for (let j = i - k; j <= i + k && pivot; j += 1) if (j !== i && bars[j].high >= h) pivot = false;
    if (pivot) out.push({ price: h, time: bars[i].time });
  }
  return out;
}

// { price, time, kind } of the nearest resistance strictly above `price`, or null
// (price is above every recent top). Candidates: confirmed pivot highs, plus the
// highest high of the last k bars: a fresh top whose pivot cannot be confirmed
// yet is still resistance the price has to get through.
function nearestResistance(bars, price, k = PIVOT_K) {
  const levels = pivotHighs(bars, k).map((p) => ({ ...p, kind: 'swing high' }));
  const recent = bars.slice(-k);
  if (recent.length) {
    const top = recent.reduce((hi, b) => (b.high > hi.high ? b : hi), recent[0]);
    levels.push({ price: top.high, time: top.time, kind: 'recent high' });
  }
  const above = levels.filter((p) => p.price > price);
  if (!above.length) return null;
  return above.reduce((lo, p) => (p.price < lo.price ? p : lo), above[0]);
}

// Target viability for a proposal. { ok, resistance, text } where text is the
// sentence the thesis uses; ok is false when resistance sits below the target.
function checkTarget(allBars, entry, target, fmt = (x) => x, lookbackDays = getStrictness().resistanceLookbackDays) {
  const bars = lookbackDays > 0 ? allBars.slice(-lookbackDays) : allBars;
  const r = nearestResistance(bars, entry);
  if (!r) return { ok: true, resistance: null, text: `No major daily resistance between entry and the target ${fmt(target)} in the last ${bars.length} days.` };
  const day = new Date(r.time * 1000).toISOString().slice(0, 10);
  if (target > r.price) {
    return { ok: false, resistance: r, text: `The target ${fmt(target)} is above the major daily resistance ${fmt(r.price)} (${r.kind} ${day}, last ${bars.length} days).` };
  }
  return { ok: true, resistance: r, text: `The target ${fmt(target)} sits below the major daily resistance ${fmt(r.price)} (${r.kind} ${day}, last ${bars.length} days).` };
}

module.exports = { pivotHighs, nearestResistance, checkTarget, PIVOT_K };
