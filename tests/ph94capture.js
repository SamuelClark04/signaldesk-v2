// Phase 94 Stage 1: record-only event capture (shared sink, event recorder, news tap + poll, macro / earnings snapshots, option marks,
// the PC pilot check). Run: node tests/ph94capture.js. Scratch folders in the OS temp dir, dead URLs, no network unless a test injects a
// fake fetch. Corrections C2 (no duplicate on retry, visible stall), C3 (pagination / restart gaps / accept-then-cache), C4 (pilot health).
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94c-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), DECISIONS_DIR: path.join(DIR, 'decisions'), EVENTS_DIR: path.join(DIR, 'events'), MACRO_CALENDAR_URL: DEAD,
  ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKTEST', ALPACA_PAPER_API_SECRET: 'test', ALPACA_DATA_BASE_URL: DEAD, ALPACA_PAPER_BASE_URL: DEAD,
  FINNHUB_API_KEY: '', FINNHUB_BASE_URL: DEAD, OPENAI_API_KEY: '', GEMINI_API_KEY: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_BASE_URL: DEAD, OKX_BASE_URL: DEAD });
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
console.warn = ((w) => (...a) => { if (!/^\[(event-recorder|news-capture|earnings-snapshot|macro|options-data)\]/.test(String(a[0]))) w(...a); })(console.warn);
console.log = ((l) => (...a) => { if (!/^\[macro\]/.test(String(a[0]))) l(...a); })(console.log);
const readEvents = () => { const d = process.env.EVENTS_DIR; if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => /^events-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))); };
const wipeEvents = () => { const d = process.env.EVENTS_DIR; if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) fs.unlinkSync(path.join(d, f)); }; // each section reads only its own lines

