// Phase 95 Task 5.1 + 4.5 (plan 6.1 / 6.2): the opportunities of one symbol-session, each with its direction and `tAvail`
// (the moment it was knowable). Frozen as TRIGGERS_VERSION before any outcome is computed; changing a rule needs a new version.
//   TRIGGER  on SIP 1-minute bars, tAvail = the END of the bar that completes the condition:
//            ORB5 / ORB15 / ORB30 UP / DOWN (first close beyond the opening range), VWAP_RECLAIM / VWAP_LOSS (after 10:00, a close across
//            the session VWAP after >= 15 closes on the other side), MOVE15 (close vs 15 bars earlier >= 1.5 x ATR(14, 1-min); re-armed after
//            15 min), REVERSAL_CONFIRM (spec T1: a decline / rise >= 1.0 x ATR30 from the running session extreme, then a close
//            0.5 x ATR30 off the opposite extreme), REBOUND (>= 50% retrace of a >= 2 x ATR30 swing; ATR30 = daily, prior sessions, as
//            the spec's move scales; re-armed after firing), RANGE_BREAK30 (spec T3: a close beyond the prior 30-min range),
//            GAP_HELD / GAP_FILLED (|open / prior close - 1| >= 1%, judged at 10:00)
//   NEWS     the first news receipt (t_recv) of the symbol in session hours: no direction, so a CALL and a PUT opportunity
//   CONTROL  10:00, 11:30 and 14:00: CALL and PUT (the baseline every trigger must beat)
//   APP      every app decision on a pilot symbol (staged, rejected or blocked), one per decision id, by its first record
//            QUIET_BREAK (spec T7: the first close beyond a confirmed 30-min QUIET range, range < 0.75 x ATR30)
// Cross-symbol / event triggers (T4 RS_DIVERGENCE, T5 PEER_SHOCK, T6 EVENT_SELF / EVENT_PEER) are in cross.js (exposure-map@1-pilot).
// Dedup: one opportunity per key; distinct triggers / directions stay separate (plan 6.2).
const et = require('../../../server/services/et-time');

const TRIGGERS_VERSION = 'triggers@1 (pilot map)';
const MIN = 60000;

function atr14(bars, i) {
  if (i < 14) return null; let s = 0;
  for (let k = i - 13; k <= i; k += 1) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / 14;
}

