// System 6 gem triggers (Phase 56): pure functions over completed Coinbase 5-minute
// bars (oldest first) and the live price. 6-speculative-crypto.js proposes from
// them; moonshot-radar.js shows how close every watchlist gem is.
//   IGNITION  momentum breakout: +2.5% to +14% in 15 min (5m frame) or 30 min
//             (15m frame) on >= 2.2x relative volume, at a fresh high: the
//             30-minute closing high (5m) or the 2-hour closing high (15m)
//   COIL      early volume accumulation (pre-breakout): 15m volume, or the last
//             hour's, >= 2.8x its prior 6-hour average; higher lows (15m EMA9 >
//             EMA21) and the last 15m bar closing in the top 30% of its range;
//             price breaking above a tight 3-hour base (<= 6% range) with a
//             +1.5% to +5% move over the last hour. The stop sits under the
//             base low (6-speculative-crypto.js: chart-stop rule, fee floor).
const CONFIG = {
  ignition: { surgeMin: 0.025, surgeMax: 0.14, relVolMin: 2.2, high5m: 6, high15m: 8 },
  coil: { volMin: 2.8, priorBars: 24, hourBars: 4, baseBars: 12, baseMaxRange: 0.06, moveMin: 0.015, moveMax: 0.05, closeTop: 0.7,
    emaFast: 9, emaSlow: 21, minBars15: 30, stopBuffer: 0.003 },
};

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

// 5m bars -> completed 15m bars aligned to the quarter hour. A quarter hour is
// complete once its time has passed, even with a 5m candle missing: Coinbase sends
// no candle for 5 minutes without a trade, and thin gems have such gaps.
function to15(b) {
  const out = new Map();
  const end = b.length ? b[b.length - 1].time + 300 : 0; // the last completed 5m bar's close
  for (const x of b) {
    const t = Math.floor(x.time / 900) * 900;
    const g = out.get(t);
    if (!g) out.set(t, { ...x, time: t, n: 1 });
    else Object.assign(g, { high: Math.max(g.high, x.high), low: Math.min(g.low, x.low), close: x.close, volume: g.volume + x.volume, n: g.n + 1 });
  }
  return [...out.values()].filter((g) => g.n === 3 || g.time + 900 <= end);
}

// Both momentum frames at live price `live`: [{ frame, surge, relVol, minutes }] (null frames dropped).
function frames(b, live) {
  const out = [];
  if (b.length >= 16) out.push({ frame: '5m', minutes: 15, surge: live / b[b.length - 4].close - 1, relVol: b[b.length - 1].volume / avg(b.slice(-13, -1).map((x) => x.volume)) });
  const q = to15(b);
  if (q.length >= 7) out.push({ frame: '15m', minutes: 30, surge: live / q[q.length - 3].close - 1, relVol: q[q.length - 1].volume / avg(q.slice(-5, -1).map((x) => x.volume)) });
  return out.filter((f) => Number.isFinite(f.surge) && Number.isFinite(f.relVol));
}

// EMA of the last value of `values` (seeded with the first value).
function ema(values, n) {
  const k = 2 / (n + 1);
  return values.reduce((e, v, i) => (i === 0 ? v : v * k + e * (1 - k)), 0);
}

// IGNITION: { ok, m (the best qualifying frame), frames, reason }.
function ignition(b, live) {
  const C = CONFIG.ignition;
  const fs = frames(b, live);
  if (!fs.length) return { ok: false, frames: fs, reason: 'Not enough 5-minute history', short: 'no history' };
  const q = to15(b);
  const highOk = (f) => (f.frame === '5m' ? live >= Math.max(...b.slice(-C.high5m).map((x) => x.close))
    : q.length >= C.high15m && live >= Math.max(...q.slice(-C.high15m).map((x) => x.close)));
  const surging = fs.filter((f) => f.surge >= C.surgeMin && f.surge <= C.surgeMax && f.relVol >= C.relVolMin);
  const ok = surging.filter(highOk);
  if (ok.length) return { ok: true, frames: fs, m: ok.reduce((a, x) => (x.surge * x.relVol > a.surge * a.relVol ? x : a)) };
  const top = fs.reduce((a, x) => (x.surge > a.surge ? x : a));
  const [reason, short] = surging.length ? [`Momentum faded (under the ${surging[0].frame === '5m' ? '30-minute' : '2-hour'} closing high)`, 'faded under the high']
    : top.surge > C.surgeMax ? [`Overextended (${pct(top.surge)} in ${top.minutes}m): no chase`, 'overextended']
      : top.surge < C.surgeMin ? [`No surge (${pct(top.surge)} in ${top.minutes}m)`, 'no surge'] : [`Volume only ${top.relVol.toFixed(1)}x normal`, 'volume under 2.2x'];
  return { ok: false, frames: fs, reason, short };
}