(async () => {
  // ---------- Task 9: the shared sink ----------
  const { createSink } = require(S + 'research/jsonl-sink');
  const sd = path.join(DIR, 'sink'); let now = Date.parse('2026-10-06T14:00:00Z');
  const warns = [];
  const sink = createSink({ prefix: 'probe', dir: () => sd, dayOf: (ms) => new Date(ms).toISOString().slice(0, 10), serialize: (e) => ({ lines: [JSON.stringify(e)] }), maxQueue: 3, clock: () => now, warn: (m) => warns.push(m) });
  for (let i = 0; i < 5; i += 1) sink.push({ at: now, i });
  check('sink: bounded queue drops the OLDEST and counts it', sink.queue().map((e) => e.i).join() === '2,3,4' && sink.status().dropped === 2);
  sink.setFs({ mkdir: async () => {}, appendFile: async () => { throw new Error('disk full'); } });
  await sink.flush();
  check('sink: a failed write re-queues the batch and counts the error', sink.status().writeErrors === 1 && sink.queue().length === 3);
  sink.setFs(null); await sink.flush();
  check('sink: one append per day file, lines intact', fs.readFileSync(path.join(sd, 'probe-2026-10-06.jsonl'), 'utf8').trim().split('\n').length === 3 && sink.status().lastWriteAt === now);
  fs.writeFileSync(path.join(sd, 'probe-2025-01-01.jsonl'), '{}\n'); sink.prune(now);
  check('sink: prune removes day files older than keepDays (180 default)', !fs.existsSync(path.join(sd, 'probe-2025-01-01.jsonl')) && fs.existsSync(path.join(sd, 'probe-2026-10-06.jsonl')));
  // C2: two day files in one flush; the first append succeeds, the second fails -> only the second file's entries are retried.
  const sd2 = path.join(DIR, 'sink2'); const committed = [];
  const s2 = createSink({ prefix: 'p2', dir: () => sd2, dayOf: (ms) => new Date(ms).toISOString().slice(0, 10), serialize: (e) => ({ lines: [JSON.stringify(e)] }),
    onCommitted: (state, written) => committed.push([...written].map((f) => path.basename(f))), clock: () => now });
  s2.push({ at: Date.parse('2026-10-05T14:00:00Z'), k: 'a1' }); s2.push({ at: Date.parse('2026-10-05T15:00:00Z'), k: 'a2' }); s2.push({ at: Date.parse('2026-10-06T14:00:00Z'), k: 'b1' });
  let calls = 0;
  s2.setFs({ mkdir: async (d, o) => fs.promises.mkdir(d, o), appendFile: async (f, t) => { calls += 1; if (calls === 2) throw new Error('disk full'); return fs.promises.appendFile(f, t); } });
  await s2.flush();
  check('C2: after a partial failure only the UNWRITTEN file\'s entries are re-queued', s2.queue().map((e) => e.k).join() === 'b1' && committed[0].join() === 'p2-2026-10-05.jsonl');
  s2.setFs(null); await s2.flush();
  const f5 = fs.readFileSync(path.join(sd2, 'p2-2026-10-05.jsonl'), 'utf8').trim().split('\n'); const f6 = fs.readFileSync(path.join(sd2, 'p2-2026-10-06.jsonl'), 'utf8').trim().split('\n');
  check('C2: the retry writes the failed file once and never duplicates the file already written', f5.length === 2 && f6.length === 1 && s2.queue().length === 0);
  // C2: a write that never returns is a visible STALL; recording keeps working (bounded) and nothing waits on the disk.
  const s3w = []; let n3 = Date.parse('2026-10-06T14:00:00Z');
  const s3 = createSink({ prefix: 'p3', dir: () => path.join(DIR, 'sink3'), dayOf: () => '2026-10-06', serialize: (e) => ({ lines: [JSON.stringify(e)] }), maxQueue: 100, clock: () => n3, warn: (m) => s3w.push(m) });
  s3.setFs({ mkdir: async () => {}, appendFile: () => new Promise(() => {}) });
  s3.push({ at: n3, k: 1 }); s3.flush(); await new Promise((r) => setImmediate(r));
  n3 += 31000;
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 50; i += 1) s3.push({ at: n3, k: i }); const pushMs = Number(process.hrtime.bigint() - t0) / 1e6;
  await s3.flush();
  check('C2: a write in flight > 30 s shows stalled / stalledForMs and logs a STALL warning', s3.status().stalled === true && s3.status().stalledForMs >= 31000 && s3w.some((m) => /STALLED/.test(m)) && s3.status().stalls === 1);
  check('C2: while stalled, records are still accepted at once (bounded queue), nothing awaits the disk', s3.queue().length === 50 && pushMs < 20);

  // Review fix: one entry with a time dayOf cannot format must cost only THAT entry (a serialize error), never the batch.
  const s4 = createSink({ prefix: 'p4', dir: () => path.join(DIR, 'sink4'), dayOf: (ms) => new Date(ms).toISOString().slice(0, 10), serialize: (e) => ({ lines: [JSON.stringify(e)] }), clock: () => now });
  s4.push({ at: now, k: 'a' }); s4.push({ at: 'not-a-time', k: 'bad' }); s4.push({ at: Infinity, k: 'bad2' }); s4.push({ at: now, k: 'c' });
  await s4.flush();
  const f4 = fs.readFileSync(path.join(DIR, 'sink4', 'p4-2026-10-06.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).k);
  check('sink (review): a bad entry time drops only that entry (serializeErrors), the rest are written', f4.join() === 'a,c' && s4.status().serializeErrors === 2 && s4.status().writeErrors === 0, `${f4} ${JSON.stringify(s4.status())}`);
  // Review fix: a decision whose final serialization throws must not leave its series keys marked "written" (no dangling references).
  const rec93 = require(S + 'research/decision-recorder'); const dc93 = require(S + 'research/decision-context');
  rec93._test.reset(); rec93._test.setClock(() => Date.parse('2026-10-06T14:00:00Z'));
  const bars5 = Array.from({ length: 5 }, (_, i) => ({ time: 1790000000 + i * 60, open: 1, high: 2, low: 0.5, close: 1 + i, volume: 10 }));
  dc93.capture('dang:A', { symbol: 'X', series: [{ name: 'b', tf: '5m', bars: bars5 }] }); dc93.capture('dang:B', { symbol: 'X', series: [{ name: 'b', tf: '5m', bars: bars5 }] });
  rec93.record('PIPELINE_REJECT', 'dang:A', { reason: 'x', candidate: { asset: 'X' }, extra: { big: 10n } }); // BigInt: JSON.stringify throws on the decision line
  rec93.record('PIPELINE_REJECT', 'dang:B', { reason: 'x', candidate: { asset: 'X' } });
  await rec93.flush();
  const DL = fs.readdirSync(process.env.DECISIONS_DIR).flatMap((f) => fs.readFileSync(path.join(process.env.DECISIONS_DIR, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const bLine = DL.find((x) => x.type === 'decision' && x.id === 'dang:B'); const key = bLine && bLine.context.series[0].key;
  check('sink (review): a decision that fails to serialize leaves no dangling series key: B references a series that IS in the file', !!key && DL.some((x) => x.type === 'series' && x.key === key) && !DL.some((x) => x.id === 'dang:A'), key);

  // ---------- Task 10: the event recorder ----------
  const ev = require(S + 'research/event-recorder');
  ev._test.reset(); ev._test.setClock(() => Date.parse('2026-10-06T14:00:00Z'));
  let threw = false;
  try { ev.record('NEWS', { headline: 'x' }); ev.record('BOGUS', {}); ev.record('NEWS', null); ev.record('NEWS', { get bad() { throw new Error('boom'); } }); } catch { threw = true; }
  check('event recorder: record() never throws; unknown kinds refused', !threw && ev.status().byKind.NEWS >= 1 && !ev.status().byKind.BOGUS && ev.status().recordErrors === 1);
  const t1 = process.hrtime.bigint(); for (let i = 0; i < 2000; i += 1) ev.record('OPTION_MARK', { contract: `C${i}` });
  check('event recorder: 2,000 records take < 50 ms (no serialization in the call)', Number(process.hrtime.bigint() - t1) / 1e6 < 50);
  ev.start(); await new Promise((r) => setTimeout(r, 30)); ev._test.statusDue(); await ev.flush(); ev.stop();
  const E = readEvents();
  check('event recorder: lines carry kind + at + v, in events-YYYY-MM-DD.jsonl (New York date)', E.length >= 2001 && E.every((x) => x.kind && Number.isFinite(x.at) && x.v === 1)
    && fs.existsSync(path.join(process.env.EVENTS_DIR, 'events-2026-10-06.jsonl')));
  const stl = E.find((x) => x.kind === 'STATUS');
  check('C4: STATUS lines carry process health (CPU %, RSS / heap MB, event-loop p99) labelled whole-process', stl && stl.health && stl.health.scope === 'whole server process'
    && Number.isFinite(stl.health.rssMb) && Number.isFinite(stl.health.heapMb) && 'loopP99Ms' in stl.health && 'cpuPct' in stl.health && 'stalled' in stl, JSON.stringify(stl && stl.health));
  const ver = require(S + 'version').report({});
  check('/api/version carries the event recorder status', ver.eventRecorder && Number.isFinite(ver.eventRecorder.dropped) && ver.eventRecorder.recordedToday >= 2001);
  process.env.EVENTS_RECORDER = 'off'; check('EVENTS_RECORDER=off disables recording', ev.record('NEWS', {}) === false);
  const before10 = readEvents().filter((x) => x.kind === 'STATUS').length; ev._test.statusDue(); await ev.flush();
  check('event recorder (review): no STATUS line is written while recording is off', readEvents().filter((x) => x.kind === 'STATUS').length === before10);
  delete process.env.EVENTS_RECORDER;
  ev.record('NEWS', { kind: 'BOGUS', at: Date.parse('2026-01-02T12:00:00Z'), v: 9, headline: 'x' }); await ev.flush();
  check('event recorder (review): data cannot override kind / at / v (no BOGUS line, no other day file)', !readEvents().some((x) => x.kind === 'BOGUS' || x.v === 9)
    && !fs.existsSync(path.join(process.env.EVENTS_DIR, 'events-2026-01-02.jsonl')));
  check('C4 (review): event-loop delay is reported BEYOND the 20 ms sampling interval (an idle loop is not 20 ms of delay)', stl.health.loopP99Ms < 20 && /sampling interval/.test(stl.health.loopNote));

  // (Tasks 11-13 sections follow, in tests/ph94capture-news.js, -taps.js and -pilot.js.)
  require('./ph94capture-news')({ S, DIR, DEAD, check, readEvents, wipeEvents, ev })
    .then(() => require('./ph94capture-taps')({ S, DIR, DEAD, check, readEvents, wipeEvents, ev }))
    .then(() => require('./ph94capture-pilot')({ check }))
    .then(() => { console.log(`\nph94capture: ${fails ? `${fails} FAIL` : 'all passed'}`); process.exit(fails ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); });
})().catch((e) => { console.error(e); process.exit(1); });