// bars: the session's 1-minute bars (regular hours, ascending); prevClose: the prior session's close (or null)
function triggers(symbol, day, bars, prevClose, atr30 = null) {
  const out = []; if (!bars.length) return out;
  const open = et.toEpoch(day, 9, 30); const end = (b) => b.t + MIN;
  const add = (id, dir, b, extra) => out.push({ source: 'TRIGGER', symbol, day, trigger: id, dir, tAvail: end(b), key: `${symbol}|${id}|${dir}|${end(b)}`, ...extra });
  for (const n of [5, 15, 30]) {
    const rng = bars.filter((b) => b.t < open + n * MIN); if (rng.length < Math.ceil(n * 0.6)) continue;
    const hi = Math.max(...rng.map((b) => b.h)); const lo = Math.min(...rng.map((b) => b.l)); let up = false; let dn = false;
    for (const b of bars) {
      if (b.t < open + n * MIN) continue;
      if (!up && b.c > hi) { up = true; add(`ORB${n}`, 'UP', b, { level: hi }); }
      if (!dn && b.c < lo) { dn = true; add(`ORB${n}`, 'DOWN', b, { level: lo }); }
    }
  }
  let pv = 0; let vv = 0; let side = 0; let run = 0; let lastMove = { UP: -Infinity, DOWN: -Infinity };
  const A = Number.isFinite(atr30) && atr30 > 0 ? atr30 : null;
  const sw = { hi: -Infinity, loAfterHi: Infinity, lo: Infinity, hiAfterLo: -Infinity }; const rb = { hi: -Infinity, loAfterHi: Infinity, lo: Infinity, hiAfterLo: -Infinity };
  let lastR30 = { UP: -Infinity, DOWN: -Infinity };
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i]; pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; const vwap = vv > 0 ? pv / vv : b.c;
    const s = b.c > vwap ? 1 : b.c < vwap ? -1 : 0;
    if (b.t >= open + 30 * MIN && s !== 0 && side !== 0 && s !== side && run >= 15) add(s > 0 ? 'VWAP_RECLAIM' : 'VWAP_LOSS', s > 0 ? 'UP' : 'DOWN', b, { level: vwap });
    if (s !== 0) { if (s === side) run += 1; else { side = s; run = 1; } }
    const a = atr14(bars, i); if (a === null || a <= 0) continue;
    if (i >= 15) {
      const d = b.c - bars[i - 15].c; const dir = d > 0 ? 'UP' : 'DOWN';
      if (Math.abs(d) >= 1.5 * a && b.t - lastMove[dir] >= 15 * MIN) { lastMove[dir] = b.t; add('MOVE15', dir, b, { atr: a }); }
    }
  }
  // Swing triggers on ATR30 (daily): T1 REVERSAL_CONFIRM and REBOUND. Each tracks the running high and the low SINCE it (and the mirror).
  for (const b of bars) {
    if (!A) break;
    for (const [st, minSwing, frac, id] of [[sw, 1.0 * A, null, 'REVERSAL_CONFIRM'], [rb, 2.0 * A, 0.5, 'REBOUND']]) {
      if (b.h > st.hi) { st.hi = b.h; st.loAfterHi = Infinity; } if (b.l < st.loAfterHi) st.loAfterHi = b.l;
      if (b.l < st.lo) { st.lo = b.l; st.hiAfterLo = -Infinity; } if (b.h > st.hiAfterLo) st.hiAfterLo = b.h;
      const drop = st.hi - st.loAfterHi; const rise = st.hiAfterLo - st.lo;
      const offUp = frac === null ? 0.5 * A : frac * drop; const offDn = frac === null ? 0.5 * A : frac * rise;
      if (drop >= minSwing && b.c - st.loAfterHi >= offUp) { add(id, 'UP', b, { swing: drop }); st.hi = b.h; st.loAfterHi = b.l; }
      if (rise >= minSwing && st.hiAfterLo - b.c >= offDn) { add(id, 'DOWN', b, { swing: rise }); st.lo = b.l; st.hiAfterLo = b.h; }
    }
  }
  // T7 QUIET_BREAK: a 30-bar window whose range is < 0.75 x ATR30 is a QUIET range, confirmed at its 30th bar's end; it extends while the
  // range stays under that; the first close beyond it is the break. The next quiet window starts after the break.
  if (A) {
    let q = null; let from = 0;
    for (let i = 0; i < bars.length; i += 1) {
      const b = bars[i];
      if (!q) {
        if (i - 29 < from) continue;
        const w = bars.slice(i - 29, i + 1); const hi = Math.max(...w.map((x) => x.h)); const lo = Math.min(...w.map((x) => x.l));
        if (hi - lo < 0.75 * A) q = { hi, lo };
        continue;
      }
      if (b.c > q.hi || b.c < q.lo) { add('QUIET_BREAK', b.c > q.hi ? 'UP' : 'DOWN', b, { level: b.c > q.hi ? q.hi : q.lo, range: q.hi - q.lo }); q = null; from = i + 1; continue; }
      const hi = Math.max(q.hi, b.h); const lo = Math.min(q.lo, b.l); if (hi - lo < 0.75 * A) q = { hi, lo };
    }
  }
  // T3 second half: a close beyond the PRIOR 30-min range (the 30 bars before this one), after the first 30 min; re-armed after 30 min
  for (let i = 30; i < bars.length; i += 1) {
    const w = bars.slice(i - 30, i); const hi = Math.max(...w.map((x) => x.h)); const lo = Math.min(...w.map((x) => x.l)); const b = bars[i];
    if (b.c > hi && b.t - lastR30.UP >= 30 * MIN) { lastR30.UP = b.t; add('RANGE_BREAK30', 'UP', b, { level: hi }); }
    if (b.c < lo && b.t - lastR30.DOWN >= 30 * MIN) { lastR30.DOWN = b.t; add('RANGE_BREAK30', 'DOWN', b, { level: lo }); }
  }
  if (Number.isFinite(prevClose) && prevClose > 0) {
    const gap = bars[0].o / prevClose - 1; const at10 = bars.filter((b) => b.t < open + 30 * MIN);
    if (Math.abs(gap) >= 0.01 && at10.length) {
      const filled = gap > 0 ? Math.min(...at10.map((b) => b.l)) <= prevClose : Math.max(...at10.map((b) => b.h)) >= prevClose;
      const dir = (gap > 0) !== filled ? 'UP' : 'DOWN';
      add(filled ? 'GAP_FILLED' : 'GAP_HELD', dir, at10[at10.length - 1], { gap });
    }
  }
  return out;
}

