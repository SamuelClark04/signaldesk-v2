// Phase 95 desktop shadow system: the option grid recorder (fake Alpaca), the post-session scheduler, and the whole research job on a
// fixture session: ingest -> opportunities (TRIGGER / CONTROL / NEWS / APP, accepted AND rejected) -> fills / exits -> books -> report.
// Scratch folders only; no network; no broker module reachable. Run: node tests/ph95shadow.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph95s-'));
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const ROOT = path.join(__dirname, '..'); const T = (p) => require(path.join(ROOT, p));
const et = T('server/services/et-time');
const at = (day, h, m, s = 0) => et.toEpoch(day, h, m) + s * 1000;
const D = '2026-10-08'; const D2 = '2026-10-09';

(async () => {
  // ---------- option grid (collector) ----------
  const oc = T('server/research/collector/option-chain');
  check('monthlies: D = 2026-11-20 (>= 14 DTE), W = 2026-12-18 (>= 42 DTE) on 2026-10-08', JSON.stringify(oc.monthlyBuckets(D)) === JSON.stringify({ D: '2026-11-20', W: '2026-12-18' }), JSON.stringify(oc.monthlyBuckets(D)));
  const occ = (exp, side, k) => `AAPL${exp.slice(2).replace(/-/g, '')}${side}${String(k * 1000).padStart(8, '0')}`;
  const snap = (k, side, bid) => ({ latestQuote: { bp: bid, ap: bid + 0.1, bs: 5, as: 5, t: new Date(at(D, 9, 59, 50)).toISOString() }, greeks: { delta: side === 'C' ? 0.5 - (k - 250) * 0.05 : -0.5 - (k - 250) * 0.05 }, impliedVolatility: 0.3 });
  const reqs = [];
  const fakeFetch = async (url) => {
    reqs.push(url); const u = new URL(url); const p = u.searchParams; let body = {};
    if (u.pathname.endsWith('/trades/latest')) body = { trades: { AAPL: { p: 250.4, t: new Date(at(D, 9, 59)).toISOString() } } };
    else if (u.pathname.endsWith('/options/snapshots/AAPL')) {
      const exps = p.get('expiration_date') ? [p.get('expiration_date')] : ['2026-10-09', '2026-10-12']; const snaps = {};
      for (const e of exps) for (let k = 245; k <= 255; k += 1) for (const s of ['C', 'P']) snaps[occ(e, s, k)] = snap(k, s, 2);
      body = { snapshots: snaps };
    } else if (u.pathname.endsWith('/options/snapshots')) { const snaps = {}; for (const s of p.get('symbols').split(',')) snaps[s] = snap(250, 'C', 2.2); body = { snapshots: snaps }; }
    return { ok: true, status: 200, json: async () => body };
  };
  const lines = []; let clock = at(D, 10, 0);
  const G = T('server/research/collector/options-grid');
  const mk = () => G.create({ fetchImpl: fakeFetch, keys: () => ({ key: 'k', secret: 's' }), symbols: () => ['AAPL'], record: (kind, data) => { lines.push({ kind, at: clock, ...data }); return true; }, now: () => clock, dir: DIR });
  let g = mk(); await g.tick();
  const cl = lines.find((l) => l.kind === 'OPTION_CANDIDATES');
  const want = ['Q|call|' + occ('2026-10-09', 'C', 250), 'Q|put|' + occ('2026-10-09', 'P', 250), 'D|call|' + occ('2026-11-20', 'C', 250), 'D|put|' + occ('2026-11-20', 'P', 250), 'W|call|' + occ('2026-12-18', 'C', 250), 'W|put|' + occ('2026-12-18', 'P', 250)];
  check('grid: one CANDIDATES line, per bucket and side the contract closest to 0.50 delta; Q = the nearest 1-7 DTE expiry (never 0DTE)',
    cl && JSON.stringify(cl.rows.map((r) => `${r.bucket}|${r.side}|${r.contract}`)) === JSON.stringify(want) && cl.spot === 250.4, cl && JSON.stringify(cl.rows.map((r) => r.contract)));
  check('grid: chain quotes recorded with the PROVIDER quote time and our receipt time, labelled INDICATIVE_ESTIMATE', lines.some((l) => l.kind === 'OPTION_QUOTES' && l.label === 'INDICATIVE_ESTIMATE' && l.rows[0][1] === at(D, 9, 59, 50) && l.tRecv === clock));
  check('grid: the Q grid = 3 strikes each side of the spot x calls and puts (12), sampled every minute; 6 pins', g.stats().gridContracts === 12 && g.stats().pinned === 6, JSON.stringify(g.stats()));
  const q1 = reqs.filter((u) => u.includes('/options/snapshots?')).length;
  clock += 61000; await g.tick();
  check('grid: the next minute samples the Q grid + Q pins in ONE request (<= 100 contracts each); no re-centre before 30 min', reqs.filter((u) => u.includes('/options/snapshots?')).length === q1 + 1 && g.stats().recentres === 1);
  check('grid: no request outside session hours', await (async () => { const n = reqs.length; clock = at(D, 17, 0); await g.tick(); return reqs.length === n; })());
  g = mk(); clock = at(D2, 8, 0); await g.tick();
  check('grid: pins survive a restart (research-pins.json); the next day Q pins end (Q / H never hold overnight), D / W pins stay', Object.values(g._pins()).length === 4 && Object.values(g._pins()).every((p) => p.bucket !== 'Q'));

  // ---------- scheduler ----------
  const N = T('server/research/collector/nightly');
  check('scheduler: due for the session just closed from 16:40 ET; before that the previous session; Monday morning = Friday', N.lastCompleted(at(D, 17, 0)) === D && N.lastCompleted(at(D, 12, 0)) === '2026-10-07' && N.lastCompleted(at('2026-10-12', 9, 0)) === D2);

  // ---------- the research job on a fixture session ----------
  const data = path.join(DIR, 'data'); const research = path.join(DIR, 'research'); fs.mkdirSync(data, { recursive: true });
  const QC = occ(D2, 'C', 250); const QP = occ(D2, 'P', 250); const DC = occ('2026-11-20', 'C', 250); const DP = occ('2026-11-20', 'P', 250);
  const out = [{ kind: 'OPTION_CANDIDATES', at: at(D, 9, 31), underlying: 'AAPL', spot: 250, rows: [['Q', 'call', QC, D2], ['Q', 'put', QP, D2], ['D', 'call', DC, '2026-11-20'], ['D', 'put', DP, '2026-11-20']]
    .map(([bucket, side, contract, expiry]) => ({ bucket, side, contract, expiry, strike: 250, delta: side === 'call' ? 0.5 : -0.5, dte: 1, rule: 'delta50' })) }];
  const rows = [];
  for (let m = 1; m <= 390; m += 1) {
    const t = at(D, 9, 30) + m * 60000 + 10000; const k = Math.max(0, m - 11);
    const cb = Math.min(3, 2 + 0.05 * k); const pb = Math.max(0.2, Math.round((2 - 0.03 * k) * 100) / 100);
    rows.push([QC, t, cb, Math.round((cb + 0.1) * 100) / 100, 5, 5, 0.3, 0.5], [QP, t, pb, Math.round((pb + 0.1) * 100) / 100, 5, 5, 0.3, -0.5]);
    if (m % 10 === 1) rows.push([DC, t, 5, 5.2, 5, 5, 0.3, 0.5], [DP, t, 5, 5.2, 5, 5, 0.3, -0.5]);
  }
  for (let m = 1; m <= 391; m += 10) { const t = at(D2, 9, 30) + m * 60000 + 10000; rows.push([DC, t, 5.5, 5.7, 5, 5, 0.3, 0.5], [DP, t, 4.5, 4.7, 5, 5, 0.3, -0.5]); }
  out.push({ kind: 'OPTION_QUOTES', at: at(D, 16, 0), tRecv: at(D, 16, 0), label: 'INDICATIVE_ESTIMATE', src: 'Q', rows });
  fs.writeFileSync(path.join(data, `research-${D}.jsonl`), out.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(data, `decisions-${D}.jsonl`), [{ type: 'decision', at: at(D, 10, 30), path: 'STAGED', id: 's1', setup: { asset: 'AAPL', direction: 'bullish', strategyId: 'equity-day' } },
    { type: 'decision', at: at(D, 11, 0), path: 'PIPELINE_REJECT', id: 's2', reason: 'COST', setup: { asset: 'AAPL', direction: 'bearish', strategyId: 'equity-swing' } },
    { type: 'decision', at: at(D, 11, 5), path: 'USER_REJECT', id: 's1', setup: { asset: 'AAPL', direction: 'bullish' } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(data, `events-${D}.jsonl`), JSON.stringify({ kind: 'NEWS', t_recv: at(D, 12, 0), symbols: ['AAPL'] }) + '\n');
  const W = T('tools/research/db'); const db = W.open(path.join(research, 'research.sqlite'));
  const bars = []; for (let i = 0; i < 390; i += 1) { const c = i >= 10 ? 252 : 250; bars.push({ symbol: 'AAPL', t: at(D, 9, 30) + i * 60000, o: c, h: i < 5 ? 251 : c + 0.5, l: i < 5 ? 249 : c - 0.5, c, v: 1000 }); }
  W.upsertBars(db, bars); db.prepare("insert into bars_1d (symbol, day, o, h, l, c, v) values ('AAPL', '2026-10-07', 248, 251, 247, 249.5, 1)").run();
  const ing = T('tools/research/shadow/ingest').ingest(db, { dir: data, quotesDir: research, through: D2 });
  check('ingest: selections + quotes into the ledger; a re-run reads nothing new (size unchanged)', ing.candidates === 4 && ing.quotes === rows.length
    && T('tools/research/shadow/ingest').ingest(db, { dir: data, quotesDir: research, through: D2 }).files === 0, JSON.stringify(ing));
  const R = T('tools/research/shadow/run');
  const res = R.run(db, { quotesDir: research, dataDir: data, symbols: ['AAPL', 'MSFT'], through: D2, now: at(D2, 17, 0) });
  const opp = (pred) => res.opportunities.filter(pred);
  check('opportunities: ORB5 UP at the END of the 9:40 bar; controls; the first news receipt (call AND put); APP staged AND rejected, one per decision id',
    opp((o) => o.trigger === 'ORB5' && o.dir === 'UP' && o.tAvail === at(D, 9, 41)).length === 1 && opp((o) => o.source === 'CONTROL' && o.symbol === 'AAPL').length === 6
    && opp((o) => o.source === 'NEWS').length === 2 && opp((o) => o.source === 'APP').length === 2 && opp((o) => o.key === 'APP|s1').length === 1, JSON.stringify(res.opportunities.map((o) => o.trigger + o.dir)));
  const oc1 = res.outcomes.find((o) => o.opp.trigger === 'ORB5' && o.rule === 'Q+20/30m');
  check('Q+20/30m on ORB5: filled at the ask of the first quote >= 5 s after 9:41 (2.10); target triggered at 9:48 (net $24.90), filled at the NEXT bid 2.40: net $29.90',
    oc1 && oc1.entry.price === 2.1 && oc1.entry.quote.t_quote === at(D, 9, 41, 10) && oc1.exit.reason === 'TARGET' && Math.abs(oc1.exit.net - 29.9) < 1e-9, oc1 && JSON.stringify({ e: oc1.entry.price, x: oc1.exit.reason, n: oc1.exit.net }));
  const put = res.outcomes.find((o) => o.opp.source === 'CONTROL' && o.opp.dir === 'DOWN' && o.opp.symbol === 'AAPL' && o.rule === 'Q+20/30m' && o.opp.tAvail === at(D, 10, 0));
  check('losses are kept: the 10:00 control put under Q+20/30m stops out (net <= -$40) with its loss beyond the stop', put && put.exit.reason === 'STOP' && put.exit.net <= -40 && put.exit.lossBeyondStop >= 0, put && JSON.stringify(put.exit.net));
  const d1 = res.outcomes.find((o) => o.opp.trigger === 'ORB5' && o.rule === 'D+1'); const d3 = res.outcomes.find((o) => o.opp.trigger === 'ORB5' && o.rule === 'D+3');
  check('D+1 exits at the session +1 close (15:50 trigger, next quote fill at 5.50 = $29.90 on a $520.00 debit); D+3 stays OPEN until later sessions arrive',
    d1 && d1.exit.reason === 'SESSION_CLOSE' && Math.abs(d1.exit.net - (550 - 520 - 0.1)) < 1e-9 && d3 && d3.exit.status === 'OPEN', d1 && JSON.stringify(d1.exit.reason + d1.exit.net));
  check('W rules: no W selection was recorded -> NO_SELECTION (never a later contract substituted)', res.outcomes.filter((o) => o.rule === 'W+10' && o.opp.symbol === 'AAPL').every((o) => o.status === 'NO_SELECTION'));
  check('MSFT has no recorded selection: every MSFT outcome is NO_SELECTION and appears as a SKIPPED book entry', res.outcomes.filter((o) => o.opp.symbol === 'MSFT').every((o) => o.status === 'NO_SELECTION')
    && db.prepare("select count(*) n from shadow_book_entries where key like 'MSFT|%' and status = 'SKIPPED' and reason = 'NO_SELECTION'").get().n > 0);
  const n1 = db.prepare('select count(*) n from shadow_outcomes').get().n;
  R.run(db, { quotesDir: research, dataDir: data, symbols: ['AAPL', 'MSFT'], through: D2, now: at(D2, 17, 0) });
  check('idempotent: a re-run gives the same stored outcomes', db.prepare('select count(*) n from shadow_outcomes').get().n === n1 && n1 === res.outcomes.length);
  const file = T('tools/research/shadow/report').write({ result: res, through: D2, outDir: path.join(DIR, 'reports'), collection: [{ day: D, candidates: 1, quotes: rows.length, underlyings: 1 }], opraStatus: 'OPRA blocked (test)' });
  const html = fs.readFileSync(file, 'utf8');
  check('report: written, labelled INDICATIVE_ESTIMATE with real-quote validation UNAVAILABLE, rules side by side, losses listed', /INDICATIVE_ESTIMATE/.test(html) && /UNAVAILABLE/.test(html) && /Q\+80\/60m/.test(html) && /STOP/.test(html) && /W\+20/.test(html));
  db.close();

  // ---------- books ----------
  const B = T('tools/research/shadow/books'); const rule = B.RULES[0];
  const t0 = at(D, 10, 0); const o = (sym, t, exitAt, net, price = 1) => ({ opp: { key: `${sym}|${t}`, symbol: sym, tAvail: t0 + t, day: D }, status: 'FILLED', entry: { price }, exit: { status: 'CLOSED', exitAt: t0 + exitAt, net } });
  const b = B.runBook([o('A', 1e3, 9e3, -50), o('A', 2e3, 3e3, 5), o('B', 2e3, 9e3, 5), o('C', 2e3, 9e3, 5), o('D', 2e3, 9e3, 5), o('E', 1e4, 2e4, 1, 200), { opp: { key: 'F|1', symbol: 'F', tAvail: t0 + 2e4, day: D }, status: 'UNFILLED' }], rule);
  const st = b.entries.map((e) => e.reason || e.status).join(',');
  check('books: one record per opportunity, ENTERED or SKIPPED with one reason (PER_SYMBOL, CONCURRENCY, CAPITAL, UNFILLED) and the state at that moment',
    st === 'ENTERED,PER_SYMBOL,ENTERED,ENTERED,CONCURRENCY,CAPITAL,UNFILLED' && b.entries[4].state.open === 3, st);
  const dl = B.runBook([o('A', 1e3, 2e3, -310), o('B', 3e3, 4e3, 5)], rule);
  check('books: the daily loss stop (-$300 realized) skips later entries that day (DAILY_LOSS)', dl.entries[1].reason === 'DAILY_LOSS' && dl.summary.losses === 1);

  // ---------- triggers T4-T7 + the classifier ----------
  const Xp = T('tools/research/shadow/exposure'); const Cx = T('tools/research/shadow/cross'); const Op = T('tools/research/shadow/opportunities');
  const cls = (h) => { const c = Xp.classify(h); return `${c.category}/${c.subtype}/${c.dir}`; };
  check('classifier (rules only): upgrade -> UP, guidance cut -> DOWN, misses estimates -> DOWN, an unclassified headline -> OTHER (never an event)',
    cls('Morgan Stanley upgrades NVDA to Overweight') === 'ANALYST/UPGRADE/UP' && cls('Apple cuts full-year guidance') === 'GUIDANCE/CUT/DOWN'
    && cls('Amazon misses Wall Street estimates') === 'EARNINGS/MISS/DOWN' && cls('Markets open on a sunny day') === 'OTHER/null/BOTH');
  check('company map: AMD news naming NVDA is SEGMENT_PEER; TSLA has no mapped peer there (NONE)', Xp.relation('AMD', ['NVDA']) === 'SEGMENT_PEER' && Xp.relation('TSLA', ['NVDA']) === 'NONE' && Xp.relation('NVDA', ['NVDA']) === 'SELF');
  const flat = []; for (let i = 0; i < 60; i += 1) flat.push({ t: at(D, 9, 30) + i * 60000, o: 100, h: 100.3, l: 99.9, c: i === 45 ? 101.5 : 100.1, v: 1 });
  const qb = Op.triggers('AAPL', D, flat, null, 2).filter((o) => o.trigger === 'QUIET_BREAK');
  check('T7 QUIET_BREAK: a 30-bar range < 0.75 x ATR30, confirmed at its 30th bar; the first close beyond it (the 10:15 bar) -> UP at that bar\'s end', qb.length === 1 && qb[0].dir === 'UP' && qb[0].tAvail === at(D, 10, 16), JSON.stringify(qb.map((o) => o.trigger + o.dir + o.tAvail)));
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const walk = (n, jumpAt, jump) => { const c = []; let p = 100; for (let m = 0; m < n; m += 1) { p *= 1 + rnd() * 0.0004 + (m === jumpAt ? jump : 0); c.push(p); } return c; };
  const ser = { NVDA: { today: walk(390, -1, 0), prior: [1, 2, 3, 4, 5, 6].map(() => walk(390, -1, 0)) }, SMH: { today: walk(390, -1, 0), prior: [1, 2, 3, 4, 5, 6].map(() => walk(390, -1, 0)) },
    AMD: { today: walk(390, 200, 0.03), prior: [1, 2, 3, 4, 5, 6].map(() => walk(390, -1, 0)) } };
  ser.NVDA.today = ser.NVDA.today.map((p, m) => (m >= 100 ? p * 1.03 : p));
  const ct = Cx.crossTriggers(['NVDA'], D, 390, (s) => ser[s] || null);
  check('T4 RS_DIVERGENCE: NVDA +3% vs SMH at minute 100 (beyond 2 sd of its prior sessions\' same-bucket values) -> UP at the end of that minute',
    ct.some((o) => o.trigger === 'RS_DIVERGENCE' && o.dir === 'UP' && o.tAvail === at(D, 9, 30) + 101 * 60000 && o.vs === 'SMH'), JSON.stringify(ct.map((o) => `${o.trigger}${o.dir}@${(o.tAvail - at(D, 9, 30)) / 60000}`)));
  check('T5 PEER_SHOCK: AMD (mapped peer) jumps 3% in 5 min at minute 200 while NVDA is within 1 sd -> NVDA UP', ct.some((o) => o.trigger === 'PEER_SHOCK' && o.dir === 'UP' && o.peer === 'AMD' && o.tAvail >= at(D, 9, 30) + 201 * 60000 && o.tAvail <= at(D, 9, 30) + 205 * 60000), JSON.stringify(ct.filter((o) => o.trigger === 'PEER_SHOCK').map((o) => (o.tAvail - at(D, 9, 30)) / 60000)));
  const doc = { docId: 'd1', t_recv: at(D, 11, 20), headline: 'Analyst upgrades Nvidia to Buy', symbols: ['NVDA'] };
  const ev = Cx.eventTriggers(['NVDA', 'AMD', 'TSLA'], D, [doc], 960, (s) => ser[s] || null, () => 5);
  check('T6 EVENT: the upgrade -> NVDA EVENT_SELF UP only (category rule); AMD EVENT_PEER both sides; TSLA none; at the receipt time',
    JSON.stringify(ev.map((o) => `${o.symbol}:${o.trigger}:${o.dir}`).sort()) === JSON.stringify(['AMD:EVENT_PEER:DOWN', 'AMD:EVENT_PEER:UP', 'NVDA:EVENT_SELF:UP']) && ev.every((o) => o.tAvail === doc.t_recv), JSON.stringify(ev.map((o) => o.symbol + o.trigger + o.dir)));
  check('T6 REACTIVE: a stock that already moved >= 1.5 x ATR30 in the 30 min before the article gets no event', Cx.eventTriggers(['NVDA'], D, [doc], 960, (s) => ser[s] || null, () => 0.5).length === 0);

  // ---------- the frozen protocol (docs/research/phase95-protocol.md) ----------
  const P = T('tools/research/shadow/protocol');
  check('protocol: alpha_1 = 0.0608, alpha_2 = 0.0152 (sum <= 0.10); beta_1 = 0.0304', P.alphaK(1).toFixed(4) === '0.0608' && P.alphaK(2).toFixed(4) === '0.0152' && P.betaK(1).toFixed(4) === '0.0304');
  check('protocol: BH at 0.05 on [0.001, 0.02, 0.04, 0.5] rejects the first two; BY (any dependence) only the first',
    JSON.stringify(P.stepUp([0.001, 0.02, 0.04, 0.5], 0.05)) === '[true,true,false,false]' && JSON.stringify(P.stepUp([0.001, 0.02, 0.04, 0.5], 0.05, true)) === '[true,false,false,false]');
  const dayN = (i) => new Date(Date.UTC(2027, 0, 4) + i * 86400000).toISOString().slice(0, 10);
  const pos = Array.from({ length: 40 }, (_, i) => [5 + (i % 3), 4 - (i % 2)]); const zero = Array.from({ length: 40 }, (_, i) => [i % 2 ? 6 : -6, i % 3 ? -5 : 5]);
  const b1 = P.bootstrap(pos, 'x'); const b2 = P.bootstrap(pos, 'x');
  check('protocol: day-block bootstrap, centred, B = 10,000, seeded by the candidate id: a clearly positive book p ~ 1 / (B + 1); a zero-mean one far from it; the same id = the same p',
    b1.p < 0.001 && b1.p === b2.p && P.bootstrap(zero, 'y').p > 0.1 && b1.lo95 > 0, JSON.stringify({ p: b1.p, z: P.bootstrap(zero, 'y').p }));
  const bk = (id, family, netOf, days, syms = 10) => ({ id, family, rule: 'Q+20/30m', label: 'INDICATIVE_ESTIMATE', entries: days.flatMap((d, i) => [0, 1].map((j) => ({ status: 'ENTERED',
    outcome: { opp: { day: d, symbol: `S${(i + j) % syms}` }, exit: { status: 'CLOSED', net: netOf(i, j) }, stressNet: netOf(i, j) - 0.5 } }))) });
  const d40 = Array.from({ length: 40 }, (_, i) => dayN(i)); const disc = path.join(DIR, 'discovery');
  const res40 = { days: d40, opportunities: d40.flatMap((d) => Array.from({ length: 10 }, (_, s) => ({ symbol: `S${s}`, day: d }))),
    books: [bk('ORB5|Q+20/30m|INDICATIVE_ESTIMATE', 'ORB5', (i, j) => 6 + ((i + j) % 4), d40), bk('VWAP_LOSS|Q+20/30m|INDICATIVE_ESTIMATE', 'VWAP_LOSS', (i, j) => ((i + j) % 2 ? 7 : -7), d40),
      bk('CONTROL|Q+20/30m|INDICATIVE_ESTIMATE', 'CONTROL', (i, j) => ((i * 7 + j) % 5) - 2, d40)] };
  const protoFile = path.join(ROOT, 'docs', 'research', 'phase95-protocol.md');
  const s1 = P.step({ result: res40, protocolFile: protoFile, dir: disc, today: d40[39] });
  const run1 = JSON.parse(fs.readFileSync(path.join(disc, 'run-1.json'), 'utf8'));
  check('protocol run 1: due (>= 200 symbol-days); the candidate list written + hashed first (CONTROL never a candidate); the strong book PROMISING and frozen; the noise book tested, kept, not promising',
    s1.ranNow && s1.ranNow.k === 1 && fs.existsSync(path.join(disc, 'run-1-candidates.json')) && run1.results.length === 2 && run1.results.find((c) => c.id.startsWith('ORB5')).promising
    && run1.results.find((c) => c.id.startsWith('VWAP')).tested && !run1.results.find((c) => c.id.startsWith('VWAP')).promising && s1.forward.length === 0
    && fs.readdirSync(path.join(disc, 'proposals')).length === 1, JSON.stringify(run1.results.map((c) => [c.id, c.p, c.promising])));
  const s2 = P.step({ result: res40, protocolFile: protoFile, dir: disc, today: d40[39] });
  check('protocol: re-running the same day neither repeats run 1 nor re-freezes; the proposal is interim (not a verdict)', !s2.ranNow && s2.runs.length === 1 && s2.forward.length === 1 && s2.forward[0].verdict === null);
  const d80 = Array.from({ length: 81 }, (_, i) => dayN(i));
  const res80 = { ...res40, days: d80, books: [bk('ORB5|Q+20/30m|INDICATIVE_ESTIMATE', 'ORB5', (i, j) => 6 + ((i + j) % 4), d80), res40.books[1], res40.books[2]] };
  const s3 = P.step({ result: res80, protocolFile: protoFile, dir: disc, today: d80[80] });
  check('protocol forward: one look at forward n_eff 40 (trades after the freeze day only) -> PASSED-INDICATIVE (indicative prices: never VALIDATED); those days left the discovery pool',
    s3.forward[0].verdict === 'PASSED-INDICATIVE' && s3.poolDays === 40, JSON.stringify({ v: s3.forward[0].verdict, pool: s3.poolDays }));

  // ---------- import guard ----------
  const before = new Set(Object.keys(require.cache));
  for (const f of ['ingest', 'opportunities', 'fills', 'exits', 'books', 'run', 'report']) T(`tools/research/shadow/${f}`);
  const loaded = Object.keys(require.cache).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  check('import guard: the research job loads no broker, execution, strategy or vault module', !loaded.some((f) => /server\/(execution|connectors\/(alpaca-api|alpaca-paper|alpaca-options|coinbase|kraken|okx)|strategies|security|risk)\//.test(f)), loaded.filter((f) => /execution|strategies|security|risk\//.test(f)).join(','));
  void before;

  // ---------- /research/latest (signed-in only; the newest report) ----------
  const ap = path.join(ROOT, 'server', 'security', 'access-policy.js'); let allow = false;
  require.cache[require.resolve(ap)] = { id: ap, filename: ap, loaded: true, exports: { checkHttp: () => ({ ok: allow }) } };
  let handler = null; T('server/http-routes').installResearch({ get: (p, fn) => { if (p === '/research/latest') handler = fn; } }, 3000);
  const resOf = () => { const r = { code: 200, sent: null, file: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.send = (x) => { r.sent = x; return r; }; r.type = () => r;
    r.set = (h) => { Object.assign(r.headers, h); return r; }; r.sendFile = (f) => { r.file = f; return r; }; return r; };
  let r1 = resOf(); handler({}, r1);
  allow = true; const r2 = resOf(); handler({}, r2);
  check('/research/latest: refused without sign-in (403); signed in, the newest reports/shadow-<day>.html under a no-script CSP (or 404 before the first report)',
    r1.code === 403 && !r1.file && ((r2.file && /shadow-\d{4}-\d{2}-\d{2}\.html$/.test(r2.file) && /default-src 'none'/.test(r2.headers['Content-Security-Policy'])) || r2.code === 404), JSON.stringify({ c1: r1.code, c2: r2.code, f: r2.file }));
  console.log(`\nph95shadow: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
