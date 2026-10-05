// Phase 93 Decision Review analyzer (tools/decision-review), on SYNTHETIC bars: every spec section 5 rule and its precedence, horizon
// edge cases, INCOMPLETE, the opposite side, fills / exits / costs, option prints, rule checks, loss causes, pattern statistics, the
// loader's reconstruction. Run: node tests/ph93review.js. No network: market data is never fetched here.
const fs = require('fs'); const os = require('os'); const path = require('path');
global.fetch = async () => { throw new Error('test: no network'); };
const R = path.join(__dirname, '..', 'tools', 'decision-review') + '/';
const T = require(R + 'time'); const { measure } = require(R + 'measure'); const { classify, opposite } = require(R + 'classify');
const sim = require(R + 'simulate'); const { check } = require(R + 'safeguards'); const { attribute } = require(R + 'attribute');
const pat = require(R + 'patterns'); const { load } = require(R + 'load');
let fails = 0;
const check_ = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// A three-session minute path (Fri 2026-09-11, Mon 09-14, Tue 09-15). f(i) -> price at minute i (0 = 9:30 Fri; the decision is Mon 10:00).
const DAYS = ['2026-09-11', '2026-09-14', '2026-09-15'];
function path2(f, { drop = () => false, hiLo = () => 0.02 } = {}) {
  const rows = [];
  let i = 0;
  for (const day of DAYS) for (let m = T.OPEN_MIN; m < T.CLOSE_MIN; m += 1) { const p = f(i); if (!drop(i)) rows.push([T.at(day, m), p, p + hiLo(i), p - hiLo(i), p, 1000]); i += 1; }
  return rows;
}
const t0 = T.at('2026-09-14', 10 * 60); // 10:00 ET Monday: path index 30
const dec = (extra = {}) => ({ id: 'x', strategyId: 'equity-day', market: 'stocks', d: 1, direction: 'long', timeframe: '5m', t0, p0: 100, setupType: 'ORB',
  levels: { entry: 100, entryZone: { min: 99.9, max: 100 }, stop: 99, t1: 102, t1Share: 0.5, t2: 103 }, events: [], outcome: { group: 'ACCEPTED' }, missing: [], ...extra });
const run = (f, extra, opts) => { const rows = path2(f, opts); const d = dec(extra); const m = measure(d, rows, DAYS.slice(1), { daily: [] }); return { d, m, rows, c: classify(d, m) }; };
const at = (i) => i - 420; // minutes after t0 (index 0 = 9:30 the Friday before)

