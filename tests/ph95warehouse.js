// Phase 95 M3 (PC research warehouse). Task 3.1: the research ledger (node:sqlite): versioned migrations with a backup before each
// migration of an existing file; content-keyed idempotent upserts; monthly quote databases; the import guard for tools/research/**.
// Scratch dirs only. Run: node tests/ph95warehouse.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.join(__dirname, '..');
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

function reach(entries) {
  const seen = new Set(); const todo = [...entries];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let p = path.resolve(path.dirname(f), m[1]); if (!p.endsWith('.js')) p += fs.existsSync(`${p}.js`) ? '.js' : '/index.js';
      if (fs.existsSync(p)) todo.push(p);
    }
  }
  return [...seen].map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const FORBIDDEN = /^server\/(execution|risk|strategies|security)\/|^server\/connectors\/(?!net-guard\.js$)|^server\/server\.js$|^server\/market\/market-session\.js$/;

const W = require(path.join(ROOT, 'tools', 'research', 'db'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph95w-'));
const file = path.join(dir, 'research.sqlite');

// --- migrations ---
let db = W.open(file);
check('open: creates the ledger at the current schema version', W.schemaVersion(db) === W.MIGRATIONS.length && fs.existsSync(file));
const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
check('schema v1: sessions, files, runs, bars_1m, news_versions, snapshots, candidates, quote_gaps, meta', ['sessions', 'files', 'runs', 'bars_1m', 'news_versions', 'snapshots', 'candidates', 'quote_gaps', 'meta'].every((t) => tables.includes(t)), tables.join());
db.close();
const extra = [...W.MIGRATIONS, { v: W.MIGRATIONS.length + 1, sql: 'create table test_added (x integer)' }];
db = W.open(file, { migrations: extra });
const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak-v'));
check('a pending migration on an existing ledger: a backup copy is written FIRST, then the migration applies', baks.length === 1 && W.schemaVersion(db) === extra.length
  && db.prepare("select count(*) c from sqlite_master where name='test_added'").get().c === 1, baks.join());
db.close();
db = W.open(file, { migrations: extra });
check('re-opening at the current version: no new backup, no change', fs.readdirSync(dir).filter((f) => f.includes('.bak-v')).length === 1);
db.close();
let refused = null; try { W.open(file); } catch (e) { refused = e.message; }
check('opening a ledger NEWER than this code is refused with a clear message (never downgraded)', /newer/i.test(refused || ''), refused);
fs.rmSync(file); fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));

// --- idempotent, content-keyed upserts ---
db = W.open(file);
const bars = [{ symbol: 'AMZN', t: 1791333000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100, feed: 'sip' }, { symbol: 'AMZN', t: 1791333060000, o: 1.5, h: 2, l: 1, c: 1.8, v: 50, feed: 'sip' }];
W.upsertBars(db, bars); W.upsertBars(db, bars);
check('bars: re-ingesting the same bars changes nothing (primary key symbol + t)', db.prepare('select count(*) c from bars_1m').get().c === 2);
W.upsertBars(db, [{ ...bars[0], c: 9 }]);
check('bars: a corrected bar for the same minute replaces the value (latest fetch wins), still one row', db.prepare('select c from bars_1m where t = ?').get(bars[0].t).c === 9
  && db.prepare('select count(*) c from bars_1m').get().c === 2);
const nv = { docId: 'alpaca:1', version: '2026-10-07T13:00:00Z', t_recv: 2000, headline: 'h', symbols: ['AMZN'], source: 'benzinga', seenVia: 'poll' };
W.upsertNews(db, [nv, { ...nv, t_recv: 1500, seenVia: 'stream' }, { ...nv, t_recv: 2500 }]);
const n1 = db.prepare('select * from news_versions').all();
check('news: one row per (document, version); the EARLIEST receipt time is kept, with how it was seen', n1.length === 1 && n1[0].t_recv === 1500 && n1[0].seen_via === 'stream', JSON.stringify(n1));
W.upsertSnapshot(db, 'EARNINGS_SNAPSHOT', 10, { rows: [1, 2] }); W.upsertSnapshot(db, 'EARNINGS_SNAPSHOT', 20, { rows: [1, 2] }); W.upsertSnapshot(db, 'EARNINGS_SNAPSHOT', 30, { rows: [1, 3] });
const sn = db.prepare('select kind, first_at, last_at from snapshots order by first_at').all();
check('snapshots: keyed by content hash: an identical snapshot only extends last_at; a changed one is a new row', sn.length === 2 && sn[0].first_at === 10 && sn[0].last_at === 20 && sn[1].first_at === 30, JSON.stringify(sn));
const cand = { recordedAt: 1000, underlying: 'AMZN', bucket: 'Q', side: 'call', contract: 'AMZN261009C00225000', expiry: '2026-10-09', strike: 225, delta: 0.51, dte: 2, rule: 'delta' };
W.upsertCandidates(db, [cand, cand]);
check('candidates: one row per (recorded time, underlying, bucket, side): a selection is never overwritten by a re-import', db.prepare('select count(*) c from candidates').get().c === 1);
db.close();

// --- monthly quote databases ---
const q = W.openQuotes(dir, '2026-10');
const rows = [{ contract: 'AMZN261009C00225000', tQuote: 1000, tRecv: 1100, bid: 1.2, ask: 1.3, bidSize: 10, askSize: 12, underlying: 224.5, iv: 0.3, delta: 0.5, feed: 'indicative', pinned: 1 },
  { contract: 'AMZN261009C00225000', tQuote: 2000, tRecv: 2050, bid: 1.25, ask: 1.35, bidSize: 10, askSize: 12, underlying: 224.7, iv: 0.3, delta: 0.52, feed: 'indicative', pinned: 1 }];
W.upsertQuotes(q, rows); W.upsertQuotes(q, rows);
const got = W.quotesBetween(q, 'AMZN261009C00225000', 0, 5000);
check('quotes: a separate monthly database; idempotent; read back in provider-time order for one contract', fs.existsSync(path.join(dir, 'quotes-2026-10.sqlite')) && got.length === 2 && got[0].t_quote === 1000 && got[1].bid === 1.25);
q.close();

// --- import guard for tools/research/** ---
const entries = walk(path.join(ROOT, 'tools', 'research'));
const graph = reach(entries); const bad = graph.filter((f) => FORBIDDEN.test(f));
check('import guard: nothing reachable from tools/research/** is trading code, a broker connector, the server or market-session', bad.length === 0, bad.join(', '));
const srcs = graph.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
check('import guard: no broker key name or trading base URL in tools/research/**', !/KRAKEN_|OKX_|COINBASE_|ALPACA_TRADING_BASE_URL|paper-api\.alpaca/.test(srcs));

console.log(`\nph95warehouse: ${fails ? `${fails} FAIL` : 'all passed'}`);
process.exitCode = fails ? 1 : 0;
