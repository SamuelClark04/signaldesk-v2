// Phase 95 Task 4.1 (spec 8.1): descriptive moves of every symbol and session, for explanations and benchmarks. Pivots are found with
// hindsight, so a pivot is NEVER an entry time: every move carries the time the zigzag rule itself could first know its end pivot
// (`confirmedAt` = the end of the bar that completed the reversal), and the last move of a session is `open` (not confirmed).
//   zigzag(bars, threshold)  moves on 1-minute closes: { dir, start: { t, price, i }, end, confirmedAt, open, sizePct, sizeAtr, durationMin, volume }
//   nest({ S, M, L })         parent = the next larger scale's move containing the start; type UP / DOWN (with the parent, or no parent)
//                             or REBOUND (against the parent)
//   quiet(bars, atr)          maximal stretches >= 30 min whose high-low range stays under 0.75 x ATR30
//   atr30(daily, day)         the mean true range of the 30 sessions BEFORE `day` (>= 10 needed, else null with a reason)
// Scales (spec 8.1): S = 1.0, M = 2.0, L = 4.0 x ATR30.
const EPS = 1e-9; // closes are decimal prices: a reversal of exactly the threshold counts
const SCALES = { S: 1.0, M: 2.0, L: 4.0 };
const QUIET_MIN = 30; const QUIET_RANGE_ATR = 0.75;

function zigzag(bars, thr, atr = thr) {
  const n = bars.length; if (n < 2 || !(thr > 0)) return [];
  const c = bars.map((b) => b.c);
  const pivots = []; // { i, confirmedAt }
  let dir = 0; let hi = 0; let lo = 0; let ext = 0;
  for (let i = 1; i < n; i += 1) {
    if (dir === 0) {
      if (c[i] > c[hi]) hi = i; if (c[i] < c[lo]) lo = i;
      if (c[i] - c[lo] >= thr - EPS && lo < i) { pivots.push({ i: lo, confirmedAt: bars[i].t + 60000 }); dir = 1; ext = i; }
      else if (c[hi] - c[i] >= thr - EPS && hi < i) { pivots.push({ i: hi, confirmedAt: bars[i].t + 60000 }); dir = -1; ext = i; }
    } else if (dir === 1) {
      if (c[i] > c[ext]) ext = i;
      else if (c[ext] - c[i] >= thr - EPS) { pivots.push({ i: ext, confirmedAt: bars[i].t + 60000 }); dir = -1; ext = i; }
    } else if (c[i] < c[ext]) ext = i;
    else if (c[i] - c[ext] >= thr - EPS) { pivots.push({ i: ext, confirmedAt: bars[i].t + 60000 }); dir = 1; ext = i; }
  }
  if (!pivots.length) return [];
  const ends = [...pivots.slice(1), { i: ext, confirmedAt: null, open: true }];
  return pivots.map((p, k) => {
    const e = ends[k]; const a = bars[p.i]; const b = bars[e.i];
    let volume = 0; for (let j = p.i; j <= e.i; j += 1) volume += Number(bars[j].v) || 0;
    return { dir: b.c >= a.c ? 1 : -1, start: { t: a.t, price: a.c, i: p.i, confirmedAt: p.confirmedAt }, end: { t: b.t, price: b.c, i: e.i },
      confirmedAt: e.confirmedAt, open: !!e.open, sizePct: ((b.c - a.c) / a.c) * 100, sizeAtr: (b.c - a.c) / atr, durationMin: Math.round((b.t - a.t) / 60000), volume };
  });
}

// Nesting: each move's parent is the next larger scale's move whose span contains this move's start.
function nest(scales) {
  const order = ['S', 'M', 'L']; const out = {};
  for (let k = 0; k < order.length; k += 1) {
    const moves = scales[order[k]] || []; const parents = k + 1 < order.length ? scales[order[k + 1]] || [] : [];
    out[order[k]] = moves.map((m) => {
      const parentIdx = parents.findIndex((p) => m.start.t >= p.start.t && (m.start.t < p.end.t || (p.open && m.start.t >= p.start.t)));
      const p = parentIdx >= 0 ? parents[parentIdx] : null;
      const type = p && p.dir !== m.dir ? 'REBOUND' : m.dir === 1 ? 'UP' : 'DOWN';
      return { ...m, scale: order[k], parentIdx: parentIdx >= 0 ? parentIdx : null, type };
    });
  }
  return out;
}

// For every start, the furthest end that keeps the range under the band (two pointers + monotonic deques); then the LONGEST
// windows are taken first, without overlap (a greedy earliest start would cut a quiet stretch short).
function quiet(bars, atr) {
  const out = []; if (!(atr > 0) || !bars.length) return out;
  const lim = QUIET_RANGE_ATR * atr; const n = bars.length;
  const H = bars.map((b) => b.h ?? b.c); const L = bars.map((b) => b.l ?? b.c);
  const maxQ = []; const minQ = []; const reach = new Array(n); let j = 0;
  for (let i = 0; i < n; i += 1) {
    while (j < n) {
      const hi = Math.max(maxQ.length ? H[maxQ[0]] : -Infinity, H[j]); const lo = Math.min(minQ.length ? L[minQ[0]] : Infinity, L[j]);
      if (hi - lo >= lim - EPS) break;
      while (maxQ.length && H[maxQ[maxQ.length - 1]] <= H[j]) maxQ.pop(); maxQ.push(j);
      while (minQ.length && L[minQ[minQ.length - 1]] >= L[j]) minQ.pop(); minQ.push(j);
      j += 1;
    }
    reach[i] = j; // window [i, j)
    if (maxQ[0] === i) maxQ.shift(); if (minQ[0] === i) minQ.shift();
    if (j === i) j += 1; // a single bar whose own range exceeds the band
  }
  const cand = reach.map((e, i) => ({ i, e, len: e - i })).filter((w) => w.len >= QUIET_MIN).sort((a, b) => b.len - a.len || a.i - b.i);
  const used = new Uint8Array(n);
  for (const w of cand) {
    let free = true; for (let k = w.i; k < w.e; k += 1) if (used[k]) { free = false; break; }
    if (!free) continue;
    for (let k = w.i; k < w.e; k += 1) used[k] = 1;
    let hi = -Infinity; let lo = Infinity; for (let k = w.i; k < w.e; k += 1) { hi = Math.max(hi, H[k]); lo = Math.min(lo, L[k]); }
    out.push({ start: bars[w.i].t, end: bars[w.e - 1].t + 60000, durationMin: w.len, rangeAtr: (hi - lo) / atr, high: hi, low: lo });
  }
  return out.sort((a, b) => a.start - b.start);
}

