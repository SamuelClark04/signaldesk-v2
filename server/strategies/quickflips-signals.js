// Options Quick Flips signals (Phase 89), PURE. The exact rules frozen in docs/research/phase89-protocol.md 1.2-1.3 and
// replayed there (the replay and tests/ph89unit.js run this same logic on the same bars):
//   5-minute bars from today's regular-session 1-minute bars; session VWAP (typical x volume, cumulative from 9:30);
//   EMA20 of 5-minute closes, continuous with the prior sessions' 5-minute closes; opening range = 9:30-9:45 high / low;
//   RelVol = the bar's volume / the mean of the same time-of-day slot over the prior 20 sessions (fewer: no signal).
//   S1 ORB + VWAP   5m closes 9:50-11:30: the FIRST close above the OR high today, above VWAP, RelVol >= 1.2 (calls);
//                   mirrored below the OR low / VWAP (puts); none when the OR is wider than 1.0% of the open; one each way a day
//   S2 VWAP trend   5m closes 10:00-14:30: EMA20 above VWAP and rising (vs 3 bars ago), one of the last 3 bars traded at /
//                   under EMA20 x 1.0005, this bar closes above EMA20, above the prior bar's high and above VWAP, RelVol >= 1.0
//                   (calls); mirrored (puts). S1 wins when both fire on one bar.
//   Confirmation at the decision minute (bar end + 60 s): the last 1-minute close still beyond the trigger (OR edge / EMA20).
//   Setup failure (an exit rule, execution/quickflip-exits.js): a 5-minute close back through the session VWAP.
// Volumes: the replay used consolidated (SIP) volume; live uses the IEX stream for today AND the IEX history for the 20-session
// baseline (the same feed on both sides of the ratio), so RelVol is noisier live: forward paper results measure that gap.
const OPEN_MIN = 570; // 9:30 ET
const S1_WIN = [590, 690]; // 5m bar END 9:50 .. 11:30
const S2_WIN = [600, 870]; // 10:00 .. 14:30
const CONFIG = { orMaxPct: 0.01, s1RelVol: 1.2, s2RelVol: 1.0, touch: 0.0005, emaN: 20, relVolSessions: 20 };

// bars1m: today's minute bars [{ min (minutes since midnight ET), o, h, l, c, v }], any order / gaps. -> Array(390) | null slots
function slots(bars1m) {
  const out = new Array(390).fill(null);
  for (const b of bars1m || []) { const i = b.min - OPEN_MIN; if (i >= 0 && i < 390) out[i] = b; }
  return out;
}

// prior: [{ closes5m: [...], vols5m: Array(78) }] oldest first (prior sessions); today: Array(390) minute slots.
// -> { b5: [{ k, endMin, o, h, l, c, v, vwap, ema, relVol } | null], vwap: Array(390), or, open }
function build(prior, today) {
  const vwap = new Array(390).fill(null); let pv = 0; let vv = 0; let last = null;
  for (let m = 0; m < 390; m += 1) { const b = today[m]; if (b && b.v > 0) { pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; } if (vv > 0) last = pv / vv; vwap[m] = last; }
  const K = 2 / (CONFIG.emaN + 1);
  const closes = prior.flatMap((s) => s.closes5m);
  let ema = null;
  closes.forEach((c, i) => { if (i === CONFIG.emaN - 1) ema = closes.slice(0, CONFIG.emaN).reduce((a, x) => a + x, 0) / CONFIG.emaN; else if (i >= CONFIG.emaN) ema = c * K + ema * (1 - K); });
  let n = closes.length;
  const base = prior.slice(-CONFIG.relVolSessions);
  const b5 = [];
  for (let k = 0; k < 78; k += 1) {
    const xs = today.slice(k * 5, k * 5 + 5).filter(Boolean);
    if (!xs.length) { b5.push(null); continue; }
    const bar = { k, endMin: OPEN_MIN + k * 5 + 5, o: xs[0].o, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: xs[xs.length - 1].c, v: xs.reduce((a, x) => a + x.v, 0), vwap: vwap[k * 5 + 4] };
    n += 1; closes.push(bar.c);
    ema = ema === null ? (n >= CONFIG.emaN ? closes.slice(-CONFIG.emaN).reduce((a, x) => a + x, 0) / CONFIG.emaN : null) : bar.c * K + ema * (1 - K);
    bar.ema = ema;
    bar.relVol = base.length >= CONFIG.relVolSessions ? bar.v / (base.reduce((a, s) => a + (s.vols5m[k] || 0), 0) / CONFIG.relVolSessions) : null;
    b5.push(bar);
  }
  const or = b5.slice(0, 3).filter(Boolean);
  return { b5, vwap, or: or.length === 3 ? { high: Math.max(...or.map((b) => b.h)), low: Math.min(...or.map((b) => b.l)) } : null, open: (today.find(Boolean) || {}).o };
}

