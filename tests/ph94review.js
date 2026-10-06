// Phase 94 Stage 0 (analyzer): S0-2 / C1 no future price before the decision or at a checkpoint, S0-3 / C1 per-event guards + separate
// times (a later lifecycle event is never the decision), S0-4 matched original / opposite simulations, S0-5 harness separation + crypto
// coverage pin + target-order flag, and the change report. Synthetic bars, no network. Run: node tests/ph94review.js
const fs = require('fs'); const os = require('os'); const path = require('path');
global.fetch = async () => { throw new Error('test: no network'); };
const R = path.join(__dirname, '..', 'tools', 'decision-review') + '/';
const T = require(R + 'time'); const M = require(R + 'measure'); const { measure } = M; const { classify } = require(R + 'classify');
const sim = require(R + 'simulate'); const { check } = require(R + 'safeguards'); const pat = require(R + 'patterns'); const { load } = require(R + 'load');
let fails = 0;
const check_ = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const DAYS = ['2026-09-11', '2026-09-14', '2026-09-15'];
function path2(f, { hiLo = () => 0.02 } = {}) {
  const rows = []; let i = 0;
  for (const day of DAYS) for (let m = T.OPEN_MIN; m < T.CLOSE_MIN; m += 1) { const p = f(i); rows.push([T.at(day, m), p, p + hiLo(i), p - hiLo(i), p, 1000]); i += 1; }
  return rows;
}
const t0 = T.at('2026-09-14', 10 * 60); // Mon 10:00:00 ET = path index 420
const at = (i) => i - 420;
const dec = (extra = {}) => ({ id: 'x', strategyId: 'equity-day', market: 'stocks', d: 1, direction: 'long', timeframe: '5m', t0, p0: 100, setupType: 'ORB',
  levels: { entry: 100, entryZone: { min: 99.9, max: 100 }, stop: 99, t1: 102, t1Share: 0.5, t2: 103 }, events: [], outcome: { group: 'ACCEPTED' }, missing: [], ...extra });
const dailyRows = (rangeToday) => ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
  '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14'].map((day, k, all) => { const r = k === all.length - 1 ? rangeToday : 1; return [T.at(day, 0), 100, 100 + r / 2, 100 - r / 2, 100, 1e6]; });
