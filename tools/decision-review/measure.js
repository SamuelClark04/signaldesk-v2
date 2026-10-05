// Decision Review measurements (Phase 93, spec section 5.1-5.2): everything is on the UNDERLYING's 1-minute path [C2].
//   horizons(d, ctx)   P0, the unit u, the 5 / 15 / 30 / 60 min / session-close / planned-end prices, coverage, labels
//   pathStats(...)     MFE / MAE (in u), the first stop / T1 touch, the pre-decision move
// rows: [tMs, o, h, l, c, v] oldest first (stocks: SIP, regular session only; crypto: every minute).
const T = require('./time');

const HORIZONS = [5, 15, 30, 60];
const INTRADAY = new Set(['equity-day', 'options-quickflips', 'crypto-intraday', 'speculative-crypto']);
const isStock = (d) => d.market !== 'crypto';
const regular = (rows) => rows.filter((r) => T.inSession(r[0]));

// The planned holding period H (spec 5.1): -> { endAt, label }. days: the New York session days from the decision day on.
function plannedEnd(d, t0, days) {
  const s = d.strategyId;
  const nth = (n) => (days[n] ? T.sessionClose(days[n]) : null);
  if (d.market === 'crypto') return { endAt: t0 + 24 * 3600 * 1000, label: '24 h' };
  if (s === 'options-quickflips') return { endAt: Math.min(t0 + 60 * T.MIN, T.at(T.ymd(t0), 15 * 60 + 40)), label: '60 min or 3:40 PM' };
  if (s === 'equity-day') return { endAt: nth(1), label: 'end of the next session' };
  if (s === 'options-system') {
    const intraday = d.option && d.option.horizon === 'intraday';
    const n = intraday ? 5 : 15;
    let end = nth(n); let label = `${n} sessions`;
    const exp = d.option && d.option.expiration;
    if (exp) { const i = days.indexOf(exp); if (i >= 2) { const dte2 = T.at(days[i - 2], 10 * 60); if (!end || dte2 < end) { end = dte2; label = '2 DTE auto-close'; } } }
    return { endAt: end, label };
  }
  return { endAt: nth(10), label: '10 sessions' };
}

// The last close at or before t (binary search).
function priceAt(rows, t) {
  let lo = 0; let hi = rows.length - 1; let best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? rows[best][4] : null;
}
// A stock horizon outside regular hours moves to the next regular-session minute (spec 5.1).
function horizonTime(d, t, days) {
  if (!isStock(d) || T.inSession(t)) return t;
  const day = T.ymd(t);
  const next = days.find((x) => x > day || (x === day && T.minuteOf(t) < T.OPEN_MIN));
  return next ? T.sessionOpen(next) : t;
}
// Share of the expected minutes in [a, b) that have a bar.
function coverage(d, rows, a, b) {
  if (!(b > a)) return 1;
  const want = []; for (let t = Math.ceil(a / T.MIN) * T.MIN; t < b; t += T.MIN) if (!isStock(d) || T.inSession(t)) want.push(t);
  if (!want.length) return 1;
  const have = new Set(rows.filter((r) => r[0] >= a && r[0] < b).map((r) => Math.floor(r[0] / T.MIN)));
  return want.filter((t) => have.has(Math.floor(t / T.MIN))).length / want.length;
}

// ATR(14) of the setup's own timeframe, from bars BEFORE t0 (the unit for setups without levels).
function atrBefore(rows, t0, tfMin) {
  const pre = rows.filter((r) => r[0] < t0);
  const groups = []; let cur = null;
  for (const r of pre) {
    const k = Math.floor(r[0] / (tfMin * T.MIN));
    if (!cur || cur.k !== k) { cur = { k, h: r[2], l: r[3], c: r[4] }; groups.push(cur); } else { cur.h = Math.max(cur.h, r[2]); cur.l = Math.min(cur.l, r[3]); cur.c = r[4]; }
  }
  const tr = []; for (let i = 1; i < groups.length; i += 1) { const g = groups[i]; const pc = groups[i - 1].c; tr.push(Math.max(g.h - g.l, Math.abs(g.h - pc), Math.abs(g.l - pc))); }
  const last = tr.slice(-14);
  return last.length >= 5 ? last.reduce((s, x) => s + x, 0) / last.length : null;
}
const tfMinutes = (tf) => { const m = /^(\d+)\s*(m|h|D)$/i.exec(String(tf || '')); if (!m) return 5; return Number(m[1]) * (m[2] === 'h' ? 60 : /d/i.test(m[2]) ? 390 : 1); };

function label(m) { if (m === null || !Number.isFinite(m)) return 'NO_DATA'; return m >= 0.25 ? 'CORRECT' : m <= -0.25 ? 'WRONG' : 'FLAT'; }

