// Repeated mistakes, from information available BEFORE each decision (Phase 93 spec 8). Associations, never causes.
//   features(d, m, ctx)  the pre-declared features: time of day, minutes since the open, weekday, opening gap, the pre-move, distance
//                        from the session VWAP in ATR, ATR % of price, SPY vs its VWAP, SPY's 5-day change, minutes to the nearest
//                        high-impact macro release, setup type, strategy, and for options quote age / spread % / DTE
//   analyze(rows)        per feature bin: n, the WRONG_DIRECTION share (all decisive setups) and the missed-opportunity share (rejected
//                        setups that went the called way), Wilson 95% intervals, a two-proportion test vs the rest, Benjamini-Hochberg
//                        at a 10% false-discovery rate, minimum 20 per bin. Numeric bins: tertiles, PROVISIONAL until 4 weeks of records.
const T = require('./time');

const TOD = [[0, 30, '9:30-10:00'], [30, 90, '10:00-11:00'], [90, 150, '11:00-12:00'], [150, 270, '12:00-14:00'], [270, 390, '14:00-16:00']];
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NUMERIC = ['gapPct', 'preMove', 'vwapDistAtr', 'atrPct', 'spy5dPct', 'macroMinutes', 'minutesSinceOpen', 'quoteAgeSec', 'spreadPct', 'dte'];
const CATEGORICAL = ['strategy', 'setupType', 'timeOfDay', 'weekday', 'spyVsVwap'];

function vwap(rows) { let pv = 0; let v = 0; for (const r of rows) { pv += ((r[2] + r[3] + r[4]) / 3) * (r[5] || 0); v += r[5] || 0; } return v > 0 ? pv / v : null; }

// ctx: { minute (the setup's own rows), spyMinute, daily, spyDaily, macro: [epoch ms] }; only bars that ENDED by t0 (Phase 94 S0-2).
function features(d, m, ctx) {
  const f = { strategy: d.strategyId, setupType: (d.setupType || '').split(' · ')[0] || null };
  const t0 = d.t0; if (!Number.isFinite(t0)) return f;
  const day = T.ymd(t0); const mins = T.minuteOf(t0) - T.OPEN_MIN;
  f.weekday = WEEK[new Date(T.at(day, 12 * 60)).getUTCDay()];
  if (d.market !== 'crypto') {
    f.minutesSinceOpen = mins >= 0 && mins < 390 ? mins : null;
    f.timeOfDay = (TOD.find(([a, b]) => mins >= a && mins < b) || [0, 0, 'outside the session'])[2];
    const sess = (ctx.minute || []).filter((r) => r[0] + T.MIN <= t0 && T.ymd(r[0]) === day && T.inSession(r[0]));
    const prior = (ctx.daily || []).filter((r) => r[0] < T.at(day, 0));
    if (sess.length && prior.length) f.gapPct = (sess[0][1] / prior[prior.length - 1][4] - 1) * 100;
    const tr = []; const p = prior.slice(-15);
    for (let i = 1; i < p.length; i += 1) tr.push(Math.max(p[i][2] - p[i][3], Math.abs(p[i][2] - p[i - 1][4]), Math.abs(p[i][3] - p[i - 1][4])));
    const dAtr = tr.length >= 5 ? tr.reduce((s, x) => s + x, 0) / tr.length : null;
    if (dAtr && m && m.p0) f.atrPct = (dAtr / m.p0) * 100;
    const w = vwap(sess);
    if (w && dAtr && m && m.p0) f.vwapDistAtr = (d.d * (m.p0 - w)) / dAtr;
    const spySess = (ctx.spyMinute || []).filter((r) => r[0] + T.MIN <= t0 && T.ymd(r[0]) === day && T.inSession(r[0]));
    const sw = vwap(spySess);
    if (sw && spySess.length) f.spyVsVwap = spySess[spySess.length - 1][4] >= sw ? 'SPY above VWAP' : 'SPY below VWAP';
    const sd = (ctx.spyDaily || []).filter((r) => r[0] < T.at(day, 0));
    if (sd.length >= 6) f.spy5dPct = (sd[sd.length - 1][4] / sd[sd.length - 6][4] - 1) * 100;
  }
  if (m && Number.isFinite(m.preMove)) f.preMove = m.preMove;
  const macro = (ctx.macro || []).map((t) => Math.abs(t - t0) / 60000);
  if (macro.length) f.macroMinutes = Math.min(...macro);
  const o = d.option;
  if (o) {
    if (o.quoteTime && o.refAt && o.refAt >= o.quoteTime) f.quoteAgeSec = (o.refAt - o.quoteTime) / 1000; // a quote stamped after the decision clock is unreliable: left out
    if (o.bid > 0 && o.ask > o.bid) f.spreadPct = ((o.ask - o.bid) / ((o.ask + o.bid) / 2)) * 100;
    if (o.dte != null) f.dte = o.dte;
  }
  return f;
}

