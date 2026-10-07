// Phase 95 Task 4.1 (spec 8.1): moves at three scales (zigzag on 1-minute closes at 1 / 2 / 4 x ATR30), nested into UP / DOWN /
// REBOUND, QUIET stretches, the confirmation time of every pivot, ATR30 from PRIOR sessions only. Synthetic paths with hand-computed
// pivots. Run: node tests/ph95observe.js
const path = require('path');
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const O = require(path.join(__dirname, '..', 'tools', 'research', 'observe'));

const T0 = Date.parse('2026-10-08T13:30:00Z'); // 09:30 ET
const series = (pts) => { // pts: [[minute, price], ...] linear in between -> 1-minute bars
  const bars = [];
  for (let k = 0; k < pts.length - 1; k += 1) {
    const [m0, p0] = pts[k]; const [m1, p1] = pts[k + 1];
    for (let m = m0; m < m1; m += 1) { const c = Math.round((p0 + ((p1 - p0) * (m - m0)) / (m1 - m0)) * 1000) / 1000; bars.push({ t: T0 + m * 60000, o: c, h: c, l: c, c, v: 100 }); }
  }
  const [mL, pL] = pts[pts.length - 1]; bars.push({ t: T0 + mL * 60000, o: pL, h: pL, l: pL, c: pL, v: 100 });
  return bars;
};
const at = (m) => T0 + m * 60000; const end = (m) => at(m) + 60000;

// Fixture A: 100 -> 103 (0-30) -> 101.8 (30-42) -> 106 (42-84) -> 103.5 (84-109); ATR30 = 1.
const A = series([[0, 100], [30, 103], [42, 101.8], [84, 106], [109, 103.5]]);
const S = O.zigzag(A, 1.0); const M = O.zigzag(A, 2.0);
check('zigzag S (1 ATR): pivots 0 low, 30 high, 42 low, 84 high; the last move open', S.map((m) => `${(m.start.t - T0) / 60000}->${(m.end.t - T0) / 60000}${m.open ? '*' : ''}`).join(' ') === '0->30 30->42 42->84 84->109*',
  S.map((m) => `${(m.start.t - T0) / 60000}->${(m.end.t - T0) / 60000}${m.open ? '*' : ''}`).join(' '));
// 103 confirmed when close <= 102: minute 30 + 10/ (1.2/12 per min = 0.1) -> minute 40; 101.8 confirmed when >= 102.8: 0.1/min from 42 -> minute 52
check('confirmation: the high at 30 is known at the END of the minute-40 bar (close 102.0), the low at 42 at the end of minute 52', S[0].confirmedAt === end(40) && S[1].confirmedAt === end(52),
  `${(S[0].confirmedAt - T0) / 60000} ${(S[1].confirmedAt - T0) / 60000}`);
check('confirmation is never before the end pivot: no hindsight object is dated earlier than it could be known', S.filter((m) => !m.open).every((m) => m.confirmedAt > m.end.t));
check('zigzag M (2 ATR): one UP 0 -> 84 (high confirmed when <= 104 at minute 104), then an open DOWN', M.length === 2 && M[0].dir === 1 && (M[0].end.t - T0) / 60000 === 84
  && M[0].confirmedAt === end(104) && M[1].open && M[1].dir === -1, JSON.stringify(M.map((m) => [m.dir, (m.end.t - T0) / 60000, m.open])));
check('size in % and in ATR; duration; volume summed over the move', Math.abs(S[0].sizeAtr - 3) < 1e-9 && Math.abs(S[0].sizePct - 3) < 1e-9 && S[0].durationMin === 30 && S[0].volume === 3100,
  JSON.stringify([S[0].sizeAtr, S[0].sizePct, S[0].durationMin, S[0].volume]));
const tree = O.nest({ S, M, L: O.zigzag(A, 4.0) });
check('nesting: S moves inside the M UP are UP, UP-against-parent... the 103 -> 101.8 pullback is a REBOUND', tree.S.map((m) => m.type).join() === 'UP,REBOUND,UP,DOWN',
  tree.S.map((m) => `${m.type}<${m.parentIdx}`).join());
check('nesting: each S move names its M parent', tree.S[1].parentIdx === 0 && tree.S[3].parentIdx === 1);

// Fixture B: quiet 40 minutes (range 0.2 < 0.75 ATR) between moves.
const B = series([[0, 100], [20, 102], [60, 102.2], [80, 99]]);
const q = O.quiet(B, 1.0);
check('QUIET: the 20 -> 60 stretch (range 0.2 < 0.75 ATR) is covered by one QUIET period of >= 30 min (it may begin a little earlier: the band is 0.75 ATR)', q.length === 1 && q[0].start <= at(20) && q[0].end >= at(60)
  && q[0].durationMin >= 30, JSON.stringify(q.map((x) => [(x.start - T0) / 60000, (x.end - T0) / 60000, x.durationMin])));