// daily: [{ day: 'YYYY-MM-DD', h, l, c }] in any order.
function atr30(daily, day) {
  const prior = daily.filter((d) => d.day < day).sort((a, b) => (a.day < b.day ? -1 : 1));
  if (prior.length < 11) return { atr: null, sessions: Math.max(0, prior.length - 1), reason: `only ${prior.length} prior sessions (need >= 11 for 10 true ranges)` };
  const last = prior.slice(-31); const trs = [];
  for (let k = 1; k < last.length; k += 1) { const d = last[k]; const pc = last[k - 1].c; trs.push(Math.max(d.h - d.l, Math.abs(d.h - pc), Math.abs(d.l - pc))); }
  return { atr: trs.reduce((s, x) => s + x, 0) / trs.length, sessions: trs.length };
}

// One symbol-session: all scales, nested, plus QUIET.
function observeSession(bars, atr) {
  const z = Object.fromEntries(Object.entries(SCALES).map(([k, m]) => [k, zigzag(bars, m * atr, atr)]));
  return { moves: nest(z), quiet: quiet(bars, atr) };
}

// Persist one or more symbol-days into the research ledger (tools/research/db.js v3 tables). Deterministic: a re-run REPLACES the day.
// Status per symbol-day: OK, NO_BARS (no 1-minute bars stored), NO_ATR (too few prior daily bars; the reason is kept, no move invented).
const VERSION = 'observe@1';
function observeDays(db, { symbols, days }) {
  const out = { ok: 0, noBars: 0, noAtr: 0 };
  const dailyOf = db.prepare('select day, h, l, c from bars_1d where symbol = ? and day < ? order by day');
  const barsOf = db.prepare('select t, o, h, l, c, v from bars_1m where symbol = ? and t >= ? and t < ? order by t');
  const status = db.prepare('insert into observe_days (symbol, day, atr, atr_sessions, status, reason, version) values (?, ?, ?, ?, ?, ?, ?) on conflict (symbol, day) do update set atr = excluded.atr, atr_sessions = excluded.atr_sessions, status = excluded.status, reason = excluded.reason, version = excluded.version');
  const delM = db.prepare('delete from moves where symbol = ? and day = ?'); const delQ = db.prepare('delete from quiet_periods where symbol = ? and day = ?');
  const insM = db.prepare('insert into moves (symbol, day, scale, k, dir, type, parent_k, start_t, start_px, start_confirmed_at, end_t, end_px, confirmed_at, open, size_pct, size_atr, duration_min, volume) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insQ = db.prepare('insert into quiet_periods (symbol, day, k, start_t, end_t, duration_min, range_atr) values (?, ?, ?, ?, ?, ?, ?)');
  const et = require('../../server/services/et-time');
  for (const day of days) {
    const from = et.toEpoch(day, 0, 0); const to = from + 86400000 + 3600000; // a DST day is 23 or 25 h: filter by the ET date below
    for (const symbol of symbols) {
      const bars = barsOf.all(symbol, from, to).filter((b) => et.ymd(b.t) === day);
      db.exec('begin');
      try {
        delM.run(symbol, day); delQ.run(symbol, day);
        if (!bars.length) { status.run(symbol, day, null, 0, 'NO_BARS', 'no 1-minute bars stored for the day', VERSION); out.noBars += 1; }
        else {
          const a = atr30(dailyOf.all(symbol, day), day);
          if (a.atr === null) { status.run(symbol, day, null, a.sessions, 'NO_ATR', a.reason, VERSION); out.noAtr += 1; }
          else {
            const o = observeSession(bars, a.atr);
            for (const sc of ['S', 'M', 'L']) o.moves[sc].forEach((m, k) => insM.run(symbol, day, sc, k, m.dir, m.type, m.parentIdx, m.start.t, m.start.price, m.start.confirmedAt ?? null,
              m.end.t, m.end.price, m.confirmedAt, m.open ? 1 : 0, m.sizePct, m.sizeAtr, m.durationMin, m.volume));
            o.quiet.forEach((q, k) => insQ.run(symbol, day, k, q.start, q.end, q.durationMin, q.rangeAtr));
            status.run(symbol, day, a.atr, a.sessions, 'OK', null, VERSION); out.ok += 1;
          }
        }
        db.exec('commit');
      } catch (err) { db.exec('rollback'); throw err; }
    }
  }
  return out;
}

module.exports = { zigzag, nest, quiet, atr30, observeSession, observeDays, SCALES, QUIET_MIN, QUIET_RANGE_ATR, VERSION };