// COIL: { ok, reason, move, volRatio, vol15, vol1h, emaFast, emaSlow, closePos, baseHigh, baseLow, baseRange, structural }.
function coil(b, live) {
  const C = CONFIG.coil;
  const q = to15(b);
  const N = q.length;
  if (N < C.minBars15) return { ok: false, reason: `Not enough 15-minute history for the coil check (${N} of ${C.minBars15} bars)`, short: 'thin 15m history' };
  const last = q[N - 1];
  const prior = q.slice(N - C.hourBars - C.priorBars, N - C.hourBars).map((x) => x.volume);
  const base = avg(prior);
  const vol15 = base > 0 ? last.volume / base : 0;
  const vol1h = base > 0 ? q.slice(N - C.hourBars).reduce((s, x) => s + x.volume, 0) / (base * C.hourBars) : 0;
  const box = q.slice(N - 1 - C.baseBars, N - 1);
  const baseHigh = Math.max(...box.map((x) => x.high));
  const baseLow = Math.min(...box.map((x) => x.low));
  const closes = q.map((x) => x.close);
  const r = {
    move: live / q[N - 5].close - 1, volRatio: Math.max(vol15, vol1h), vol15, vol1h, emaFast: ema(closes, C.emaFast), emaSlow: ema(closes, C.emaSlow),
    closePos: last.high > last.low ? (last.close - last.low) / (last.high - last.low) : 0.5, baseHigh, baseLow, baseRange: baseHigh / baseLow - 1,
    structural: baseLow * (1 - C.stopBuffer),
  };
  const fail = (reason, short) => ({ ...r, ok: false, reason, short });
  if (r.volRatio < C.volMin) return fail(`Volume ${r.volRatio.toFixed(1)}x its 6-hour average (the coil needs ${C.volMin}x)`, `volume under ${C.volMin}x its 6h average`);
  if (!(r.emaFast > r.emaSlow)) return fail('No higher lows (15m EMA9 under EMA21)', 'no higher lows');
  if (r.closePos < C.closeTop) return fail(`Last 15m bar closed at ${Math.round(r.closePos * 100)}% of its range (needs the top 30%)`, 'weak close');
  if (r.baseRange > C.baseMaxRange) return fail(`Base too loose (${pct(r.baseRange)} range over 3 hours; needs <= ${C.baseMaxRange * 100}%)`, 'base too loose');
  if (!(live > baseHigh)) return fail('Accumulating inside its 3-hour base (no breakout yet)', 'inside its base');
  if (r.move < C.moveMin || r.move > C.moveMax) return fail(`Move ${pct(r.move)} in the last hour (the coil needs +1.5% to +5%)`, r.move > C.moveMax ? 'moved past +5% (late)' : 'move under +1.5%');
  return { ...r, ok: true, reason: null, short: null };
}

// Coil pattern quality 0-25 (it replaces the velocity points in the 100-point score):
// base tightness (10), close in the bar's top (8), EMA9 over EMA21 (7).
function coilPattern(c) {
  const tight = 10 * clamp01((CONFIG.coil.baseMaxRange - c.baseRange) / 0.04);
  const close = 8 * clamp01((c.closePos - CONFIG.coil.closeTop) / (1 - CONFIG.coil.closeTop));
  const trend = 7 * clamp01((c.emaFast / c.emaSlow - 1) / 0.01);
  return tight + close + trend;
}

module.exports = { ignition, coil, coilPattern, frames, to15, ema, CONFIG };