(async () => {
  // ---------- 1. Fixed classes and their precedence ----------
  let x = run((i) => (at(i) < 30 ? 100 + at(i) * 0.02 : Math.min(102.5, 100.6 + (at(i) - 30) * 0.05)));
  check_('CORRECT_DIRECTION: T1 reached first', x.c.cls === 'CORRECT_DIRECTION', x.c.why);
  x = run((i) => Math.max(98.5, 100 - Math.max(0, at(i)) * 0.06));
  check_('WRONG_DIRECTION: stopped with MFE < 0.5', x.c.cls === 'WRONG_DIRECTION', x.c.why);
  x = run((i) => (at(i) <= 20 ? 100 - Math.max(0, at(i)) * 0.06 : Math.min(102.6, 98.8 + (at(i) - 20) * 0.05)));
  check_('EARLY_ENTRY: stopped first, then T1 within the holding period', x.c.cls === 'EARLY_ENTRY', x.c.why);
  x = run((i) => (at(i) <= 20 ? 100 + Math.max(0, at(i)) * 0.04 : Math.max(98.5, 100.8 - (at(i) - 20) * 0.06)));
  check_('REVERSAL_AFTER_ENTRY: MFE >= 0.5 first, then the stop, no T1', x.c.cls === 'REVERSAL_AFTER_ENTRY', x.c.why);
  // 60 calendar minutes before Mon 10:00 is Fri's close: flat 98.6 on Friday, up to 100 in Monday's first half hour (+1.4u), then it fails.
  x = run((i) => (at(i) < -30 ? 98.6 : at(i) < 0 ? 98.6 + (at(i) + 30) * (1.4 / 30) : Math.max(98.5, 100 - at(i) * 0.06)));
  check_('LATE_ENTRY: pre-move >= 1 unit before the decision, then failed (beats WRONG in the order)', x.c.cls === 'LATE_ENTRY' && x.m.preMove >= 1, `${x.c.why}`);
  x = run((i) => 100 + (at(i) === 15 ? 0 : 0), {}, { hiLo: (i) => (at(i) === 15 ? 3.1 : 0.02) });
  check_('same-minute tie (T1 and stop in one bar): counts as the STOP', x.m.stopAt !== null && x.m.t1At === null && x.c.cls === 'WRONG_DIRECTION', x.c.cls);
  x = run((i) => 100 + 0.1 * Math.sin(i / 10));
  check_('UNCLEAR (no decisive move): neither level, |m(H)| < 0.25', x.c.cls === 'UNCLEAR' && /No decisive/.test(x.c.why));
  x = run((i) => 100 + 0.1 * Math.sin(i / 10), {}, { drop: (i) => i % 4 === 0 });
  check_('UNCLEAR (coverage): 25% of the minute bars missing -> path coverage < 90%', x.c.cls === 'UNCLEAR' && /coverage/.test(x.c.why), x.c.why);
  x = run((i) => 100 + Math.max(0, at(i)) * 0.01, { levels: null });
  check_('INCOMPLETE: no levels -> horizon labels only, unit = ATR(14) of the setup timeframe', x.c.cls === 'INCOMPLETE' && /ATR/.test(x.m.unit) && x.m.horizons.length === 6);
  x = run((i) => 100, { t0: Date.now() - 10 * 60000, strategyId: 'equity-swing' });
  check_('PENDING: the planned holding period has not ended', ['PENDING', 'NOT_MEASURABLE'].includes(x.c.cls));

  // ---------- 2. Horizons: interim vs completed, after-hours mapping, opposite ----------
  x = run((i) => 100 + Math.max(0, at(i)) * 0.01);
  const hz = Object.fromEntries(x.m.horizons.map((h) => [h.key, h]));
  check_('horizons: 5 / 15 / 30 / 60 min, close, planned end; only the planned end is "completed"', Object.keys(hz).join() === '5m,15m,30m,60m,close,H' && hz.H.final && hz['5m'].interim && !hz.H.interim);
  check_('labels: +0.05u at 5 min FLAT, +0.3u at 30 min CORRECT', hz['5m'].label === 'FLAT' && hz['30m'].label === 'CORRECT', `${hz['5m'].m} ${hz['30m'].m}`);
  const late = dec({ t0: T.at('2026-09-14', 15 * 60 + 50) });
  const ml = measure(late, path2((i) => 100 + i * 0.001), DAYS.slice(1), {});
  const h30 = ml.horizons.find((h) => h.key === '30m');
  check_('a horizon past the close moves to the next session\'s first minute', T.ymd(h30.t) === '2026-09-15' && T.minuteOf(h30.t) === T.OPEN_MIN);
  const op = opposite(x.d, x.m);
  check_('opposite direction on the same path: reversed sign and label', op && near(op.m, -hz.H.m) && op.label === (hz.H.m >= 0.25 ? 'WRONG' : hz.H.m <= -0.25 ? 'CORRECT' : 'FLAT'));

  // ---------- 3. Fills, exits, costs ----------
  const rows = path2((i) => (at(i) < 1 ? 100.5 : at(i) < 40 ? 100.5 - at(i) * 0.02 : 99.7 + (at(i) - 40) * 0.08));
  const base = { d: 1, entry: { type: 'zone', min: 99.9, max: 100 }, stop: 99, t1: 102, t1Share: 0.5, t2: 103, t0, endAt: T.sessionClose('2026-09-15'), windowMs: 30 * 60000, slip: 0.0005, feePct: 0 };
  let s = sim.trade(rows, base);
  check_('entry: fills only when price trades back through the zone within the window (at the zone edge)', s.filled && near(s.rawFill, 100) && s.fillAt > t0 + 60000);
  check_('T1 closes its 50% share, the runner keeps the same stop and reaches T2', s.exits.map((e) => e.reason).join() === 'T1,T2' && near(s.exits[0].share, 0.5));
  check_('slippage makes net R lower than gross R', s.rNet < s.rGross, `${s.rNet} vs ${s.rGross}`);
  s = sim.trade(path2(() => 101), base);
  check_('never back in the zone within 30 min -> ENTRY_NOT_FILLED', s.filled === false && /ENTRY_NOT_FILLED/.test(s.why));
  const gapRows = path2((i) => (at(i) < 5 ? 100 : 98)); // gaps under the stop
  s = sim.trade(gapRows, { ...base, entry: { type: 'market' } });
  check_('a gap through the stop fills at the bar open (worse than the stop), < -1R', s.exits[0].reason === 'STOP' && s.rNet < -1);
  s = sim.trade(path2((i) => (at(i) < 2 ? 99 : 99.5)), { ...base, entry: { type: 'market' } });
  check_('a fill at / through the stop is INVALIDATED (the approval guard refuses it), not a trade', s.filled === false && /INVALIDATED/.test(s.why));
  s = sim.trade(path2((i) => (at(i) < 5 ? 99.05 : 98.9)), { ...base, entry: { type: 'market' }, riskUnit: 1 });
  check_('R uses the PLANNED risk (a fill 0.05 above the stop loses about -0.15R, never -3R)', s.filled && s.rNet > -0.3 && s.rNet < 0, String(s.rNet));
  const crypto = sim.trade(path2((i) => 100 + Math.max(0, at(i)) * 0.05), { ...base, entry: { type: 'market' }, t2: null, t1Share: 1, feePct: 0.009 });
  check_('crypto taker fees (0.90% / side) are charged on entry and exit', crypto.filled && crypto.rNet < crypto.rGross - 0.5, `${crypto.rNet} vs ${crypto.rGross}`);

  // ---------- 4. Option prints (ESTIMATE / UNAVAILABLE) ----------
  const opt = (f, n = 60) => Array.from({ length: n }, (_, k) => { const p = f(k); return [t0 + (k + 2) * 60000, p, p + 0.05, p - 0.05, p, 10]; });
  let o = sim.optionPrints([{ side: 'buy', rows: opt((k) => 5 + k * 0.05) }], { debit: 5, halfSpread: 0.05, stopValue: 3.5, targetValue: 7.25, endAt: t0 + 61 * 60000, confirmations: 2 }, t0);
  check_('prints: target reached -> exit at the target value, labelled an estimate', o.tier === 'ESTIMATE' && o.exit.reason === 'TARGET' && /estimate/.test(o.label));
  o = sim.optionPrints([{ side: 'buy', rows: opt((k) => (k === 10 ? 3.4 : k > 20 ? 3.3 : 5)) }], { debit: 5, halfSpread: 0.05, stopValue: 3.5, targetValue: 7.25, endAt: t0 + 61 * 60000, confirmations: 2 }, t0);
  check_('prints: one print under the stop is not enough (2 confirmations); two in a row stop it', o.exit.reason === 'STOP' && o.exit.at >= t0 + 23 * 60000);
  o = sim.optionPrints([{ side: 'buy', rows: opt((k) => 5, 3) }], { debit: 5, halfSpread: 0.05, stopValue: 3.5, targetValue: 7.25, endAt: t0 + 61 * 60000 }, t0);
  check_('prints: too few prints -> UNAVAILABLE, never guessed', o.tier === 'UNAVAILABLE');

  // ---------- 5. Rule checks ----------
  const rej = (reason, more = {}) => ({ outcome: { group: 'REJECTED', reason }, events: [{ path: 'PIPELINE_REJECT', reason, setup: { execution: 'PAPER' } }], source: 'RECORDED', ...more });
  check_('daily loss: recorded kill switch ON -> CONSISTENT; OFF -> INCONSISTENT; no record -> NOT_VERIFIABLE',
    check(rej('DAILY_LOSS_LIMIT_REACHED: x', { guard: { kill: { paper: { active: true } } } })).verdict === 'CONSISTENT'
    && check(rej('DAILY_LOSS_LIMIT_REACHED: x', { guard: { kill: { paper: { active: false } } } })).verdict === 'INCONSISTENT'
    && check(rej('DAILY_LOSS_LIMIT_REACHED: x')).verdict === 'NOT_VERIFIABLE');
  check_('earnings shield: 2 trading days -> CONSISTENT, 5 -> INCONSISTENT', check(rej('EARNINGS_SOON: reports 2026-10-08, 2 trading day(s) away')).verdict === 'CONSISTENT'
    && check(rej('EARNINGS_SOON: reports 2026-10-08, 5 trading day(s) away')).verdict === 'INCONSISTENT');
  const exp = { outcome: { group: 'REJECTED', reason: 'EXPIRED: unapproved after 30m' }, events: [{ path: 'STAGED', at: 0 }, { path: 'EXPIRED', at: 30.5 * 60000, reason: 'EXPIRED: unapproved after 30m' }], source: 'RECORDED' };
  check_('expiry: staged 30.5 min before expiring with a 30 min window -> CONSISTENT', check(exp).verdict === 'CONSISTENT');
  check_('ORB volume filter verified from the RECORDED inputs (1.2x < 1.5x)', check(rej('ORB_FILTER: Breakout volume too low', { context: { values: { volumeRatio: 1.2 } } })).verdict === 'CONSISTENT');
  check_('no live price is a data gap, not a safeguard', check(rej('NO_LIVE_PRICE: market open')).verdict === 'NOT_A_SAFEGUARD');

  // ---------- 6. "Direction correct, trade lost": evidence-backed causes only ----------
  let a = attribute(dec(), x.m, 'CORRECT_DIRECTION', { rNet: -0.1, rGross: 0.05, filled: true });
  check_('COSTS_EXCEEDED_EDGE only when gross >= 0 and net < 0', a.causes.some((c) => c.cause === 'COSTS_EXCEEDED_EDGE'));
  a = attribute(dec({ market: 'options', option: {} }), x.m, 'CORRECT_DIRECTION', { rNet: -0.4, filled: true });
  check_('an option loss with no recorded bid / ask is UNATTRIBUTED, saying what is missing', a.causes[0].cause === 'UNATTRIBUTED' && /bid \/ ask/.test(a.causes[0].evidence));
  a = attribute(dec({ market: 'options', option: { bid: 4.9, ask: 5.1, delta: 0.5 }, realized: { exits: [{ exitReason: 'MANUAL_CLOSE' }] } }), x.m, 'CORRECT_DIRECTION', { rNet: -0.3, filled: true });
  check_('closed by hand, then the move came: CLOSED_BY_HAND_BEFORE_MOVE; never TIME_DECAY / VOLATILITY_CRUSH without an exit IV', a.causes.some((c) => c.cause === 'CLOSED_BY_HAND_BEFORE_MOVE')
    && !a.causes.some((c) => /TIME_DECAY|VOLATILITY/.test(c.cause)) && a.gaps.some((g) => /IV/.test(g)));
  check_('no cause is assigned to a trade that made money or to a wrong call', attribute(dec(), x.m, 'CORRECT_DIRECTION', { rNet: 0.5 }) === null && attribute(dec(), x.m, 'WRONG_DIRECTION', { rNet: -1 }) === null);

  // ---------- 7. Pattern statistics ----------
  const [lo, hi] = pat.wilson(5, 10);
  check_('Wilson 95% interval for 5 / 10 is about [0.24, 0.76]', near(lo, 0.2366, 0.002) && near(hi, 0.7634, 0.002));
  const rowsP = Array.from({ length: 90 }, (_, i) => ({ id: `p${i}`, feat: { timeOfDay: i < 30 ? '9:30-10:00' : '12:00-14:00', strategy: 'equity-day' }, wrong: i < 30 ? true : i % 3 === 0, missed: null }));
  const P = pat.analyze(rowsP);
  const f9 = P.flagged.find((t) => t.feature === 'timeOfDay' && t.bin === '9:30-10:00' && t.metric === 'wrong');
  check_('a bin with 30 / 30 wrong vs 20 / 60 elsewhere is flagged after the false-discovery correction', !!f9 && f9.q <= 0.1, f9 && `q ${f9.q}`);
  const small = pat.analyze(rowsP.slice(0, 15).concat(rowsP.slice(60)));
  check_('bins under 20 setups are never flagged', !small.flagged.some((t) => t.n < 20));

  // ---------- 8. Loader: recorded first, ledger outcomes, reconstruction flags ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph93r-'));
  fs.mkdirSync(path.join(dir, 'decisions'));
  const recAt = Date.parse('2026-10-06T14:00:00Z');
  fs.writeFileSync(path.join(dir, 'decisions', 'decisions-2026-10-06.jsonl'), [
    { type: 'series', key: 'b:K', name: 'session1m', symbol: 'AAA', tf: '1m', kind: 'bars', rows: [[recAt - 60000, 1, 1, 1, 1, 1]] },
    { type: 'decision', at: recAt, path: 'STAGED', id: 'equity-day:ORB:AAA:2026-10-06', setup: { asset: 'AAA', market: 'stocks', strategyId: 'equity-day', direction: 'long', entryZone: { min: 10, max: 10.1 }, invalidation: 9.8, targets: [{ price: 10.7, allocation: 0.5 }] },
      price: { last: 10.05 }, context: { values: { orHigh: 10 }, series: [{ name: 'session1m', key: 'b:K' }] }, guard: { maxOpenRiskPct: 0.06 } },
    { type: 'decision', at: recAt + 60000, path: 'OPENED', id: 'equity-day:ORB:AAA:2026-10-06', setup: { asset: 'AAA' } },
    { type: 'status', at: recAt + 600000, recordedToday: 2, dropped: 0, writeErrors: 0, serializeErrors: 0, missingContext: 0 }].map((l) => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(dir, 'ledger-snapshot.json'), JSON.stringify({ tradeJournal: [
    { id: 'equity-day:ORB:AAA:2026-10-06:part:1', parentId: 'equity-day:ORB:AAA:2026-10-06', asset: 'AAA', netPnl: 20, dollarRisk: 10, exitReason: 'TAKE_PROFIT_T1', closedAt: recAt + 3600000, openedAt: recAt + 60000 },
    { id: 'equity-day:ORB:AAA:2026-10-06', asset: 'AAA', netPnl: -5, dollarRisk: 10, exitReason: 'STOP_LOSS', closedAt: recAt + 7200000, openedAt: recAt + 60000 },
    { id: 'equity-swing:PULLBACK:BBB:2026-10-07', asset: 'BBB', market: 'stocks', strategyId: 'equity-swing', direction: 'long', stagedAt: recAt + 86400000, entryPrice: 50, invalidation: 48, targets: [{ price: 54 }], netPnl: 3, dollarRisk: 20, closedAt: recAt + 2 * 86400000 }],
    activePositions: [], discardedOrders: [{ id: 'options-system:TREND:CALL:CCC:2026-09-30', asset: 'CCC', market: 'options', strategyId: 'options-system', status: 'discarded', stagedAt: Date.parse('2026-09-30T15:00:00Z'), discardedAt: Date.parse('2026-09-30T15:31:00Z') }] }));
  fs.writeFileSync(path.join(dir, 'pm2-logs.txt'), '0|signalde | [pipeline] rejected equity-day:ORB:DDD:2026-09-29: Cost ceiling exceeded\n');
  const L = load(dir);
  const g = (id) => L.decisions.find((d) => d.id === id);
  const aaa = g('equity-day:ORB:AAA:2026-10-06');
  check_('loader: a RECORDED setup keeps its snapshot (t0, P0, inputs, guard) and gets the LEDGER result: T1 part + runner = one trade (+$15, +0.75R)', aaa.source === 'RECORDED' && aaa.p0 === 10.05
    && aaa.context.series[0].data.rows.length === 1 && aaa.guard && near(aaa.realized.netPnl, 15) && near(aaa.realized.rNet, 0.75) && aaa.outcome.group === 'ACCEPTED');
  check_('loader: a ledger trade AFTER the recorder started with no recorded decision is a MISSING record', L.recorder.missingRecords.some((r) => r.id === 'equity-swing:PULLBACK:BBB:2026-10-07'));
  const ccc = g('options-system:TREND:CALL:CCC:2026-09-30');
  check_('loader: a discarded setup says its reason was not stored', ccc.outcome.path === 'DISCARDED' && ccc.missing.some((m) => /not stored/.test(m)));
  const ddd = g('equity-day:ORB:DDD:2026-09-29');
  check_('loader: a log-line rejection is RECONSTRUCTED and INCOMPLETE, with no invented time', ddd.source === 'RECONSTRUCTED' && ddd.incomplete && ddd.t0 === null && ddd.missing.some((m) => /decision time/.test(m)));
  check_('loader: the recorder\'s latest status line is read (drops / errors for the report header)', L.recorder.lastStatus && L.recorder.lastStatus.recordedToday === 2);

  console.log(`\nph93review: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