function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96; const p = k / n; const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den; const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
// Two-sided p-value of a two-proportion z-test (bin vs the rest).
function pTwo(k1, n1, k2, n2) {
  if (!n1 || !n2) return 1;
  const p = (k1 + k2) / (n1 + n2); const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return 1;
  const z = Math.abs(k1 / n1 - k2 / n2) / se;
  const t = 1 / (1 + 0.2316419 * z); const pdf = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const tail = pdf * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * tail);
}

const tertiles = (vals) => { const s = [...vals].sort((a, b) => a - b); return s.length < 3 ? null : [s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)]]; };
const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

// rows: [{ feat, wrong: bool|null (null = not decisive), missed: bool|null (rejected only) }]
function analyze(rows, { minN = 20, fdr = 0.10 } = {}) {
  const tests = [];
  const binOf = {};
  for (const k of NUMERIC) { const cut = tertiles(rows.map((r) => r.feat[k]).filter(Number.isFinite)); if (cut) binOf[k] = cut; }
  const bin = (k, v) => {
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) return null;
    if (!NUMERIC.includes(k)) return String(v);
    const c = binOf[k]; if (!c) return null;
    return v < c[0] ? `< ${fmt(c[0])}` : v < c[1] ? `${fmt(c[0])} .. ${fmt(c[1])}` : `>= ${fmt(c[1])}`;
  };
  for (const k of [...CATEGORICAL, ...NUMERIC]) {
    const groups = new Map();
    for (const r of rows) { const b = bin(k, r.feat[k]); if (b === null) continue; if (!groups.has(b)) groups.set(b, []); groups.get(b).push(r); }
    for (const [b, list] of groups) for (const metric of ['wrong', 'missed']) {
      const inB = list.filter((r) => r[metric] !== null && r[metric] !== undefined); const rest = rows.filter((r) => !list.includes(r) && r[metric] !== null && r[metric] !== undefined);
      const k1 = inB.filter((r) => r[metric]).length; const k2 = rest.filter((r) => r[metric]).length;
      const all = inB.length + rest.length;
      tests.push({ feature: k, bin: b, metric, n: inB.length, k: k1, rate: inB.length ? k1 / inB.length : null, ci: wilson(k1, inB.length),
        base: all ? (k1 + k2) / all : null, p: pTwo(k1, inB.length, k2, rest.length), enough: inB.length >= minN, ids: inB.map((r) => r.id) });
    }
  }
  const eligible = tests.filter((t) => t.enough).sort((a, b) => a.p - b.p);
  eligible.forEach((t, i) => { t.q = Math.min(1, (t.p * eligible.length) / (i + 1)); });
  for (let i = eligible.length - 2; i >= 0; i -= 1) eligible[i].q = Math.min(eligible[i].q, eligible[i + 1].q);
  for (const t of eligible) t.flagged = t.q <= fdr;
  return { tests, flagged: eligible.filter((t) => t.flagged), eligible: eligible.length, bins: binOf, provisional: true, minN, fdr };
}

module.exports = { features, analyze, wilson, pTwo, NUMERIC, CATEGORICAL };
