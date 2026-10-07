// Phase 95 Task 3.2: SIP 1-minute bars for the research ledger (PC). A fake data API; a fake clock for the limiter (no waiting).
// Run: node tests/ph95bars.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.join(__dirname, '..');
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const W = require(path.join(ROOT, 'tools', 'research', 'db'));
const B = require(path.join(ROOT, 'tools', 'research', 'bars'));
const et = require(path.join(ROOT, 'server', 'services', 'et-time'));
const { createLimiter } = require(path.join(ROOT, 'server', 'research', 'collector', 'budget'));

(async () => {
  const db = W.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph95b-')), 'research.sqlite'));
  const calls = []; let fail429 = 0; const failSym = new Set(['BAD']);
  const fakeFetch = async (url, opts) => {
    const u = new URL(url); calls.push({ u, h: opts.headers });
    const sym = u.pathname.split('/')[3];
    if (fail429 > 0) { fail429 -= 1; return { ok: false, status: 429, json: async () => ({}) }; }
    if (failSym.has(sym)) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
    const start = Date.parse(u.searchParams.get('start')); const tok = u.searchParams.get('page_token');
    const mk = (i) => ({ t: new Date(start + i * 60000).toISOString(), o: 1, h: 2, l: 0.5, c: 1 + i / 1000, v: 10 });
    if (!tok) return { ok: true, status: 200, json: async () => ({ bars: [mk(0), mk(1)], next_page_token: 'p2' }) };
    return { ok: true, status: 200, json: async () => ({ bars: [mk(2)], next_page_token: null }) };
  };
  let t = Date.parse('2026-10-09T00:00:00Z'); // Friday 20:00 ET of 2026-10-08
  const limiter = createLimiter({ perMin: 60, now: () => t, sleep: async (ms) => { t += ms; } });
  const keys = { key: 'PKTEST', secret: 'sek' };
  let r = await B.fetchDays(db, { symbols: ['AMZN', 'BAD'], days: ['2026-10-08'], now: t, fetchImpl: fakeFetch, limiter, keys, base: 'http://data.test' });
  const first = calls[0].u;
  check('request: /v2/stocks/<sym>/bars, 1Min, feed=sip, raw adjustment, limit 10000, the regular session in ET (09:30-16:00)', first.pathname === '/v2/stocks/AMZN/bars'
    && first.searchParams.get('timeframe') === '1Min' && first.searchParams.get('feed') === 'sip' && first.searchParams.get('adjustment') === 'raw' && first.searchParams.get('limit') === '10000'
    && Date.parse(first.searchParams.get('start')) === et.toEpoch('2026-10-08', 9, 30) && Date.parse(first.searchParams.get('end')) === et.toEpoch('2026-10-08', 16, 0) - 1, first.search);
  check('request: keys in headers only, never in the URL', calls[0].h['APCA-API-KEY-ID'] === 'PKTEST' && !/PKTEST|sek/.test(String(first)));
  const rows = db.prepare("select count(*) c from bars_1m where symbol = 'AMZN'").get().c;
  check('pagination: both pages stored (3 bars)', rows === 3, rows);
  const st = db.prepare('select * from bars_days order by symbol').all();
  check('per symbol-day status with row counts: AMZN ok 3; BAD error, recorded, and the run continued', st.length === 2 && st[0].symbol === 'AMZN' && st[0].status === 'ok' && st[0].rows === 3
    && st[1].symbol === 'BAD' && st[1].status === 'error' && /500/.test(st[1].error), JSON.stringify(st));
  const n = calls.length;
  r = await B.fetchDays(db, { symbols: ['AMZN'], days: ['2026-10-08'], now: t, fetchImpl: fakeFetch, limiter, keys, base: 'http://data.test' });
  check('idempotent: a symbol-day already ok is not fetched again', calls.length === n && r.skipped === 1, JSON.stringify(r));
  r = await B.fetchDays(db, { symbols: ['AMZN'], days: ['2026-10-09'], now: et.toEpoch('2026-10-09', 16, 10), fetchImpl: fakeFetch, limiter, keys, base: 'http://data.test' });
  check('a session that ended less than 15 min ago is NOT_READY (SIP history only after 15 min)', r.notReady === 1 && calls.length === n, JSON.stringify(r));
  r = await B.fetchDays(db, { symbols: ['AMZN'], days: ['2026-11-26'], now: Date.parse('2026-12-01T00:00:00Z'), fetchImpl: fakeFetch, limiter, keys, base: 'http://data.test' });
  check('an NYSE holiday (Thanksgiving) is not a session: skipped without a request', r.holidays === 1 && calls.length === n);
  calls.length = 0;
  await B.fetchDays(db, { symbols: ['MSFT'], days: ['2026-11-27'], now: Date.parse('2026-12-01T00:00:00Z'), fetchImpl: fakeFetch, limiter, keys, base: 'http://data.test' });
  check('an early close (2026-11-27) ends the request at 13:00 ET', Date.parse(calls[0].u.searchParams.get('end')) === et.toEpoch('2026-11-27', 13, 0) - 1);
  fail429 = 1; calls.length = 0; const t0 = t;
  await B.fetchDays(db, { symbols: ['NVDA'], days: ['2026-10-08'], now: t, fetchImpl: fakeFetch, limiter, keys, base: 'http://data.test' });
  check('a 429 stands back (the limiter pause) and retries the same request', t - t0 >= 120000 && db.prepare("select status from bars_days where symbol = 'NVDA'").get().status === 'ok', `${t - t0} ms`);
  check('rate: the PC fetch is held to its ceiling (60 / min)', limiter.stats().perMin === 60);
  db.close();
  console.log(`\nph95bars: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