check('QUIET: a trending path has none', O.quiet(series([[0, 100], [100, 110]]), 1.0).length === 0);

// ATR30 from daily bars strictly BEFORE the session.
const daily = Array.from({ length: 35 }, (_, k) => ({ day: `2026-08-${String(k + 1).padStart(2, '0')}`, h: 101 + (k === 34 ? 50 : 0), l: 99, c: 100 }));
const atr = O.atr30(daily, '2026-08-35');
check('ATR30: the mean true range of the 30 sessions before the session day (the session itself excluded)', atr.atr === 2 && atr.sessions === 30, JSON.stringify(atr));
check('ATR30: fewer than 10 prior sessions -> null with a reason (never a guess)', O.atr30(daily.slice(0, 5), '2026-08-06').atr === null);

// --- persistence: daily bars (for ATR30) + moves / quiet per symbol-day, idempotent ---
(async () => {
  const fs = require('fs'); const os = require('os');
  const W = require(path.join(__dirname, '..', 'tools', 'research', 'db'));
  const Bm = require(path.join(__dirname, '..', 'tools', 'research', 'bars'));
  const { createLimiter } = require(path.join(__dirname, '..', 'server', 'research', 'collector', 'budget'));
  const db = W.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph95o-')), 'research.sqlite'));
  const tabs = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
  check('schema: bars_1d, moves, quiet_periods, observe_days', ['bars_1d', 'moves', 'quiet_periods', 'observe_days'].every((x) => tabs.includes(x)), tabs.join());
  const dayList = []; for (let k = 1; k <= 31; k += 1) dayList.push(`2026-08-${String(k).padStart(2, '0')}`);
  const fakeDaily = async (url) => { const u = new URL(url); return { ok: true, status: 200, json: async () => ({ bars: dayList.map((d) => ({ t: `${d}T04:00:00Z`, o: 100, h: 101, l: 99, c: 100, v: 1e6 })), next_page_token: null, _q: u.search }) }; };
  let t = 0; const limiter = createLimiter({ perMin: 60, now: () => t, sleep: async (ms) => { t += ms; } });
  const rd = await Bm.fetchDaily(db, { symbols: ['AMZN'], from: '2026-08-01', to: '2026-10-08', fetchImpl: fakeDaily, limiter, keys: { key: 'k', secret: 's' }, base: 'http://d.test' });
  check('daily bars: stored per (symbol, day) in New York dates', rd.rows === 31 && db.prepare("select count(*) c from bars_1d where symbol = 'AMZN'").get().c === 31);
  W.upsertBars(db, A.map((b) => ({ symbol: 'AMZN', ...b, feed: 'sip' })));
  db.prepare("insert into bars_days (symbol, day, rows, status, fetched_at) values ('AMZN', '2026-10-08', ?, 'ok', 0)").run(A.length);
  const r1 = O.observeDays(db, { symbols: ['AMZN', 'NOBARS'], days: ['2026-10-08'] });
  const mv = db.prepare("select scale, k, type, open from moves where symbol = 'AMZN' and day = '2026-10-08' order by scale, k").all();
  // ATR30 = 2 here, so S = 2.0: UP 0 -> 84, then a pullback inside the still-open M (4.0) up move = REBOUND; L (8.0) has no move
  check('observeDays: every scale stored with its nesting type and open flag; a status row per symbol-day', mv.filter((m) => m.scale === 'S').map((m) => m.type).join() === 'UP,REBOUND'
    && mv.filter((m) => m.scale === 'M').length === 1 && mv.filter((m) => m.scale === 'L').length === 0 && mv.find((m) => m.scale === 'M').open === 1,
    JSON.stringify(r1));
  const od = db.prepare("select * from observe_days where symbol = 'AMZN'").get();
  check('observeDays: ATR30 from the 30 PRIOR daily bars (here 2.0... the fixture gives h-l = 2) recorded with the day', od && Math.abs(od.atr - 2) < 1e-9 && od.atr_sessions === 30, JSON.stringify(od));
  const nMoves = db.prepare('select count(*) c from moves').get().c;
  O.observeDays(db, { symbols: ['AMZN'], days: ['2026-10-08'] });
  check('observeDays: a re-run replaces the day (same count), never duplicates', db.prepare('select count(*) c from moves').get().c === nMoves);
  check('observeDays: a symbol without bars for the day is NO_BARS (recorded, not skipped silently)', db.prepare("select status from observe_days where symbol = 'NOBARS'").get().status === 'NO_BARS');
  db.prepare('delete from bars_1d').run();
  O.observeDays(db, { symbols: ['AMZN'], days: ['2026-10-08'] });
  check('observeDays: without enough prior daily bars the day is NO_ATR with its reason (no moves invented)', db.prepare("select status, reason from observe_days where symbol = 'AMZN'").get().status === 'NO_ATR');
  db.close();
  console.log(`\nph95observe: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
