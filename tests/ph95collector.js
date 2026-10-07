// Phase 95 M1 (VM research collector, RECORD-ONLY). Task 1.1: the import guard, the shared request limiter, the heartbeat, the
// graceful shutdown; the data-keys module equals alpaca-api.dataKeys without importing broker code. Scratch dirs, dead URLs, no
// network. Run: node tests/ph95collector.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph95c-'));
Object.assign(process.env, { EVENTS_DIR: path.join(DIR, 'events'), LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), ALPACA_DATA_BASE_URL: 'http://127.0.0.1:9',
  FINNHUB_BASE_URL: 'http://127.0.0.1:9', ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: '', ALPACA_PAPER_API_SECRET: '' });
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

// Static require graph from a set of entry files (every require('<relative>') string, lazy ones included).
function reach(entries) {
  const seen = new Set(); const todo = [...entries];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let p = path.resolve(path.dirname(f), m[1]); if (!p.endsWith('.js')) p += fs.existsSync(`${p}.js`) ? '.js' : '/index.js';
      if (fs.existsSync(p)) todo.push(p);
    }
  }
  return [...seen].map((f) => path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/'));
}
const FORBIDDEN = /^server\/(execution|risk|strategies|security)\/|^server\/connectors\/(?!net-guard\.js$)|^server\/server\.js$|^server\/market\/market-session\.js$/;

