// Phase 94 Stage 0 (server side): S0-1 immutable decision evidence + content-keyed series. Run: node tests/ph94unit.js
// Scratch decisions folder in the OS temp dir, dead URLs, no network.
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), DECISIONS_DIR: path.join(DIR, 'decisions'), EVENTS_DIR: path.join(DIR, 'events'), MACRO_CALENDAR_URL: DEAD,
  ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_DATA_BASE_URL: DEAD, FINNHUB_API_KEY: '', FINNHUB_BASE_URL: DEAD, OPENAI_API_KEY: '', GEMINI_API_KEY: '' });
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
console.warn = ((w) => (...a) => { if (!/^\[decision-recorder\]/.test(String(a[0]))) w(...a); })(console.warn);
const bars = (n, t0 = 1790000000, step = 60) => Array.from({ length: n }, (_, i) => ({ time: t0 + i * step, open: 100 + i * 0.01, high: 100.2 + i * 0.01, low: 99.8 + i * 0.01, close: 100.1 + i * 0.01, volume: 1000 + i }));
const readLines = () => { const d = process.env.DECISIONS_DIR; if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))); };

(async () => {
  const dc = require(S + 'research/decision-context');
  const ser = require(S + 'research/decision-serialize');
  const rec = require(S + 'research/decision-recorder');
  rec._test.reset(); rec._test.setClock(() => Date.parse('2026-10-06T14:00:00Z'));

  // ---------- S0-1: the evidence is detached and frozen at capture ----------
  const live = bars(5); const before = live[4].close;
  dc.capture('imm:1', { strategyId: 'equity-day', symbol: 'AAPL', series: [{ name: 'session1m', tf: '1m', bars: live }] });
  live[4].close = 999; live[4].high = 999; live.push({ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  const got = dc.get('imm:1').series[0].bars;
  check('S0-1: a bar the stream updates AFTER capture leaves the captured evidence unchanged', got.length === 5 && got[4].close === before && got[4].high !== 999);
  check('S0-1: captured bars and the series array are frozen', Object.isFrozen(got) && Object.isFrozen(got[4]));
  const raw = [{ ymd: '2026-10-05', closes5m: [1, 2, 3] }];
  dc.capture('imm:2', { strategyId: 'options-quickflips', symbol: 'SPY', series: [{ name: 'prior5m', tf: '5m', bars: raw }] });
  raw[0].closes5m[0] = 99;
  check('S0-1: non-bar series (Quick Flips prior sessions) are deep-copied', dc.get('imm:2').series[0].bars[0].closes5m[0] === 1);
  const slots = [null, ...bars(2)];
  dc.capture('imm:3', { strategyId: 'options-quickflips', symbol: 'SPY', series: [{ name: 'todaySlots1m', tf: '1m', bars: slots }] });
  check('S0-1: null minute slots are kept as null', dc.get('imm:3').series[0].bars[0] === null && dc.get('imm:3').series[0].bars.length === 3);

  // ---------- S0-1: series are keyed by their COMPLETE stored contents ----------
  const a = bars(10); const b = bars(10); b[5] = { ...b[5], close: b[5].close + 1 }; // same count, same first / last bar, a different middle bar
  const la = ser.seriesLine({ name: 'session1m', symbol: 'AAPL', tf: '1m', bars: a });
  const lb = ser.seriesLine({ name: 'session1m', symbol: 'AAPL', tf: '1m', bars: b });
  check('S0-1: same endpoints, different contents -> different keys (b2: + sha256 of the stored body)', la.key !== lb.key && /^b2:AAPL\|1m\|session1m\|[0-9a-f]{32}$/.test(la.key), `${la.key} ${lb.key}`);
  check('S0-1: identical contents -> the same key', ser.seriesLine({ name: 'session1m', symbol: 'AAPL', tf: '1m', bars: bars(10) }).key === la.key);
  check('S0-1: raw series keyed by contents too (r2:)', /^r2:/.test(ser.seriesLine({ name: 'prior5m', symbol: 'SPY', tf: '5m', bars: raw }).key));
  dc.capture('k:A', { strategyId: 'equity-day', symbol: 'AAPL', series: [{ name: 'session1m', tf: '1m', bars: a }] });
  dc.capture('k:B', { strategyId: 'equity-day', symbol: 'AAPL', series: [{ name: 'session1m', tf: '1m', bars: b }] });
  rec.record('PIPELINE_REJECT', 'k:A', { reason: 'x', candidate: { asset: 'AAPL', strategyId: 'equity-day' } });
  rec.record('PIPELINE_REJECT', 'k:B', { reason: 'x', candidate: { asset: 'AAPL', strategyId: 'equity-day' } });
  await rec.flush();
  const L = readLines(); const ref = (id) => L.find((x) => x.type === 'decision' && x.id === id).context.series[0].key;
  const rowsOf = (k) => L.find((x) => x.type === 'series' && x.key === k).rows;
  check('S0-1: each decision references ITS OWN stored series (no endpoint collision)', ref('k:A') !== ref('k:B') && rowsOf(ref('k:B'))[5][4] === b[5].close && rowsOf(ref('k:A'))[5][4] === a[5].close);

  console.log(`\nph94unit: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