// -> the decision's measurements, or { error } when it cannot be measured.
function measure(d, rows, days, { daily = [] } = {}) {
  if (!Number.isFinite(d.t0)) return { error: 'decision time not recorded' };
  if (!d.d) return { error: 'direction unknown' };
  const path = isStock(d) ? regular(rows) : rows;
  const t0 = d.t0;
  const p0Source = d.p0 > 0 ? 'RECORDED' : 'FETCHED';
  const p0 = d.p0 > 0 ? d.p0 : priceAt(path, t0);
  if (!(p0 > 0)) return { error: 'no price at the decision time' };
  let u = d.levels ? Math.abs(d.levels.entry - d.levels.stop) : null; let unit = 'R (entry - stop)';
  if (!(u > 0)) { const tf = tfMinutes(d.timeframe); u = tf >= 390 ? dailyAtr(daily, t0) : atrBefore(path, t0, tf); unit = `ATR(14) ${d.timeframe || ''}`.trim(); }
  if (!(u > 0)) return { error: 'no unit (no levels and no ATR before the decision)' };
  const H = plannedEnd(d, t0, days);
  const sessionDay = isStock(d) ? (T.inSession(t0) ? T.ymd(t0) : days.find((x) => T.sessionClose(x) > t0)) : null;
  const points = [...HORIZONS.map((h) => ({ key: `${h}m`, t: horizonTime(d, t0 + h * T.MIN, days) })),
    ...(sessionDay ? [{ key: 'close', t: T.sessionClose(sessionDay) }] : [{ key: 'close', t: horizonTime(d, T.at(T.ymd(t0), 16 * 60), days) }]),
    { key: 'H', t: H.endAt, final: true }];
  const now = Date.now();
  const at = points.map((p) => {
    if (!p.t || p.t > now) return { ...p, pending: true, label: 'PENDING', m: null };
    const cov = coverage(d, path, t0, p.t);
    const px = priceAt(path, p.t);
    const m = px > 0 ? (d.d * (px - p0)) / u : null;
    return { ...p, price: px, coverage: cov, m, label: cov < 0.9 ? 'NO_DATA' : label(m), interim: !p.final };
  });
  const end = Math.min(H.endAt || now, now);
  const seg = path.filter((r) => r[0] >= t0 && r[0] < end);
  return { p0, p0Source, u, unit, H, horizons: at, pathCoverage: coverage(d, path, t0, end), complete: !!H.endAt && H.endAt <= now, ...pathStats(d, seg, p0, u, path, days, daily) };
}

function dailyAtr(daily, t0) {
  const pre = daily.filter((r) => r[0] < t0).slice(-15);
  const tr = []; for (let i = 1; i < pre.length; i += 1) tr.push(Math.max(pre[i][2] - pre[i][3], Math.abs(pre[i][2] - pre[i - 1][4]), Math.abs(pre[i][3] - pre[i - 1][4])));
  return tr.length >= 5 ? tr.reduce((s, x) => s + x, 0) / tr.length : null;
}

// MFE / MAE in u, the first touch of the stop and of T1 (a same-minute tie counts as the stop), and the pre-decision move.
function pathStats(d, seg, p0, u, all, days, daily) {
  let mfe = 0; let mae = 0; let stopAt = null; let t1At = null; let mfeBeforeStop = 0;
  const L = d.levels;
  for (const r of seg) {
    const fav = d.d > 0 ? (r[2] - p0) / u : (p0 - r[3]) / u;
    const adv = d.d > 0 ? (r[3] - p0) / u : (p0 - r[2]) / u;
    if (L && stopAt === null && (d.d > 0 ? r[3] <= L.stop : r[2] >= L.stop)) stopAt = r[0];
    if (L && t1At === null && (stopAt === null || stopAt > r[0]) && (d.d > 0 ? r[2] >= L.t1 : r[3] <= L.t1)) t1At = r[0];
    mfe = Math.max(mfe, fav); mae = Math.min(mae, adv);
    if (stopAt === null) mfeBeforeStop = Math.max(mfeBeforeStop, fav);
  }
  if (L && stopAt !== null && t1At === stopAt) t1At = null;
  let t1After = null;
  if (L && stopAt !== null) { const after = seg.find((r) => r[0] > stopAt && (d.d > 0 ? r[2] >= L.t1 : r[3] <= L.t1)); t1After = after ? after[0] : null; }
  const intraday = INTRADAY.has(d.strategyId) || tfMinutes(d.timeframe) < 390;
  let pre = null; let preLabel = intraday ? '60 min' : '5 sessions';
  if (intraday) { const px = priceAt(all, d.t0 - 60 * T.MIN); pre = px > 0 ? (d.d * (p0 - px)) / u : null; }
  else { const before = daily.filter((r) => r[0] < T.at(T.ymd(d.t0), 0)); const ref = before[before.length - 5]; pre = ref ? (d.d * (p0 - ref[4])) / u : null; }
  return { mfe, mae, mfeBeforeStop, stopAt, t1At, t1AfterStop: t1After, preMove: pre, preMoveWindow: preLabel };
}

module.exports = { measure, plannedEnd, priceAt, coverage, atrBefore, dailyAtr, tfMinutes, label, HORIZONS };
