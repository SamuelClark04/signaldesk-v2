// Phase 95 M1 (VM research collector, RECORD-ONLY). Task 1.1 + its review fixes: the module allowlist, its own file identity, the one
// RESEARCH_COLLECTOR switch (never two pollers), the request limiter on every Alpaca call, .env parsing like dotenv, the heartbeat,
// the graceful shutdown that waits for a write in flight. Scratch dirs, dead URLs, no network, never the machine's .env.
// Run: node tests/ph95collector.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph95c-'));
const ALLOWED_ENV = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER_API_KEY', 'ALPACA_PAPER_API_SECRET', 'ALPACA_DATA_BASE_URL', 'FINNHUB_API_KEY', 'FINNHUB_BASE_URL',
  'EVENTS_DIR', 'EVENTS_RECORDER', 'LEDGER_STATE_PATH', 'RESEARCH_GCS_BUCKET', 'RESEARCH_COLLECTOR', 'RESEARCH_COLLECTOR_PER_MIN'];
for (const k of ALLOWED_ENV) delete process.env[k];
Object.assign(process.env, { EVENTS_DIR: path.join(DIR, 'events'), LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), ALPACA_DATA_BASE_URL: 'http://127.0.0.1:9', FINNHUB_BASE_URL: 'http://127.0.0.1:9' });
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
const ROOT = path.join(__dirname, '..'); const S = path.join(ROOT, 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

// The static module graph: every literal relative require; any NON-literal require (variable, template, import()) is reported.
function graphOf(entries) {
  const seen = new Set(); const todo = [...entries]; const nonLiteral = [];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/require\(\s*([^)]*?)\s*\)/g)) {
      const arg = m[1];
      if (!/^['"][^'"]+['"]$/.test(arg)) { nonLiteral.push(`${path.basename(f)}: require(${arg})`); continue; }
      const spec = arg.slice(1, -1); if (!spec.startsWith('.')) continue;
      let p = path.resolve(path.dirname(f), spec); if (!p.endsWith('.js')) p += fs.existsSync(`${p}.js`) ? '.js' : '/index.js';
      if (fs.existsSync(p)) todo.push(p);
    }
    if (/\bimport\(/.test(src)) nonLiteral.push(`${path.basename(f)}: import()`);
  }
  return { files: [...seen].map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort(), nonLiteral };
}
// The EXACT allowlist: adding any module to the collector's graph is a deliberate change of this list, reviewed.
const EXPECTED = ['server/connectors/net-guard.js', 'server/market/universe.js', 'server/research/capture-universe.js', 'server/research/collector/budget.js',
  'server/research/collector/heartbeat.js', 'server/research/collector/main.js', 'server/research/data-keys.js', 'server/research/earnings-snapshot.js',
  'server/research/event-recorder.js', 'server/research/jsonl-sink.js', 'server/research/news-capture.js', 'server/research/nyse-calendar.js', 'server/services/et-time.js'];

