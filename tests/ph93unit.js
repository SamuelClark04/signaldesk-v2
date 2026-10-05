// Phase 93: the decision recorder (record-only, bounded, non-blocking) + decision inputs + the capture points.
// Run: node tests/ph93unit.js. Scratch ledger / decisions folder in the OS temp dir, fake keys, dead URLs, stubbed brokers.
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph93-'));
const DEAD = 'http://127.0.0.1:9';
const ENV = { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), PAPER_RUNS_PATH: path.join(DIR, 'runs.json'),
  DECISIONS_DIR: path.join(DIR, 'decisions'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_API_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKTEST', ALPACA_PAPER_API_SECRET: 'test', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD };
Object.assign(process.env, ENV);
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
fs.writeFileSync(ENV.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 10000, cryptoBankroll: 3000, stockMode: 'paper', cryptoMode: 'paper', paperStockBroker: 'internal', radarVersion: 1, strategyPauseVersion: 90 },
  pendingOrders: [], activePositions: [], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
console.warn = ((w) => (...a) => { if (!/^\[decision-recorder\]/.test(String(a[0]))) w(...a); })(console.warn);
const readLines = () => { const d = ENV.DECISIONS_DIR; if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))); };
const wipe = () => { if (fs.existsSync(ENV.DECISIONS_DIR)) for (const f of fs.readdirSync(ENV.DECISIONS_DIR)) fs.unlinkSync(path.join(ENV.DECISIONS_DIR, f)); };
const bars = (n, t0 = 1790000000, step = 60) => Array.from({ length: n }, (_, i) => ({ time: t0 + i * step, open: 100 + i * 0.01, high: 100.2 + i * 0.01, low: 99.8 + i * 0.01, close: 100.1 + i * 0.01, volume: 1000 + i }));