// Every signal of the session so far: [{ k, endMin, D (minute index of the decision), setup, dir, trigger, vwap, skip?, spot? }].
// fomc: true on an FOMC day (no decisions from 13:30).
function detect(s, today, { fomc = false } = {}) {
  const out = [];
  if (!s.or || !(s.open > 0)) return out;
  const orW = (s.or.high - s.or.low) / s.open;
  let aboveSeen = false; let belowSeen = false; let s1Long = false; let s1Short = false;
  for (let k = 3; k < 78; k += 1) {
    const b = s.b5[k]; if (!b || b.ema === null || b.ema === undefined) continue;
    const firstAbove = b.c > s.or.high && !aboveSeen; const firstBelow = b.c < s.or.low && !belowSeen;
    if (b.c > s.or.high) aboveSeen = true; if (b.c < s.or.low) belowSeen = true;
    let sig = null;
    if (b.endMin >= S1_WIN[0] && b.endMin <= S1_WIN[1] && orW <= CONFIG.orMaxPct && b.relVol !== null) {
      if (firstAbove && b.c > b.vwap && b.relVol >= CONFIG.s1RelVol && !s1Long) { sig = { setup: 'S1', dir: 'long', trigger: s.or.high }; s1Long = true; }
      else if (firstBelow && b.c < b.vwap && b.relVol >= CONFIG.s1RelVol && !s1Short) { sig = { setup: 'S1', dir: 'short', trigger: s.or.low }; s1Short = true; }
    }
    if (!sig && b.endMin >= S2_WIN[0] && b.endMin <= S2_WIN[1] && b.relVol !== null && b.relVol >= CONFIG.s2RelVol) {
      const e3 = s.b5[k - 3] && s.b5[k - 3].ema; const prev = s.b5[k - 1];
      const last3 = [s.b5[k - 2], s.b5[k - 1], b].filter(Boolean);
      if (e3 && prev) {
        if (b.ema > b.vwap && b.ema > e3 && last3.some((x) => x.l <= x.ema * (1 + CONFIG.touch)) && b.c > b.ema && b.c > prev.h && b.c > b.vwap) sig = { setup: 'S2', dir: 'long', trigger: b.ema };
        else if (b.ema < b.vwap && b.ema < e3 && last3.some((x) => x.h >= x.ema * (1 - CONFIG.touch)) && b.c < b.ema && b.c < prev.l && b.c < b.vwap) sig = { setup: 'S2', dir: 'short', trigger: b.ema };
      }
    }
    if (!sig) continue;
    const D = b.endMin - OPEN_MIN + 1;
    const rec = { k, endMin: b.endMin, D, vwap: b.vwap, relVol: b.relVol, ...sig };
    if (fomc && b.endMin + 1 >= 810) { out.push({ ...rec, skip: 'FOMC day after 13:30' }); continue; }
    const conf = today[D - 1] || today[D - 2];
    if (!conf || (sig.dir === 'long' ? !(conf.c > sig.trigger) : !(conf.c < sig.trigger))) { out.push({ ...rec, skip: 'confirmation failed' }); continue; }
    out.push({ ...rec, spot: conf.c });
  }
  return out;
}

// Setup failure after entry: a 5-minute bar that ENDED after `afterMin` and closed through its VWAP. -> the bar or null.
function failed(s, dir, afterMin) {
  for (const b of s.b5) if (b && b.endMin > afterMin && (dir === 'long' ? b.c < b.vwap : b.c > b.vwap)) return b;
  return null;
}

// Prior sessions' 5-minute bars ([{ time (epoch s), open, high, low, close, volume }], regular session) -> build() input.
function priorSessions(bars5m, etParts) {
  const by = new Map();
  for (const b of bars5m || []) {
    const p = etParts(b.time * 1000); const min = p.h * 60 + p.m; const k = (min - OPEN_MIN) / 5;
    if (!(k >= 0 && k < 78 && Number.isInteger(k))) continue;
    if (!by.has(p.ymd)) by.set(p.ymd, { ymd: p.ymd, closes: new Array(78).fill(null), vols5m: new Array(78).fill(0) });
    const s = by.get(p.ymd); s.closes[k] = b.close; s.vols5m[k] = b.volume || 0;
  }
  return [...by.values()].sort((a, b) => (a.ymd < b.ymd ? -1 : 1)).map((s) => ({ ymd: s.ymd, closes5m: s.closes.filter((c) => c !== null), vols5m: s.vols5m }));
}

module.exports = { build, detect, failed, slots, priorSessions, CONFIG, S1_WIN, S2_WIN, OPEN_MIN };