(async () => {
  const colDir = path.join(S, 'research', 'collector');
  const g = graphOf(fs.readdirSync(colDir).filter((f) => f.endsWith('.js')).map((f) => path.join(colDir, f)));
  check('allowlist: the collector\'s module graph is EXACTLY the reviewed list (no trading, broker, server, market-session, config or vault module)',
    JSON.stringify(g.files) === JSON.stringify(EXPECTED), `extra: ${g.files.filter((f) => !EXPECTED.includes(f)).join(', ')} missing: ${EXPECTED.filter((f) => !g.files.includes(f)).join(', ')}`);
  check('allowlist: no non-literal require / import() anywhere in the graph (it could load anything)', g.nonLiteral.length === 0, g.nonLiteral.join('; '));
  const srcs = g.files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  check('no broker key name or trading base URL in the collector graph', !/KRAKEN_|OKX_|COINBASE_|ALPACA_TRADING_BASE_URL|paper-api\.alpaca|LAN_ACCESS_TOKEN|credentials\.enc/.test(srcs));
  const plant = path.join(colDir, `zz-planted-${process.pid}.js`);
  fs.writeFileSync(plant, "const x = () => require('../../connectors/alpaca-api');\nconst y = (m) => require(m);\n");
  const gp = graphOf([plant]); fs.rmSync(plant);
  check('a planted broker import and a planted non-literal require are both caught', gp.files.includes('server/connectors/alpaca-api.js') && gp.nonLiteral.length === 1);

  const dk = require(S + 'research/data-keys'); const aa = require(S + 'connectors/alpaca-api');
  const combos = [{}, { ALPACA_API_KEY: 'PKa', ALPACA_API_SECRET: 's' }, { ALPACA_PAPER_API_KEY: 'PKp', ALPACA_PAPER_API_SECRET: 'sp' },
    { ALPACA_API_KEY: 'PKa', ALPACA_API_SECRET: 's', ALPACA_PAPER_API_KEY: 'PKp', ALPACA_PAPER_API_SECRET: 'sp' }, { ALPACA_API_KEY: 'AKlive', ALPACA_API_SECRET: 's' }];
  let same = true;
  for (const c of combos) { for (const k of ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER_API_KEY', 'ALPACA_PAPER_API_SECRET']) { if (c[k]) process.env[k] = c[k]; else delete process.env[k]; }
    if (JSON.stringify(dk.dataKeys()) !== JSON.stringify(aa.dataKeys())) same = false; }
  for (const k of ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER_API_KEY', 'ALPACA_PAPER_API_SECRET']) delete process.env[k];
  check('data-keys.dataKeys() answers exactly what alpaca-api.dataKeys() answers (5 key combinations)', same);

  const { createLimiter } = require(S + 'research/collector/budget');
  let t = 0; const L = createLimiter({ perMin: 40, pauseMs: 120000, now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 40; i += 1) await L.acquire();
  check('limiter: 40 requests in a minute go through without waiting', t === 0 && L.stats().usedLastMin === 40);
  await L.acquire();
  check('limiter: the 41st waits until the oldest leaves the 60 s window', t >= 60000 && L.stats().total === 41, `t=${t}`);
  L.report(429); const t429 = t; await L.acquire();
  check('limiter: after a 429 nothing goes out for 2 minutes', t - t429 >= 120000 && L.stats().r429 === 1, `waited ${t - t429}`);
  let tn = 0; const Ln = createLimiter({ perMin: -5, now: () => tn, sleep: async (ms) => { tn += ms; } }); await Ln.acquire();
  check('limiter: a zero / negative ceiling is clamped to 1 (acquire never hangs)', Ln.stats().perMin === 1);
  const child = require('child_process').spawnSync(process.execPath, ['-e', `const { createLimiter } = require(${JSON.stringify(S + 'research/collector/budget')});
    const L = createLimiter({ perMin: 1, windowMs: 300 }); (async () => { await L.acquire(); await L.acquire(); console.log('second slot'); })();`], { encoding: 'utf8', timeout: 10000 });
  check('limiter: a process waiting for its next slot stays alive and gets it (no silent exit)', /second slot/.test(child.stdout), `${child.status} ${child.stderr}`);

  const cal = require(S + 'research/nyse-calendar'); const et = require(S + 'services/et-time');
  check('calendar: open Thu 2026-10-08 10:00 ET; closed 09:29 and 16:00; closed on Thanksgiving; the 2026-11-27 early close shuts at 13:00',
    cal.isOpen(et.toEpoch('2026-10-08', 10, 0)) && !cal.isOpen(et.toEpoch('2026-10-08', 9, 29)) && !cal.isOpen(et.toEpoch('2026-10-08', 16, 0))
    && !cal.isOpen(et.toEpoch('2026-11-26', 11, 0)) && cal.isOpen(et.toEpoch('2026-11-27', 12, 59)) && !cal.isOpen(et.toEpoch('2026-11-27', 13, 0)));

  // The SERVER side: event-capture injects the Alpaca clock, and RESEARCH_COLLECTOR=on stops its own poll.
  const nc = require(S + 'research/news-capture'); const ev = require(S + 'research/event-recorder');
  require.cache[require.resolve(S + 'market/market-session')] = { exports: { isEquityMarketOpen: () => true } };
  const ec = require(S + 'research/event-capture');
  ec.start();
  check('server: event-capture.start() gives the news poll the market-session answer (the server\'s Alpaca clock) and polls', nc._test.marketOpen() === true && nc._test.polling(), `${nc._test.marketOpen()}`);
  ec.stop(); nc.useMarketOpen(() => false);
  process.env.RESEARCH_COLLECTOR = 'on'; ec.start();
  check('server: with RESEARCH_COLLECTOR=on it does NOT poll (the collector does): never two pollers', !nc._test.polling() && ec.collectorPolls());
  ec.stop(); delete process.env.RESEARCH_COLLECTOR;

  // The collector: env from a SCRATCH .env (never the machine's), its own identity, polling only with the switch.
  const envFile = path.join(DIR, 'scratch.env');
  fs.writeFileSync(envFile, ['RESEARCH_COLLECTOR_PER_MIN=20', 'RESEARCH_GCS_BUCKET=b-1 # inline comment', 'export RESEARCH_COLLECTOR=off', '  FINNHUB_API_KEY = fk ',
    'KRAKEN_API_KEY=never-read', 'OKX_API_SECRET=never-read'].join('\r\n'));
  const main = require(S + 'research/collector/main');
  check('perMinOf: clamped to 1-150, default 40', main.perMinOf('0') === 40 && main.perMinOf('-5') === 1 && main.perMinOf('999') === 150 && main.perMinOf('20') === 20);
  main.start({ envFile });
  check('.env parsed like dotenv: inline comments, `export`, spaces; ONLY the allowed keys (no broker key)', process.env.RESEARCH_GCS_BUCKET === 'b-1' && process.env.RESEARCH_COLLECTOR === 'off'
    && process.env.FINNHUB_API_KEY === 'fk' && process.env.KRAKEN_API_KEY === undefined && process.env.OKX_API_SECRET === undefined, `${process.env.RESEARCH_GCS_BUCKET}|${process.env.FINNHUB_API_KEY}`);
  check('the limiter ceiling comes from .env (read BEFORE the limiter is built)', main._test.limiter().stats().perMin === 20);
  check('identity: research-<day>.jsonl, "research collector process", its own cursor file', ev.identity().prefix === 'research' && /collector/.test(ev.identity().scope)
    && path.basename(nc._test.cursorFile()) === 'news-cursor.json' && main.CURSOR === 'research-news-cursor.json');
  check('without RESEARCH_COLLECTOR=on the collector does NOT poll (the server still does)', !nc._test.polling() && main._test.keptAlive() && process.listenerCount('SIGTERM') === 1);

  // heartbeat: own counters + the trading server's last STATUS from ITS file
  const day = et.ymd(Date.now()); fs.mkdirSync(process.env.EVENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVENTS_DIR, `events-${day}.jsonl`), `${JSON.stringify({ v: 1, kind: 'STATUS', at: Date.now() - 1000, bootId: 'srv-1', dropped: 2, writeErrors: 0, health: { scope: 'whole server process', cpuPct: 7.5, rssMb: 210, loopP99Ms: 4 } })}\n`);
  const hb = require(S + 'research/collector/heartbeat');
  const line = hb.beat({ limiter: main._test.limiter(), grid: () => ({ contracts: 1234, pinned: 56 }), exporter: () => ({ backlogFiles: 2, uploadedToday: 9 }) });
  check('heartbeat: own CPU / RSS, requests, grid, recorder counters, export backlog, and the server\'s last STATUS', line && line.kind === 'HEARTBEAT' && line.requests.perMin === 20
    && line.grid.pinned === 56 && 'queued' in line.recorder && line.export.backlogFiles === 2 && line.server && line.server.bootId === 'srv-1' && line.server.rssMb === 210, JSON.stringify(line));
  check('heartbeat: the first beat after start has a CPU reading (the mark is seeded at start)', line.collector.cpuPct !== null, JSON.stringify(line.collector));

  // shutdown with a write in flight AND a record queued: waits, writes both, reports flushed.
  let release; const slow = { mkdir: async () => {}, appendFile: (f, d) => new Promise((r) => { release = () => fs.promises.appendFile(f, d).then(r); setTimeout(() => release(), 300); }) };
  ev._test.setFs(slow); ev.record('POLL_STATUS', { source: 'test', ok: true }); const inflight = ev.flush(); ev.record('POLL_STATUS', { source: 'test2', ok: true });
  const t0 = Date.now(); const r = await main.shutdown({ reason: 'test' }); await inflight; ev._test.setFs(null);
  check('shutdown: waits for the write in flight, then flushes the queue: nothing left, flushed true, within 5 s', r.ok && r.flushed === true && r.unwritten === 0 && Date.now() - t0 < 5000, JSON.stringify(r));
  const rf = fs.readdirSync(process.env.EVENTS_DIR).filter((f) => /^research-/.test(f));
  check('the collector wrote ONLY its own research-<day> file (never the server\'s events file)', rf.length === 1 && fs.readFileSync(path.join(process.env.EVENTS_DIR, rf[0]), 'utf8').includes('"source":"test2"'), rf.join());
  check('shutdown releases the keep-alive (the process can exit)', !main._test.keptAlive());

  console.log(`\nph95collector: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