(async () => {
  const rec = require(S + 'research/decision-recorder');
  const dc = require(S + 'research/decision-context');
  const T = rec._test;
  let NOW = Date.parse('2026-10-06T14:00:00Z'); // 10:00 ET
  T.setClock(() => NOW);
  const cand = (id, extra = {}) => ({ id, asset: 'AAPL', market: 'stocks', strategyId: 'equity-day', setupType: 'ORB', direction: 'long', timeframe: '5m',
    entryZone: { min: 100, max: 100.2 }, invalidation: 99.5, targets: [{ level: 1, price: 101.6, allocation: 0.5 }, { level: 2, price: 102.3, allocation: 0.5 }], thesis: 'test', ...extra });

  // ---------- 1. record() never throws, stays synchronous and cheap ----------
  const circ = cand('equity-day:ORB:AAPL:2026-10-06'); circ.self = circ; circ.optionsData = { legs: [{ side: 'buy', strike: 1, self: circ }], quickFlip: { a: 1 } };
  let threw = false;
  try {
    rec.record('PIPELINE_REJECT', circ.id, { reason: 'Cost ceiling exceeded', candidate: circ });
    rec.record('STAGED', 'x', { candidate: { get asset() { throw new Error('boom'); } } });
    rec.record(null, 'y', {}); rec.record('STAGED', null, {}); rec.record('STAGED', 'z', null);
  } catch { threw = true; }
  check('record(): never throws (circular setup, a throwing getter, missing path / id / info)', !threw && rec.status().recordErrors >= 1, JSON.stringify(rec.status().lastError));
  const big = bars(5000);
  dc.capture('cap:1', { strategyId: 'equity-day', symbol: 'AAPL', values: { orHigh: 100, nested: { a: 1 }, list: [1, 2, 3] }, series: [{ name: 'session1m', tf: '1m', bars: big }] });
  check('capture(): the newest 3,000 bars kept (a slice, not the live array), longer series flagged truncated', dc.get('cap:1').series[0].bars.length === 3000
    && dc.get('cap:1').series[0].bars !== big && dc.get('cap:1').series[0].truncated === true);
  T.reset();
  let slow = null; T.setFs({ mkdir: async () => {}, appendFile: () => new Promise(() => {}) }); // a write that NEVER returns
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i += 1) rec.record('PIPELINE_REJECT', `id-${i}`, { reason: 'Cost ceiling exceeded', candidate: cand(`id-${i}`) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rec.flush(); // starts a write that hangs
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) rec.record('STAGED', `s-${i}`, { candidate: cand(`s-${i}`) });
  slow = Number(process.hrtime.bigint() - t1) / 1e6;
  check(`record(): 2,000 calls in ${ms.toFixed(1)} ms (synchronous, no serialization), and still fast (${slow.toFixed(1)} ms / 200) while a write hangs`, ms < 1500 && slow < 300);
  check('...a hanging write blocks only the writer: the next flush returns at once, records keep queueing', rec.status().writing === true && rec.status().queued === 200);
  T.reset(); T.setFs(null);

  // ---------- 2. Lifecycle kept in full, observations deduplicated with REPEATS ----------
  wipe();
  const id = 'equity-day:ORB:MSFT:2026-10-06';
  dc.capture(id, { strategyId: 'equity-day', symbol: 'MSFT', values: { orHigh: 410.5, vwap: 409.9 }, series: [{ name: 'session1m', tf: '1m', bars: bars(60) }, { name: 'spy1m', symbol: 'SPY', tf: '1m', bars: bars(60, 1790000000) }] });
  for (let i = 0; i < 4; i += 1) { rec.record('PIPELINE_REJECT', id, { reason: 'SECTOR_CAP_REACHED: Technology 1 / 1', candidate: cand(id, { asset: 'MSFT' }) }); NOW += 60000; }
  rec.record('STAGED', id, { candidate: cand(id, { asset: 'MSFT', positionSize: 10 }) }); NOW += 60000;
  rec.record('APPROVAL_HOLD', id, { reason: 'PORTFOLIO_RISK: open risk 6.2% > 6%', candidate: cand(id, { asset: 'MSFT' }) }); NOW += 60000;
  rec.record('APPROVAL_HOLD', id, { reason: 'PORTFOLIO_RISK: open risk 6.2% > 6%', candidate: cand(id, { asset: 'MSFT' }) }); NOW += 60000;
  rec.record('APPROVED', id, { candidate: cand(id, { asset: 'MSFT' }) });
  rec.record('OPENED', id, { candidate: cand(id, { asset: 'MSFT', fillPrice: 410.6, positionSize: 10 }) });
  rec.record('CLOSED', id, { reason: 'STOP_HIT', candidate: cand(id, { asset: 'MSFT', exitPrice: 409.4, netPnl: -12.3 }) });
  await rec.flush();
  const L = readLines();
  const dec = L.filter((x) => x.type === 'decision' && x.id === id);
  check('lifecycle: one PIPELINE_REJECT (first sight) + EVERY later event (STAGED, both APPROVAL_HOLDs, APPROVED, OPENED, CLOSED)',
    dec.map((x) => x.path).join() === 'PIPELINE_REJECT,STAGED,APPROVAL_HOLD,APPROVAL_HOLD,APPROVED,OPENED,CLOSED', dec.map((x) => x.path).join());
  const rp = L.find((x) => x.type === 'repeats' && x.id === id);
  check('repeats: the 3 later identical rejections are summarized (count 4) BEFORE the lifecycle event that follows them', rp && rp.count === 4 && L.indexOf(rp) < L.indexOf(dec[1]), JSON.stringify(rp));
  check('snapshot: the first record carries the setup levels, reason + bucket, and the recorded inputs by series key', dec[0].setup.invalidation === 99.5 && dec[0].reasonBucket
    && dec[0].context.values.orHigh === 410.5 && dec[0].context.series.length === 2 && dec[0].context.series.every((s) => s.key));
  const ser = L.filter((x) => x.type === 'series');
  check('series: each distinct series written ONCE per day file (7 decisions reference 2 series), as [t,o,h,l,c,v] rows', ser.length === 2 && ser[0].rows[0].length === 6 && ser[0].kind === 'bars', String(ser.length));
  check('CLOSED keeps the exit (price, reason, net)', dec[6].setup.exitPrice === 409.4 && dec[6].setup.netPnl === -12.3 && dec[6].reason === 'STOP_HIT');
  NOW += 16 * 60 * 1000;
  rec.record('PIPELINE_REJECT', 'equity-day:ORB:NVDA:2026-10-06', { reason: 'Cost ceiling exceeded', candidate: cand('n', { asset: 'NVDA' }) });
  for (let i = 0; i < 3; i += 1) { NOW += 6 * 60 * 1000; rec.record('PIPELINE_REJECT', 'equity-day:ORB:NVDA:2026-10-06', { reason: 'Cost ceiling exceeded', candidate: cand('n', { asset: 'NVDA' }) }); }
  await rec.flush();
  const rn = readLines().filter((x) => x.type === 'repeats' && x.id === 'equity-day:ORB:NVDA:2026-10-06');
  check('repeats: emitted at most every 15 min per key while a setup keeps being re-rejected', rn.length === 1 && rn[0].count === 4, JSON.stringify(rn));
  NOW = Date.parse('2026-10-07T13:00:00Z'); // next New York day
  rec.record('PIPELINE_REJECT', 'equity-day:ORB:AMD:2026-10-07', { reason: 'Cost ceiling exceeded', candidate: cand('a', { asset: 'AMD' }) });
  await rec.flush();
  check('day rollover: a new dated file; the dedupe map starts again', fs.readdirSync(ENV.DECISIONS_DIR).some((f) => f === 'decisions-2026-10-07.jsonl') && rec.status().recordedToday === 1);

  // ---------- 3. Bounded queue, failing writes, missing inputs: all visible ----------
  T.reset(); wipe();
  for (let i = 0; i < rec.MAX_QUEUE + 25; i += 1) rec.record('STAGED', `q-${i}`, { candidate: cand(`q-${i}`) });
  check('queue cap: 5,000 kept, the oldest 25 dropped and counted', rec.status().queued === rec.MAX_QUEUE && rec.status().dropped === 25);
  T.reset();
  T.setFs({ mkdir: async () => {}, appendFile: async () => { throw new Error('ENOSPC: no space left on device'); } });
  rec.record('STAGED', 'w-1', { candidate: cand('w-1') });
  await rec.flush();
  const s1 = rec.status();
  check('a failing write is counted with its error, and the batch stays queued for the next flush', s1.writeErrors === 1 && /ENOSPC/.test(s1.lastError) && s1.queued === 1, JSON.stringify(s1));
  T.setFs(null); await rec.flush();
  check('...the next good flush writes it', readLines().some((x) => x.id === 'w-1') && rec.status().queued === 0);
  rec.record('PIPELINE_REJECT', 'options-system:TREND:CALL:XOM:2026-10-07', { reason: 'MACRO_SHIELD_ACTIVE: CPI', candidate: { ...cand('m'), strategyId: 'options-system', asset: 'XOM' } });
  check('missingContext: a radar strategy decision that arrived without its inputs is counted', rec.status().missingContext === 1);
  const huge = { type: 'decision', id: 'h', context: { series: [{ name: 'x', symbol: 'X', tf: '1m', bars: bars(20000).map((b) => ({ ...b, note: 'y'.repeat(30) })) }] } };
  const out = require(S + 'research/decision-serialize').lines(huge, () => false, () => {});
  const sl = JSON.parse(out.lines[0]);
  check('a series line over 512 KB keeps its newest 500 rows, flagged truncated', out.truncated && sl.truncated && sl.rows.length === 500, `${sl.rows.length}`);
  rec.record('STAGED', 'off-1', { candidate: cand('off-1') });
  process.env.DECISIONS_RECORDER = 'off';
  check('DECISIONS_RECORDER=off disables recording (status says so)', rec.record('STAGED', 'off-2', { candidate: cand('off-2') }) === false && rec.status().enabled === false);
  delete process.env.DECISIONS_RECORDER;

  await require('./ph93hooks')({ S, check, rec, dc, readLines, wipe, cand, T, ENV, setNow: (x) => { NOW = x; } });
  console.log(`\nph93unit: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