(async () => {
  const colDir = path.join(S, 'research', 'collector');
  const entries = fs.readdirSync(colDir).filter((f) => f.endsWith('.js')).map((f) => path.join(colDir, f));
  const graph = reach(entries);
  const bad = graph.filter((f) => FORBIDDEN.test(f));
  check('import guard: nothing reachable from server/research/collector/* is trading code, a broker connector, the server or market-session', bad.length === 0, bad.join(', '));
  check('import guard: the graph does reach the shared research modules it needs (sanity)', graph.includes('server/research/event-recorder.js') && graph.includes('server/research/news-capture.js'), graph.join(' '));
  const srcs = graph.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  check('import guard: no broker key name or trading base URL in the collector graph', !/KRAKEN_|OKX_|COINBASE_|ALPACA_TRADING_BASE_URL|paper-api\.alpaca|api\.alpaca\.markets\/v2\/orders/.test(srcs));

  // data-keys == alpaca-api.dataKeys for every key combination
  const dk = require(S + 'research/data-keys'); const aa = require(S + 'connectors/alpaca-api');
  const combos = [{}, { ALPACA_API_KEY: 'PKa', ALPACA_API_SECRET: 's' }, { ALPACA_PAPER_API_KEY: 'PKp', ALPACA_PAPER_API_SECRET: 'sp' },
    { ALPACA_API_KEY: 'PKa', ALPACA_API_SECRET: 's', ALPACA_PAPER_API_KEY: 'PKp', ALPACA_PAPER_API_SECRET: 'sp' }, { ALPACA_API_KEY: 'AKlive', ALPACA_API_SECRET: 's' }];
  const keep = { ...process.env }; let same = true;
  for (const c of combos) { for (const k of ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER_API_KEY', 'ALPACA_PAPER_API_SECRET']) process.env[k] = c[k] || ''; if (JSON.stringify(dk.dataKeys()) !== JSON.stringify(aa.dataKeys())) same = false; }
  Object.assign(process.env, keep);
  check('data-keys.dataKeys() answers exactly what alpaca-api.dataKeys() answers (5 key combinations)', same);

  // limiter
  const { createLimiter } = require(S + 'research/collector/budget');
  let t = 0; const slept = []; const L = createLimiter({ perMin: 40, pauseMs: 120000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  for (let i = 0; i < 40; i += 1) await L.acquire();
  check('limiter: 40 requests in a minute go through without waiting', t === 0 && L.stats().usedLastMin === 40);
  await L.acquire();
  check('limiter: the 41st waits until the oldest leaves the 60 s window', t >= 60000 && L.stats().total === 41, `t=${t}`);
  L.report(429); const t429 = t; await L.acquire();
  check('limiter: after a 429 nothing goes out for 2 minutes', t - t429 >= 120000 && L.stats().r429 === 1, `waited ${t - t429}`);
  L.report(200);
  check('limiter: stats name the ceiling, usage, 429s and the pause', L.stats().perMin === 40 && 'pausedUntil' in L.stats());

  // regression: a process whose only pending work is a limiter wait must stay alive (an unref'd wait let a CLI exit after 60 requests)
  const child = require('child_process').spawnSync(process.execPath, ['-e', `const { createLimiter } = require(${JSON.stringify(S + 'research/collector/budget')});
    const L = createLimiter({ perMin: 1, windowMs: 300 }); (async () => { await L.acquire(); await L.acquire(); console.log('second slot'); })();`], { encoding: 'utf8', timeout: 10000 });
  check('limiter: a process waiting for its next slot stays alive and gets it (no silent exit)', /second slot/.test(child.stdout), `${child.status} ${child.stdout} ${child.stderr}`);

  // heartbeat
  const ev = require(S + 'research/event-recorder'); ev._test.reset();
  const hb = require(S + 'research/collector/heartbeat');
  const line = hb.beat({ limiter: L, grid: () => ({ contracts: 1234, pinned: 56 }), exporter: () => ({ backlogFiles: 2, uploadedToday: 9 }), now: Date.parse('2026-10-08T15:00:00Z') });
  check('heartbeat: collector CPU / RSS, requests / min, 429s, grid + pinned counts, bytes today, export backlog', line && line.kind === 'HEARTBEAT'
    && Number.isFinite(line.collector.rssMb) && line.requests.perMin === 40 && line.requests.r429 === 1 && line.grid.contracts === 1234 && line.grid.pinned === 56
    && 'bytesToday' in line && line.export.backlogFiles === 2, JSON.stringify(line));
  await ev.flush();
  const files = fs.existsSync(process.env.EVENTS_DIR) ? fs.readdirSync(process.env.EVENTS_DIR) : [];
  const recorded = files.filter((f) => /^events-/.test(f)).flatMap((f) => fs.readFileSync(path.join(process.env.EVENTS_DIR, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  check('heartbeat: written to the events file as kind HEARTBEAT', recorded.some((x) => x.kind === 'HEARTBEAT' && x.grid && x.grid.contracts === 1234), files.join());

  // the shared NYSE calendar (the collector's market-open check: no broker clock)
  const cal = require(S + 'research/nyse-calendar'); const et = require(S + 'services/et-time');
  check('calendar: open Thu 2026-10-08 10:00 ET; closed 09:29 and 16:00; closed on Thanksgiving; the 2026-11-27 early close shuts at 13:00',
    cal.isOpen(et.toEpoch('2026-10-08', 10, 0)) && !cal.isOpen(et.toEpoch('2026-10-08', 9, 29)) && !cal.isOpen(et.toEpoch('2026-10-08', 16, 0))
    && !cal.isOpen(et.toEpoch('2026-11-26', 11, 0)) && cal.isOpen(et.toEpoch('2026-11-27', 12, 59)) && !cal.isOpen(et.toEpoch('2026-11-27', 13, 0)));
  const nc = require(S + 'research/news-capture');
  check('news capture: the market-open check is injected by the host (default closed), never imported', typeof nc.useMarketOpen === 'function'
    && !/market-session/.test(fs.readFileSync(S + 'research/news-capture.js', 'utf8').replace(/\/\/.*$/gm, '')));

  // a standalone process: start() must hold a REF'd handle (the reused timers are all unref'd), shutdown() releases it
  const main = require(S + 'research/collector/main');
  process.env.EVENTS_DIR = path.join(DIR, 'events2'); main.start();
  check('main: start() keeps the process alive (a REF\'d keep-alive timer) and installs a SIGTERM handler', main._test.keptAlive() && process.listenerCount('SIGTERM') === 1);
  // shutdown
  const t0 = Date.now(); const r = await main.shutdown({ reason: 'test' });
  check('shutdown: stops the timers, flushes the recorder, resolves within 5 s', r.ok === true && Date.now() - t0 < 5000, JSON.stringify(r));
  check('main: shutdown() releases the keep-alive (the process can exit)', !main._test.keptAlive());

  console.log(`\nph95collector: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
