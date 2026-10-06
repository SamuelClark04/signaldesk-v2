// Decision Review (Phase 93): node tools/decision-review/run.js <archive folder> [<more folders>] [--out reports]
// Read-only towards the archives. Market data is FETCHED (Alpaca data keys from this PC's .env, in headers only, never printed;
// Coinbase public candles) and cached in reports/.cache. Writes reports/decision-review-<date>.html (+ .json): local, private.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true });
const T = require('./time');
const bars = require('./bars');
const { load } = require('./load');
const { measure, plannedEnd, tfMinutes } = require('./measure');
const { classify, opposite } = require('./classify');
const sim = require('./simulate');
const { check } = require('./safeguards');
const { attribute } = require('./attribute');
const pat = require('./patterns');
const { render } = require('./render');

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(ROOT, 'reports');
const harnessDirs = args.flatMap((a, i) => (args[i - 1] === '--harness' ? [a] : [])); // Phase 94 S0-5: test-harness examples, never account data
const dirs = args.filter((a, i) => !a.startsWith('--') && !['--out', '--harness'].includes(args[i - 1]));
if (!dirs.length) { console.log('usage: node tools/decision-review/run.js <extracted archive folder> [...] [--harness <folder>] [--out reports]'); process.exit(2); }
const today = T.ymd(Date.now());
const daysAround = (t0, before, after) => { const d0 = T.ymd(t0); const back = []; let t = T.at(d0, 12 * 60); while (back.length < before) { t -= T.DAY; const wd = new Date(t).getUTCDay(); if (wd > 0 && wd < 6) back.unshift(T.ymd(t)); } return [...back, d0, ...T.nextWeekdays(d0, after)].filter((d) => d <= today); };
const isIntraday = (d) => d.market === 'crypto' || ['equity-day', 'options-quickflips'].includes(d.strategyId) || tfMinutes(d.timeframe) < 390;

// RECORDED series rows -> [tMs, o, h, l, c, v] (t: ISO, epoch seconds / ms, or a New York minute-of-day on the decision day).
function recordedRows(d, names) {
  const s = d.context && d.context.series ? d.context.series.find((x) => names.includes(x.name) && x.data && x.data.kind === 'bars') : null;
  if (!s) return null;
  const day = T.ymd(d.t0);
  const rows = s.data.rows.filter(Boolean).map((r) => { const t = r[0]; const ms = typeof t === 'string' ? Date.parse(t) : t > 1e12 ? t : t > 1e8 ? t * 1000 : T.at(day, t); return [ms, r[1], r[2], r[3], r[4], r[5]]; })
    .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[4]));
  return rows.length ? { rows, name: s.name, truncated: s.truncated } : null;
}

// Phase 94 S0-2: the strategy's own recorded inputs, used before fetched bars for every pre-decision value.
function recordedInputs(d) {
  const minute = recordedRows(d, ['session1m', 'todaySlots1m']); const daily = recordedRows(d, ['daily', 'dailyLong']);
  return { minute: minute ? minute.rows : null, daily: daily ? daily.rows : null };
}