const jsonl = (dir, day, lines) => { fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true }); fs.writeFileSync(path.join(dir, 'decisions', `decisions-${day}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };

(async () => {
  // ---------- S0-2: the unfinished decision-minute bar never enters a pre-decision value ----------
  const mid = t0 + 30000; // 10:00:30: the 10:00 bar is still forming
  const spike = path2((i) => (at(i) === 0 ? 130 : 100), { hiLo: (i) => (at(i) === 0 ? 30 : 0.02) });
  let m = measure(dec({ t0: mid, p0: null }), spike, DAYS.slice(1), { daily: [] });
  check_('S0-2: P0 (no recorded price) = the last bar that ENDED by t0, not the forming 10:00 bar', m.p0 === 100 && m.p0Source === 'FETCHED', `${m.p0} ${m.p0Source}`);
  m = measure(dec({ t0: mid, p0: null, levels: null }), spike, DAYS.slice(1), { daily: [] });
  const calm = measure(dec({ t0: mid, p0: null, levels: null }), path2(() => 100), DAYS.slice(1), { daily: [] });
  check_('S0-2: the ATR unit excludes the forming bar (same unit with and without the spike in it)', Math.abs(m.u - calm.u) < 1e-9, `${m.u} vs ${calm.u}`);
  const b = measure(dec({ t0, p0: null }), spike, DAYS.slice(1), { daily: [] });
  check_('S0-2: on a minute boundary (10:00:00) the 09:59 bar is complete and the 10:00 bar is not used', b.p0 === 100, b.p0);
  check_('S0-2: daily ATR excludes the decision day\'s daily bar', Math.abs(M.dailyAtr(dailyRows(50), t0) - 1) < 1e-9, M.dailyAtr(dailyRows(50), t0));
  const f1 = pat.features(dec({ t0: mid }), { p0: 100, preMove: 0 }, { minute: spike, daily: dailyRows(1), spyMinute: spike, spyDaily: dailyRows(1) });
  const f2 = pat.features(dec({ t0: mid }), { p0: 100, preMove: 0 }, { minute: path2(() => 100), daily: dailyRows(1), spyMinute: path2(() => 100), spyDaily: dailyRows(1) });
  check_('S0-2: VWAP distance / SPY vs VWAP ignore the forming bar', f1.vwapDistAtr === f2.vwapDistAtr && f1.spyVsVwap === f2.spyVsVwap, `${f1.vwapDistAtr} ${f2.vwapDistAtr}`);
  // ---------- C1: a checkpoint price uses bars completed BY that checkpoint ----------
  const late = path2((i) => (at(i) === 5 ? 130 : 100), { hiLo: (i) => (at(i) === 5 ? 30 : 0.02) }); // the bar STARTING at 10:05 spikes
  const mc = measure(dec({ levels: null }), late, DAYS.slice(1), { daily: [] });
  const h5 = mc.horizons.find((h) => h.key === '5m');
  check_('C1: the 5-minute checkpoint (10:05:00) uses the 10:04 bar, not the 10:05 bar that ends after it', h5.price === 100 && h5.label === 'FLAT', `${h5.price} ${h5.label}`);
  // ---------- S0-2: the strategy's RECORDED inputs come first ----------
  const recorded = path2(() => 101).filter((r) => r[0] < t0); // the app's own (IEX) bars, different from the fetched SIP ones
  m = measure(dec({ p0: null }), path2(() => 100), DAYS.slice(1), { daily: [], recorded: { minute: recorded, daily: null } });
  check_('S0-2: P0 from the recorded strategy bars when no live price was recorded', m.p0 === 101 && m.p0Source === 'RECORDED_INPUTS' && m.inputsSource === 'RECORDED', `${m.p0} ${m.p0Source}`);
  m = measure(dec({ p0: 100.5 }), path2(() => 100), DAYS.slice(1), { daily: [], recorded: { minute: recorded, daily: null } });
  check_('S0-2: a recorded live price still wins', m.p0 === 100.5 && m.p0Source === 'RECORDED');

  // ---------- S0-1 (review): legacy series keys are labelled by prefix; new b2: keys are not ----------
  const tk = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94k-'));
  const ctx = (key) => ({ capturedAt: t0, values: {}, series: [{ name: 'session1m', symbol: 'AAPL', tf: '1m', key }] });
  jsonl(tk, '2026-09-14', [{ type: 'series', key: 'b:AAPL|1m|session1m|3|1|3|100|1', kind: 'bars', rows: [] }, { type: 'series', key: 'b2:AAPL|1m|session1m|abc', kind: 'bars', rows: [] },
    { type: 'decision', v: 1, id: 'k1', at: t0, path: 'STAGED', setup: { asset: 'AAPL' }, context: ctx('b:AAPL|1m|session1m|3|1|3|100|1') },
    { type: 'decision', v: 1, id: 'k2', at: t0, path: 'STAGED', setup: { asset: 'AAPL' }, context: ctx('b2:AAPL|1m|session1m|abc') },
    { type: 'decision', v: 1, id: 'k3', at: t0, path: 'STAGED', setup: { asset: 'AAPL' }, context: ctx('r:AAPL|1m|session1m|zz') }]);
  const ks = load(tk).decisions; const k1 = ks.find((x) => x.id === 'k1'); const k2 = ks.find((x) => x.id === 'k2'); const k3 = ks.find((x) => x.id === 'k3');
  check_('S0-1: a legacy b: key is labelled endpoint-only', k1.context.legacyKeys && k1.context.series[0].legacyKey && k1.missing.some((x) => /endpoint-only key \(b:/.test(x)));
  check_('S0-1: a legacy r: key is labelled as a 32-bit content hash (not endpoint-only)', k3.context.legacyKeys && k3.missing.some((x) => /32-bit content hash/.test(x)) && !k3.missing.some((x) => /endpoint-only/.test(x)));
  check_('S0-1: a b2: key is not labelled', !k2.context.legacyKeys && !k2.missing.some((x) => /before Phase 94/.test(x)));

  // ---------- S0-3: a rejection is checked against ITS OWN event's guard ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94r-'));
  const setup = { asset: 'AAPL', market: 'stocks', strategyId: 'equity-day', direction: 'long', entryPrice: 100, invalidation: 99, targets: [{ price: 102 }] };
  jsonl(tmp, '2026-09-14', [{ type: 'decision', v: 1, id: 'g1', setup, at: t0, path: 'STAGED', guard: { at: t0, macroActive: false } },
    { type: 'decision', v: 1, id: 'g1', setup, at: t0 + 600000, path: 'APPROVAL_REJECT', reason: 'MACRO_SHIELD_ACTIVE: CPI at 08:30', guard: { at: t0 + 600000, macroActive: true, macroEvent: 'CPI' } }]);
  const g1 = load(tmp).decisions.find((x) => x.id === 'g1');
  const v = check(g1);
  check_('S0-3: the rule check uses the REJECTING event\'s own guard (macro active at the approval), not the first event\'s', v && v.verdict === 'CONSISTENT', JSON.stringify(v));
  check_('S0-3: recorded events keep their guard', g1.events.every((e) => e.guard && Number.isFinite(e.guard.at)));
  check_('S0-3: recorded times: decision = the STAGED record, approval / entry / close separate', g1.t0 === t0 && g1.times.decision === t0 && g1.t0Source === 'RECORDED (first decision record)');
  // ---------- C1: a later lifecycle event is never the decision ----------
  const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94c1-'));
  jsonl(tc, '2026-09-15', [{ type: 'decision', v: 1, id: 'c1', setup: { ...setup, stagedAt: t0 - 3600000 }, at: t0 + 86400000, path: 'CLOSED', reason: 'STOP_LOSS' },
    { type: 'decision', v: 1, id: 'c2', setup, at: t0 + 86400000, path: 'CLOSED', reason: 'STOP_LOSS' },
    { type: 'decision', v: 1, id: 'c3', setup, at: t0 + 3000, path: 'APPROVED' }]);
  const cs = load(tc).decisions; const c1 = cs.find((x) => x.id === 'c1'); const c2 = cs.find((x) => x.id === 'c2'); const c3 = cs.find((x) => x.id === 'c3');
  check_('C1: only a CLOSED event recorded -> the decision time is recovered from the setup\'s own stagedAt, never the close', c1.t0 === t0 - 3600000 && /stagedAt/.test(c1.t0Source) && c1.times.close === t0 + 86400000, `${c1.t0} ${c1.t0Source}`);
  check_('C1: only a CLOSED event and no stagedAt -> decision time MISSING (not the close time)', c2.t0 === null && /^MISSING/.test(c2.t0Source), `${c2.t0} ${c2.t0Source}`);
  check_('C1: only an APPROVED event -> MISSING too (an approval is not the decision)', c3.t0 === null && /^MISSING/.test(c3.t0Source) && c3.times.approved === t0 + 3000);
  const lg = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94l-'));
  const jr = (id, extra) => ({ id, asset: 'AAPL', market: 'stocks', strategyId: 'equity-swing', direction: 'long', entryPrice: 100, invalidation: 95, targets: [{ price: 110 }],
    approvedAt: t0 + 60000, openedAt: t0 + 120000, closedAt: t0 + 86400000, netPnl: 1, dollarRisk: 10, ...extra });
  fs.writeFileSync(path.join(lg, 'ledger-snapshot.json'), JSON.stringify({ tradeJournal: [jr('L1', { stagedAt: t0 }), jr('L2', {})], activePositions: [], discardedOrders: [] }));
  const ls = load(lg).decisions; const L1 = ls.find((x) => x.id === 'L1'); const L2 = ls.find((x) => x.id === 'L2');
  check_('S0-3: decision / approval / entry / close times are four separate fields', L1.times.decision === t0 && L1.times.approved === t0 + 60000 && L1.times.entry === t0 + 120000 && L1.times.close === t0 + 86400000);
  check_('S0-3: t0 is the decision time, labelled', L1.t0 === t0 && L1.t0Source === 'LEDGER stagedAt');
  check_('C1: a LEDGER record without stagedAt -> decision time MISSING (no approval / entry substitute)', L2.t0 === null && /^MISSING/.test(L2.t0Source) && L2.times.approved === t0 + 60000, `${L2.t0} ${L2.t0Source}`);

  // ---------- S0-4: original and opposite on the SAME entry opportunity ----------
  const insession = (rows) => rows.filter((r) => T.inSession(r[0]));
  // a) a pullback long that never fills (price only rises) vs the mirrored rally short: the original stays UNFILLED; the opposite enters at its mirrored edge.
  const up = insession(path2((i) => 100 + Math.max(0, at(i)) * 0.05));
  const dA = dec({ levels: { entry: 99, entryZone: { min: 98.9, max: 99 }, stop: 98, t1: 101, t1Share: 0.5, t2: 102 } });
  const mA = measure(dA, up, DAYS.slice(1), { daily: [] });
  const oA = sim.realistic(dA, up, mA); const pA = sim.oppositeOf(dA, up, mA);
  check_('S0-4: an unfilled original stays UNFILLED (counted, not dropped)', oA && oA.filled === false, oA && oA.why);
  check_('S0-4: the opposite enters by the MIRRORED rule (sell the mirrored zone at 101), not at market', pA.rule === 'MIRRORED' && pA.filled && Math.abs(pA.rawFill - 101) < 1e-9, `${pA.rawFill}`);
  check_('S0-4: the opposite\'s stop is the mirrored stop (102)', pA.exits && pA.exits[0].reason === 'STOP' && Math.abs(pA.exits[0].raw - 102) < 1e-9, JSON.stringify(pA.exits && pA.exits[0]));
  // b) the same T1 / T2 allocation on both sides: the original's T1 102 / T2 103 mirror to 98 / 97 around P0 100; a falling path takes
  //    the opposite's T1 (98) for half, then T2 (97) for the rest.
  const down = insession(path2((i) => (at(i) <= 3 ? 100.05 : 100.05 - (at(i) - 3) * 0.05)));
  const dB = dec();
  const mB = measure(dB, down, DAYS.slice(1), { daily: [] });
  const pB = sim.oppositeOf(dB, down, mB);
  check_('S0-4: mirrored allocation: T1 for 50% then T2 for 50% (the original\'s split)', pB.filled && pB.exits.map((e) => e.reason).join() === 'T1,T2' && pB.exits[0].share === 0.5,
    JSON.stringify(pB.exits && pB.exits.map((e) => [e.reason, e.share])));
  check_('S0-4: the opposite option contract stays unavailable', sim.oppositeOf({ ...dB, market: 'options' }, down, mB).contract === 'unavailable (the opposite contract was never quoted)');
  check_('S0-4: spot crypto has no opposite trade', sim.oppositeOf({ ...dB, market: 'crypto' }, down, mB).unavailable === 'spot crypto cannot be shorted');

  // ---------- S0-5: harness vs account; crypto coverage stays UNCLEAR; the target-order flag ----------
  const O = require(R + 'origin');
  const hz = load(tmp, { origin: 'HARNESS' }).decisions;
  check_('S0-5: decisions from a --harness folder are labelled HARNESS', hz.length && hz.every((x) => x.origin === 'HARNESS'));
  check_('S0-5: account folders default to ACCOUNT', load(tmp).decisions.every((x) => x.origin === 'ACCOUNT'));
  const parts = O.partition([{ d: { origin: 'ACCOUNT' } }, { d: { origin: 'HARNESS' } }, { d: { origin: 'ACCOUNT' } }]);
  check_('S0-5: partition keeps harness examples out of the account set', parts.account.length === 2 && parts.harness.length === 1);
  const cx = dec({ market: 'crypto', strategyId: 'crypto-intraday' });
  const sparse = path2((i) => 100 + 0.1 * Math.sin(i / 10)).filter((r, k) => k % 5 !== 0); // 80% of minutes
  const cm = measure(cx, sparse, DAYS.slice(1), { daily: [] });
  check_('S0-5: crypto coverage rule unchanged: 80% coverage -> UNCLEAR (no amendment applied)', classify(cx, cm).cls === 'UNCLEAR', classify(cx, cm).cls);
  check_('S0-5: target-order flag: a long with T2 below T1 (PFE 28.95 / 28.05)', /TARGET_ORDER/.test(O.targetOrderFlag(dec({ levels: { entry: 27.5, stop: 27.05, t1: 28.95, t2: 28.05, t1Share: 0.5 } })) || ''));
  check_('S0-5: no flag when T2 is beyond T1', O.targetOrderFlag(dec()) === null);

  // ---------- the change report ----------
  const C = require(R + 'compare');
  const oldJ = { setups: [{ id: 'a', class: { cls: 'WRONG_DIRECTION' }, horizons: [{ key: 'H', label: 'WRONG' }], money: { rNet: -1 }, opposite: { label: 'CORRECT' }, rule: null },
    { id: 'h', class: { cls: 'UNCLEAR' }, horizons: [], money: null, opposite: null, rule: null }] };
  const newJ = { setups: [{ id: 'a', origin: 'ACCOUNT', class: { cls: 'UNCLEAR' }, horizons: [{ key: 'H', label: 'FLAT' }], money: { rNet: -1 }, opposite: { label: 'FLAT' }, rule: null,
    notes: { p0Source: 'FETCHED', t0Source: 'LEDGER stagedAt', oppRule: 'MIRRORED' } }, { id: 'h', origin: 'HARNESS', class: { cls: 'UNCLEAR' }, horizons: [], money: null, opposite: null, rule: null, notes: {} }] };
  const cmp = C.compare(oldJ, newJ);
  check_('compare: class counts before (all setups) and after (account only)', cmp.counts.before.WRONG_DIRECTION === 1 && cmp.counts.after.UNCLEAR === 1 && cmp.counts.afterHarness === 1);
  check_('compare: a changed setup lists its changed fields with the notes that may explain them', cmp.changes.length === 1 && cmp.changes[0].fields.class === 'WRONG_DIRECTION -> UNCLEAR' && cmp.changes[0].notes.p0Source === 'FETCHED');
  check_('compare: harness setups are reported as moved out of the account statistics', cmp.movedToHarness.join() === 'h');
  check_('compare: markdown has the counts table and the per-setup table', /\| Class \| Before \| After/.test(C.toMarkdown(cmp)) && /\| a \|/.test(C.toMarkdown(cmp)));

  console.log(`\nph94review: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
