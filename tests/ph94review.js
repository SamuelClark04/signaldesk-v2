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
  check_('S0-3: recorded times: decision = the STAGED record, approval / entry / close separate', g1.t0 === t0 && g1.times.decision === t0 && g1.t0Source === 'RECORDED (the STAGED record)');
  // ---------- C1: a later lifecycle event is never the decision ----------
  const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94c1-'));
  jsonl(tc, '2026-09-15', [{ type: 'decision', v: 1, id: 'c1', setup: { ...setup, stagedAt: t0 - 3600000 }, at: t0 + 86400000, path: 'CLOSED', reason: 'STOP_LOSS' },
    { type: 'decision', v: 1, id: 'c2', setup, at: t0 + 86400000, path: 'CLOSED', reason: 'STOP_LOSS' },
    { type: 'decision', v: 1, id: 'c3', setup, at: t0 + 3000, path: 'APPROVED' }]);
  const cs = load(tc).decisions; const c1 = cs.find((x) => x.id === 'c1'); const c2 = cs.find((x) => x.id === 'c2'); const c3 = cs.find((x) => x.id === 'c3');
  check_('C1: only a CLOSED event recorded -> the decision time is recovered from the setup\'s own stagedAt, never the close', c1.t0 === t0 - 3600000 && /stagedAt/.test(c1.t0Source) && c1.times.close === t0 + 86400000, `${c1.t0} ${c1.t0Source}`);
  check_('C1: only a CLOSED event and no stagedAt -> decision time MISSING (not the close time)', c2.t0 === null && /^MISSING/.test(c2.t0Source), `${c2.t0} ${c2.t0Source}`);
  check_('C1: only an APPROVED event -> MISSING too (an approval is not the decision)', c3.t0 === null && /^MISSING/.test(c3.t0Source) && c3.times.approved === t0 + 3000);
  // C1 (review): an EARLIER rejection of the same id (pre-market MARKET_CLOSED, a morning block) is not the decision when it was STAGED later.
  const tr = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94e-'));
  const t8 = T.at('2026-09-14', 8 * 60); const t1030 = T.at('2026-09-14', 10 * 60 + 30);
  jsonl(tr, '2026-09-14', [{ type: 'decision', v: 1, id: 'e1', setup, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'e1', setup, at: t1030, path: 'STAGED', price: { last: 29.5 } }, { type: 'decision', v: 1, id: 'e1', setup, at: t1030 + 60000, path: 'OPENED' },
    { type: 'decision', v: 1, id: 'e2', setup, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'e2', setup, at: t1030, path: 'PIPELINE_REJECT', reason: 'Cost ceiling exceeded', price: { last: 29.5 } }]);
  const es = load(tr).decisions; const e1 = es.find((x) => x.id === 'e1'); const e2 = es.find((x) => x.id === 'e2');
  check_('C1: staged later -> the STAGED event is the decision (not the 08:00 pre-market rejection)', e1.t0 === t1030 && e1.p0 === 29.5 && /STAGED/.test(e1.t0Source), `${e1.t0} ${e1.p0} ${e1.t0Source}`);
  check_('C1: never staged -> the decision is the rejection that ENDED it (the last one), not the first', e2.t0 === t1030 && e2.p0 === 29.5, `${e2.t0} ${e2.p0} ${e2.t0Source}`);
  // C1 (review nit): the STAGED line was lost (e.g. a queue drop) but the setup was later opened: a recovered stagedAt AFTER the earlier
  // rejection wins over that rejection (event setup.stagedAt, or the LEDGER's stagedAt).
  const tq = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94q-'));
  jsonl(tq, '2026-09-14', [{ type: 'decision', v: 1, id: 'q1', setup, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'q1', setup: { ...setup, stagedAt: t1030 }, at: t1030 + 60000, path: 'OPENED' },
    { type: 'decision', v: 1, id: 'q2', setup, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'q2', setup, at: t1030 + 60000, path: 'OPENED' }]);
  fs.writeFileSync(path.join(tq, 'ledger-snapshot.json'), JSON.stringify({ tradeJournal: [{ id: 'q2', asset: 'AAPL', market: 'stocks', strategyId: 'equity-day', direction: 'long', entryPrice: 100,
    invalidation: 99, targets: [{ price: 102 }], stagedAt: t1030, approvedAt: t1030 + 30000, openedAt: t1030 + 60000, closedAt: t1030 + 3600000, netPnl: 1, dollarRisk: 10 }], activePositions: [], discardedOrders: [] }));
  const qs = load(tq).decisions; const q1 = qs.find((x) => x.id === 'q1'); const q2 = qs.find((x) => x.id === 'q2');
  check_('C1 (nit): STAGED line lost, opened later -> the recovered setup stagedAt wins over the earlier rejection', q1.t0 === t1030 && /stagedAt/.test(q1.t0Source), `${q1.t0} ${q1.t0Source}`);
  check_('C1 (nit): ... or the LEDGER stagedAt when the events carry none', q2.t0 === t1030 && q2.p0 === null && /LEDGER stagedAt/.test(q2.t0Source), `${q2.t0} ${q2.t0Source}`);
  // ---------- C1-B: the selected decision's evidence (setup, levels, direction, option, chart / signal context) comes from THAT event ----------
  const tb = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94b-'));
  const sA = { ...setup, direction: 'long', setupType: 'ORB', entryPrice: 28, invalidation: 27, targets: [{ price: 30 }], optionsData: { contract: 'A-CALL', debit: 1.1 } };
  const sB = { ...setup, direction: 'short', setupType: 'BREAKDOWN', entryPrice: 29.5, invalidation: 30.5, targets: [{ price: 27 }], optionsData: { contract: 'B-PUT', debit: 0.9 } };
  const ctxA = { capturedAt: t8, values: { orbHigh: 28 }, series: [{ key: 'b2:AAPL|1m|bars|aaaa', symbol: 'AAPL', tf: '1m' }] };
  const ctxB = { capturedAt: t1030, values: { orbLow: 29.6 }, series: [{ key: 'b2:AAPL|1m|bars|bbbb', symbol: 'AAPL', tf: '1m' }] };
  const ser = (key, close) => ({ type: 'series', key, rows: [[t8, close, close, close, close, 1]] });
  jsonl(tb, '2026-09-14', [ser('b2:AAPL|1m|bars|aaaa', 28), ser('b2:AAPL|1m|bars|bbbb', 29.5),
    { type: 'decision', v: 1, id: 'b1', setup: sA, context: ctxA, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'b1', setup: sB, context: ctxB, at: t1030, path: 'STAGED', price: { last: 29.5 } },
    { type: 'decision', v: 1, id: 'b2', setup: sA, context: ctxA, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'b2', setup: sB, at: t1030, path: 'STAGED', price: { last: 29.5 } },
    { type: 'decision', v: 1, id: 'b3', setup: sA, context: ctxA, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'b3', setup: { ...sB, stagedAt: t1030 }, at: t1030 + 60000, path: 'OPENED' },
    { type: 'decision', v: 1, id: 'b4', setup: sA, context: ctxA, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'b4', setup: sB, at: t1030 + 60000, path: 'OPENED' },
    { type: 'decision', v: 1, id: 'b5', setup: sA, context: ctxA, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'b5', setup: sB, context: ctxB, at: t1030, path: 'PIPELINE_REJECT', reason: 'Cost ceiling exceeded', price: { last: 29.5 } }]);
  fs.writeFileSync(path.join(tb, 'ledger-snapshot.json'), JSON.stringify({ tradeJournal: [{ id: 'b4', asset: 'AAPL', market: 'stocks', strategyId: 'equity-day', direction: 'short',
    entryPrice: 29.5, invalidation: 30.5, targets: [{ price: 27 }], optionsData: { contract: 'B-PUT', debit: 0.9 }, stagedAt: t1030, approvedAt: t1030 + 30000, openedAt: t1030 + 60000,
    closedAt: t1030 + 3600000, netPnl: 1, dollarRisk: 10 }], activePositions: [], discardedOrders: [] }));
  const bs = load(tb).decisions; const B = (id) => bs.find((x) => x.id === id);
  const ev = (d) => `${d.direction} ${d.setupType} ${d.levels && d.levels.entry} ${d.option && d.option.contract} ${d.context && d.context.capturedAt} [${d.evidenceFrom && d.evidenceFrom.path}]`;
  const b1 = B('b1');
  check_('C1-B: STAGED chosen -> direction / setup type / levels / option all from the STAGED record, not the earlier rejection',
    b1.direction === 'short' && b1.d === -1 && b1.setupType === 'BREAKDOWN' && b1.levels.entry === 29.5 && b1.levels.stop === 30.5 && b1.levels.t1 === 27 && b1.option.contract === 'B-PUT', ev(b1));
  check_('C1-B: ... and the chart / signal context is the STAGED one (its own series)', b1.context && b1.context.capturedAt === t1030 && b1.context.values.orbLow === 29.6
    && b1.context.series.length === 1 && b1.context.series[0].key === 'b2:AAPL|1m|bars|bbbb' && b1.context.series[0].data.rows[0][4] === 29.5 && b1.evidenceFrom.path === 'STAGED', ev(b1));
  const b2 = B('b2');
  check_('C1-B: STAGED without its own context -> context MISSING (the earlier rejection\'s chart is never borrowed)', b2.context === null && b2.levels.entry === 29.5
    && b2.missing.some((x) => /decision inputs.*STAGED/.test(x)), `${ev(b2)} | ${b2.missing.join(' / ')}`);
  const b3 = B('b3');
  check_('C1-B: STAGED line lost, stagedAt recovered from the opened order -> that order\'s setup, context MISSING', b3.t0 === t1030 && b3.direction === 'short' && b3.levels.entry === 29.5
    && b3.option.contract === 'B-PUT' && b3.context === null && b3.missing.some((x) => /decision inputs/.test(x)), `${ev(b3)} | ${b3.missing.join(' / ')}`);
  const b4 = B('b4');
  check_('C1-B: LEDGER stagedAt recovered -> setup / levels / option from the ledger record, the rejection\'s context dropped', b4.t0 === t1030 && b4.direction === 'short'
    && b4.levels.entry === 29.5 && b4.option.contract === 'B-PUT' && b4.context === null && b4.evidenceFrom.path === 'LEDGER' && b4.missing.some((x) => /decision inputs/.test(x))
    && !b4.missing.some((x) => /^decision chart stored|32-bit/.test(x)), `${ev(b4)} | ${b4.missing.join(' / ')}`);
  const b5 = B('b5');
  check_('C1-B: never staged -> the ENDING rejection\'s own setup and context, not the first rejection\'s', b5.t0 === t1030 && b5.direction === 'short' && b5.levels.entry === 29.5
    && b5.context.capturedAt === t1030 && b5.evidenceFrom.path === 'PIPELINE_REJECT' && b5.evidenceFrom.at === t1030, ev(b5));
  // C1-B (review): a lost STAGED line followed by ANY later record of the staged order (here EXPIRED) recovers the decision from that
  // record's stagedAt; a selected record without a setup, or without a direction, leaves nothing from an earlier record behind.
  const tb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94b2-'));
  jsonl(tb2, '2026-09-14', [
    { type: 'decision', v: 1, id: 'b6', setup: { ...sA, thesis: 'morning thesis' }, context: ctxA, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED', price: { last: 28 } },
    { type: 'decision', v: 1, id: 'b6', setup: { ...sB, stagedAt: t1030 }, at: t1030 + 900000, path: 'EXPIRED' },
    { type: 'decision', v: 1, id: 'b7', setup: { ...sA, thesis: 'morning thesis', timeframe: '5m', evidence: { label: 'A-EVID' } }, context: ctxA, at: t8, path: 'PIPELINE_REJECT', reason: 'MARKET_CLOSED' },
    { type: 'decision', v: 1, id: 'b7', setup: null, at: t1030, path: 'STAGED' },
    { type: 'decision', v: 1, id: 'b8', setup: {}, at: t1030, path: 'STAGED' }]);
  const bs2 = load(tb2).decisions; const B2 = (id) => bs2.find((x) => x.id === id);
  const b6 = B2('b6');
  check_('C1-B (review): STAGED line lost, the order later EXPIRED -> decision = its stagedAt, evidence from the EXPIRED record, not the 08:00 rejection',
    b6.t0 === t1030 && /stagedAt/.test(b6.t0Source) && b6.direction === 'short' && b6.levels.entry === 29.5 && b6.evidenceFrom.path === 'EXPIRED' && b6.context === null, `${b6.t0} ${b6.t0Source} ${ev(b6)}`);
  const b7 = B2('b7');
  check_('C1-B (review): the selected STAGED record has no setup -> setup type / thesis / timeframe / evidence cleared and labelled MISSING, not the rejection\'s',
    b7.t0 === t1030 && b7.setupType == null && b7.thesis == null && b7.timeframe == null && b7.evidence == null && b7.direction === null && b7.levels === null
    && b7.missing.some((x) => /setup .* not recorded with the selected STAGED/.test(x)), `${ev(b7)} ${b7.thesis} | ${b7.missing.join(' / ')}`);
  const b8 = B2('b8');
  check_('C1-B (review): a setup without a direction -> direction MISSING (never defaulted to long)', b8.direction === null && b8.d === null
    && b8.missing.some((x) => /direction/.test(x)), `${b8.direction} ${b8.d} | ${b8.missing.join(' / ')}`);
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