async function one(d, macro) {
  const r = { d, anchor: `s-${String(d.id).replace(/[^A-Za-z0-9]+/g, '-')}`.slice(0, 120), chart: {} };
  if (!Number.isFinite(d.t0) || !d.symbol) { r.m = { error: !d.symbol ? 'symbol unknown' : `decision time ${d.t0Source || 'MISSING'}` }; r.cls = classify(d, r.m); r.guard = check(d); r.feat = pat.features(d, null, {}); return r; }
  const crypto = d.market === 'crypto';
  const sym = crypto ? d.symbol : (d.option && d.option.underlying) || d.symbol;
  const days = crypto ? daysAround(d.t0, 1, 2) : daysAround(d.t0, 6, d.strategyId === 'options-system' ? 24 : d.strategyId === 'equity-day' || d.strategyId === 'options-quickflips' ? 3 : 16);
  let minute = []; let daily = []; let spyMinute = []; let spyDaily = [];
  try {
    minute = await bars.minutes(crypto ? 'crypto' : 'stocks', sym, days, 'sip');
    if (!crypto) {
      daily = await bars.stockDaily(sym, T.ymd(d.t0 - 120 * T.DAY), days[days.length - 1]);
      spyMinute = await bars.stockDay('SPY', T.ymd(d.t0), 'sip').catch(() => []);
      spyDaily = await bars.stockDaily('SPY', T.ymd(d.t0 - 30 * T.DAY), T.ymd(d.t0)).catch(() => []);
    }
  } catch (err) { r.fetchError = err.message; }
  const sessionDays = crypto ? days : [...new Set(minute.filter((x) => T.inSession(x[0])).map((x) => T.ymd(x[0])))].sort().filter((x) => x >= T.ymd(d.t0) || T.sessionClose(x) > d.t0);
  const rin = recordedInputs(d);
  r.m = measure(d, minute, sessionDays, { daily, recorded: rin });
  r.cls = classify(d, r.m);
  r.endLabel = r.m && r.m.horizons ? (r.m.horizons.find((h) => h.key === 'H') || {}).label : null;
  r.oppDir = opposite(d, r.m);
  if (!r.m.error && d.levels) {
    r.money = sim.realistic(d, minute.filter((x) => crypto || T.inSession(x[0])), r.m);
    r.opp = sim.oppositeOf(d, minute.filter((x) => crypto || T.inSession(x[0])), r.m);
  }
  if (d.market === 'options' && d.option && !d.realized && d.option.contract && d.option.ask > 0 && r.m && !r.m.error) {
    try {
      const legs = [{ contract: d.option.contract, side: 'buy' }, ...(d.option.shortContract ? [{ contract: d.option.shortContract, side: 'sell' }] : [])];
      for (const l of legs) { l.rows = []; for (const day of sessionDays.slice(0, 16)) l.rows.push(...await bars.optionDay(l.contract, day).catch(() => [])); }
      const rule = d.option.exitRule || {};
      r.opt = sim.optionPrints(legs, { debit: d.option.debit || d.option.ask, halfSpread: d.option.bid > 0 ? (d.option.ask - d.option.bid) / 2 : 0, stopValue: rule.stopValue, targetValue: rule.targetValue,
        endAt: r.m.H.endAt || Date.now(), confirmations: d.strategyId === 'options-quickflips' ? 2 : 1 }, d.t0);
    } catch (err) { r.opt = { tier: 'UNAVAILABLE', why: err.message }; }
  } else if (d.market === 'options' && !d.realized) r.opt = { tier: 'UNAVAILABLE', why: d.option ? 'no recorded contract quote' : 'no recorded contract' };
  const contract = d.realized && d.realized.status === 'closed' ? { rNet: d.realized.rNet, rGross: null, filled: true } : d.market === 'options' ? (r.opt && r.opt.tier !== 'UNAVAILABLE' ? r.opt : null) : r.money;
  r.overlay = r.cls.cls === 'CORRECT_DIRECTION' && contract && contract.rNet < 0;
  r.attr = attribute(d, r.m, r.cls.cls, contract);
  r.guard = check(d);
  r.flags = [require('./origin').targetOrderFlag(d)].filter(Boolean);
  r.feat = pat.features(d, r.m, { minute: rin.minute || minute, daily: rin.daily || daily, spyMinute, spyDaily, macro });
  // The chart: BEFORE the decision as the app saw it (RECORDED when captured), AFTER it to the planned end (FETCHED).
  const intraday = isIntraday(d);
  const rec = recordedRows(d, intraday ? ['session1m', 'todaySlots1m'] : ['daily', 'dailyLong']);
  if (rec) { r.chart.pre = rec.rows.filter((x) => !intraday || x[0] + T.MIN <= d.t0).slice(intraday ? -240 : -90); r.chart.preSource = `RECORDED ${rec.name}${rec.truncated ? ' (truncated)' : ''}`; }
  else if (intraday) { r.chart.pre = minute.filter((x) => x[0] + T.MIN <= d.t0 && x[0] > d.t0 - 4 * 3600 * 1000 && (crypto || T.inSession(x[0]))); r.chart.preSource = `FETCHED ${crypto ? 'Coinbase' : 'SIP'} 1m (not the app's own feed)`; }
  else { r.chart.pre = daily.filter((x) => x[0] < T.at(T.ymd(d.t0), 0)).slice(-60); r.chart.preSource = 'FETCHED SIP daily'; }
  const end = r.m && r.m.H ? r.m.H.endAt || Date.now() : d.t0 + 2 * T.DAY;
  r.chart.post = intraday ? minute.filter((x) => x[0] >= d.t0 && x[0] <= end && (crypto || T.inSession(x[0]))) : daily.filter((x) => x[0] >= T.at(T.ymd(d.t0), 0) && x[0] <= end);
  r.chart.postSource = `FETCHED ${crypto ? 'Coinbase 1m' : intraday ? 'SIP 1m' : 'SIP daily'}`;
  if (d.context && d.context.values) r.signals = JSON.stringify(d.context.values).slice(0, 600);
  return r;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  bars.setCache(path.join(outDir, '.cache'));
  const all = new Map(); const metas = [];
  for (const [list, origin] of [[dirs, 'ACCOUNT'], [harnessDirs, 'HARNESS']]) for (const dir of list) { // keyed by origin: the two sets never merge
    const L = load(dir, { origin }); metas.push({ ...L, origin });
    for (const d of L.decisions) { const k = `${origin}|${d.id}`; if (!all.has(k) || all.get(k).source !== 'RECORDED') all.set(k, d); }
  }
  let macro = [];
  try { macro = require(path.join(ROOT, 'server/services/macro-calendar')).events().map((e) => e.releaseTime).filter(Number.isFinite); } catch { macro = []; }
  const list = [...all.values()];
  console.log(`decision review: ${list.length} setups from ${dirs.length} folder(s); fetching market data (cached in ${path.join(outDir, '.cache')})`);
  const R = [];
  for (const [i, d] of list.entries()) {
    R.push(await one(d, macro));
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1} / ${list.length}`);
  }
  const { account, harness } = require('./origin').partition(R); // S0-5: statistics from ACCOUNT data only
  const P = pat.analyze(account.map((r) => {
    const done = !['UNCLEAR', 'PENDING', 'NOT_MEASURABLE'].includes(r.cls.cls);
    const decisive = r.cls.cls === 'INCOMPLETE' ? (['CORRECT', 'WRONG'].includes(r.endLabel) ? r.endLabel === 'WRONG' : null) : done ? ['WRONG_DIRECTION', 'LATE_ENTRY'].includes(r.cls.cls) : null;
    const missed = r.d.outcome.group !== 'REJECTED' ? null : r.cls.cls === 'INCOMPLETE' ? (['CORRECT', 'WRONG'].includes(r.endLabel) ? r.endLabel === 'CORRECT' : null)
      : done ? ['CORRECT_DIRECTION', 'EARLY_ENTRY'].includes(r.cls.cls) : null;
    return { id: r.d.id, feat: r.feat || {}, wrong: decisive, missed };
  }));
  const acctMetas = metas.filter((x) => x.origin === 'ACCOUNT'); const harnessMetas = metas.filter((x) => x.origin === 'HARNESS'); // S0-5 (review)
  const st = acctMetas.map((x) => x.recorder.lastStatus).filter(Boolean).sort((a, b) => b.at - a.at)[0];
  const meta = { counts: { account: account.length, harness: harness.length }, generated: new Date().toISOString(), archive: dirs.map((x) => path.basename(x)).join(' + '), bars: bars.stats,
    recorder: { files: acctMetas.reduce((s, x) => s + x.recorder.files, 0), missingRecords: acctMetas.flatMap((x) => x.recorder.missingRecords) },
    harnessRecorder: { files: harnessMetas.reduce((s, x) => s + x.recorder.files, 0) },
    recorderStatus: st ? `${new Date(st.at).toISOString()}: ${st.recordedToday} recorded, ${st.dropped} dropped, ${st.writeErrors + st.serializeErrors} write errors, ${st.missingContext} without inputs` : null };
  const stamp = T.ymd(Date.now());
  const html = path.join(outDir, `decision-review-${stamp}.html`);
  fs.writeFileSync(html, render(account, P, meta, { harness }));
  fs.writeFileSync(path.join(outDir, `decision-review-${stamp}.json`), JSON.stringify({ meta, patterns: { ...P, tests: P.tests.map(({ ids, ...t }) => t) },
    setups: [...account, ...harness].map((r) => ({ id: r.d.id, origin: r.d.origin, flags: r.flags || [], notes: { p0Source: r.m && r.m.p0Source, inputsSource: r.m && r.m.inputsSource,
        t0Source: r.d.t0Source, oppRule: r.opp && r.opp.rule, legacyEvidenceKeys: !!(r.d.context && r.d.context.legacyKeys) }, source: r.d.source, strategy: r.d.strategyId, symbol: r.d.symbol, direction: r.d.direction, t0: r.d.t0, outcome: r.d.outcome, class: r.cls, overlay: !!r.overlay,
      horizons: r.m && r.m.horizons ? r.m.horizons.map((h) => ({ key: h.key, label: h.label, m: h.m })) : null, money: r.money ? { tier: r.money.tier, rNet: r.money.rNet, filled: r.money.filled } : null, oppTrade: r.opp ? { rule: r.opp.rule, rNet: r.opp.rNet, filled: r.opp.filled } : null,
      realized: r.d.realized ? { rNet: r.d.realized.rNet, netPnl: r.d.realized.netPnl } : null, opposite: r.oppDir, rule: r.guard, causes: r.attr, missing: r.d.missing })) }, null, 1));
  const c = (k) => account.filter((r) => r.cls.cls === k).length;
  console.log(`done: ${html}\n  account setups ${account.length} (harness examples ${harness.length}, listed separately)\n  classes: correct ${c('CORRECT_DIRECTION')}, wrong ${c('WRONG_DIRECTION')}, early ${c('EARLY_ENTRY')}, late ${c('LATE_ENTRY')}, reversal ${c('REVERSAL_AFTER_ENTRY')}, unclear ${c('UNCLEAR')}, incomplete ${c('INCOMPLETE')}, pending ${c('PENDING')}, not measurable ${c('NOT_MEASURABLE')}`);
  console.log(`  market data: ${bars.stats.requests} requests, ${bars.stats.cacheHits} cached, ${bars.stats.errors} errors`);
})().catch((e) => { console.error('decision review failed:', e.message); process.exit(1); });