function controls(symbol, day) {
  const out = [];
  for (const [h, m] of [[10, 0], [11, 30], [14, 0]]) for (const dir of ['UP', 'DOWN']) {
    const t = et.toEpoch(day, h, m); out.push({ source: 'CONTROL', symbol, day, trigger: `CTRL${h}${m || '00'}`, dir, tAvail: t, key: `${symbol}|CTRL|${dir}|${t}` });
  }
  return out;
}

// newsRows: [{ t_recv, symbols }] of the day; the first in-session receipt per symbol -> UP and DOWN
function news(symbols, day, newsRows, closeMin) {
  const open = et.toEpoch(day, 9, 30); const close = et.toEpoch(day, Math.floor(closeMin / 60), closeMin % 60) - 30 * MIN;
  const first = new Map();
  for (const n of newsRows) if (n.t_recv >= open && n.t_recv < close) for (const s of n.symbols || []) if (symbols.includes(s) && (!first.has(s) || n.t_recv < first.get(s))) first.set(s, n.t_recv);
  const out = [];
  for (const [s, t] of first) for (const dir of ['UP', 'DOWN']) out.push({ source: 'NEWS', symbol: s, day, trigger: 'NEWS_FIRST', dir, tAvail: t, key: `${s}|NEWS|${dir}|${t}` });
  return out;
}

// decisions: decision-recorder lines; one opportunity per id (its first record), for pilot symbols with a direction.
function app(symbols, decisions) {
  const byId = new Map();
  for (const d of decisions) if (d && d.type === 'decision' && d.id && !byId.has(d.id)) byId.set(d.id, d);
  const out = [];
  for (const d of byId.values()) {
    const s = d.setup || {}; const sym = String(s.underlying || s.asset || '').toUpperCase();
    if (!symbols.includes(sym)) continue;
    const dir = /bull|long|call|up/i.test(s.direction || '') ? 'UP' : /bear|short|put|down/i.test(s.direction || '') ? 'DOWN' : null;
    if (!dir) continue;
    out.push({ source: 'APP', symbol: sym, day: et.ymd(d.at), trigger: `APP_${s.strategyId || 'unknown'}`, dir, tAvail: d.at, key: `APP|${d.id}`, decision: d.path, reason: d.reason || null });
  }
  return out;
}

// Dedup by key (repeated records merge); linked = same symbol within 15 min (for the report's episode count).
function dedupe(list) {
  const m = new Map(); for (const o of list) if (!m.has(o.key)) m.set(o.key, o);
  const all = [...m.values()].sort((a, b) => a.tAvail - b.tAvail || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key));
  let ep = 0; const lastBySym = new Map();
  for (const o of all) { const l = lastBySym.get(o.symbol); if (!l || o.tAvail - l.t > 15 * MIN) { ep += 1; lastBySym.set(o.symbol, { t: o.tAvail, ep }); } else lastBySym.set(o.symbol, { t: o.tAvail, ep: l.ep }); o.episode = lastBySym.get(o.symbol).ep; }
  return all;
}

module.exports = { triggers, controls, news, app, dedupe, atr14, TRIGGERS_VERSION };
