// Phase 95 Task 3.1: the PC research ledger (plan sections 6-9). SQLite via node's built-in `node:sqlite` (Node >= 22.5; experimental
// in Node 24, so the version is checked here and the warning is expected). It is separate from the trading ledger and holds NO trading
// state: research data and results only.
//   research.sqlite        sessions, files, runs, bars, news versions, snapshots, contract selections, quote gaps (+ later tasks'
//                          tables, each added by its own versioned migration)
//   quotes-YYYY-MM.sqlite  option quotes, one database per month (about 1 M rows a session at full scale: kept out of the main ledger)
// Migrations are numbered; before a pending migration touches an EXISTING file, a backup copy is written next to it. A file newer than
// this code is refused, never downgraded. Every upsert is idempotent and keyed by content.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sqlite() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) throw new Error(`the research ledger needs Node >= 22.5 (node:sqlite); this is ${process.version}`);
  return require('node:sqlite');
}

const MIGRATIONS = [{ v: 1, sql: `
  create table meta (key text primary key, value text);
  create table runs (id integer primary key autoincrement, started_at integer, ended_at integer, stage text, status text, detail text);
  create table sessions (day text primary key, status text, stage text, manifest_sha text, updated_at integer);
  create table files (name text primary key, sha256 text, size integer, kind text, day text, imported_at integer);
  create table bars_1m (symbol text, t integer, o real, h real, l real, c real, v real, feed text, primary key (symbol, t)) without rowid;
  create table news_versions (doc_id text, version text, t_recv integer, created_at text, updated_at text, headline text, symbols text, source text,
    seen_via text, catch_up integer, primary key (doc_id, version)) without rowid;
  create table snapshots (kind text, sha text, first_at integer, last_at integer, body text, primary key (kind, sha)) without rowid;
  create table candidates (recorded_at integer, underlying text, bucket text, side text, contract text, expiry text, strike real, delta real, dte integer,
    rule text, primary key (recorded_at, underlying, bucket, side)) without rowid;
  create table quote_gaps (source text, from_t integer, to_t integer, reason text, primary key (source, from_t)) without rowid;
` }, { v: 2, sql: `
  create table bars_days (symbol text, day text, rows integer, status text, error text, fetched_at integer, primary key (symbol, day)) without rowid;
` }, { v: 3, sql: `
  create table bars_1d (symbol text, day text, o real, h real, l real, c real, v real, primary key (symbol, day)) without rowid;
  create table observe_days (symbol text, day text, atr real, atr_sessions integer, status text, reason text, version text, primary key (symbol, day)) without rowid;
  create table moves (symbol text, day text, scale text, k integer, dir integer, type text, parent_k integer, start_t integer, start_px real, start_confirmed_at integer,
    end_t integer, end_px real, confirmed_at integer, open integer, size_pct real, size_atr real, duration_min integer, volume real, primary key (symbol, day, scale, k)) without rowid;
  create table quiet_periods (symbol text, day text, k integer, start_t integer, end_t integer, duration_min integer, range_atr real, primary key (symbol, day, k)) without rowid;
` }];
const QUOTE_MIGRATIONS = [{ v: 1, sql: `
  create table quotes (contract text, t_quote integer, t_recv integer, bid real, ask real, bid_size real, ask_size real, underlying real, iv real,
    delta real, feed text, pinned integer, primary key (contract, t_quote)) without rowid;
` }];

const schemaVersion = (db) => db.prepare('pragma user_version').get().user_version;

function open(file, { migrations = MIGRATIONS } = {}) {
  const existed = fs.existsSync(file) && fs.statSync(file).size > 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (sqlite().DatabaseSync)(file);
  db.exec('pragma journal_mode = wal; pragma synchronous = normal;');
  const have = schemaVersion(db); const want = migrations.length;
  if (have > want) { db.close(); throw new Error(`${path.basename(file)} is at schema v${have}, newer than this code (v${want}): update the code; never downgraded`); }
  if (have < want && existed) { db.exec('pragma wal_checkpoint(truncate)'); fs.copyFileSync(file, `${file}.bak-v${have}-${Date.now()}`); }
  for (const m of migrations.filter((x) => x.v > have)) {
    db.exec('begin'); try { db.exec(m.sql); db.exec(`pragma user_version = ${m.v}`); db.exec('commit'); } catch (err) { db.exec('rollback'); db.close(); throw err; }
  }
  return db;
}
const openQuotes = (dir, ym) => open(path.join(dir, `quotes-${ym}.sqlite`), { migrations: QUOTE_MIGRATIONS });

function tx(db, fn) { db.exec('begin'); try { const r = fn(); db.exec('commit'); return r; } catch (err) { db.exec('rollback'); throw err; } }

// Bars: (symbol, t) is the key; a re-fetched bar (a late correction) replaces the stored value.
function upsertBars(db, rows) {
  const st = db.prepare('insert into bars_1m (symbol, t, o, h, l, c, v, feed) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (symbol, t) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, feed = excluded.feed');
  return tx(db, () => { for (const b of rows) st.run(b.symbol, b.t, b.o, b.h, b.l, b.c, b.v, b.feed || null); return rows.length; });
}
// News: one row per (document, version); the EARLIEST receipt time across every copy wins (the VM poll, the stream, a re-import).
function upsertNews(db, rows) {
  const st = db.prepare(`insert into news_versions (doc_id, version, t_recv, created_at, updated_at, headline, symbols, source, seen_via, catch_up) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (doc_id, version) do update set t_recv = excluded.t_recv, seen_via = excluded.seen_via, catch_up = excluded.catch_up where excluded.t_recv < news_versions.t_recv`);
  return tx(db, () => { for (const n of rows) st.run(n.docId, n.version, n.t_recv, n.created_at || null, n.updated_at || null, n.headline || null, JSON.stringify(n.symbols || []), n.source || null, n.seenVia || null, n.catchUp ? 1 : 0); return rows.length; });
}
// Snapshots: keyed by a hash of their CONTENT; an identical later snapshot only extends last_at.
function upsertSnapshot(db, kind, at, body) {
  const text = JSON.stringify(body); const sha = crypto.createHash('sha256').update(text).digest('hex');
  db.prepare('insert into snapshots (kind, sha, first_at, last_at, body) values (?, ?, ?, ?, ?) on conflict (kind, sha) do update set first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)')
    .run(kind, sha, at, at, text);
  return sha;
}
// Contract selections (the collector's CANDIDATES lines): written once, never overwritten (the replay may only use what was recorded).
function upsertCandidates(db, rows) {
  const st = db.prepare('insert into candidates (recorded_at, underlying, bucket, side, contract, expiry, strike, delta, dte, rule) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing');
  return tx(db, () => { for (const c of rows) st.run(c.recordedAt, c.underlying, c.bucket, c.side, c.contract, c.expiry, c.strike, c.delta ?? null, c.dte ?? null, c.rule || null); return rows.length; });
}
function upsertQuotes(q, rows) {
  const st = q.prepare('insert into quotes (contract, t_quote, t_recv, bid, ask, bid_size, ask_size, underlying, iv, delta, feed, pinned) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing');
  return tx(q, () => { for (const r of rows) st.run(r.contract, r.tQuote, r.tRecv, r.bid, r.ask, r.bidSize ?? null, r.askSize ?? null, r.underlying ?? null, r.iv ?? null, r.delta ?? null, r.feed, r.pinned ? 1 : 0); return rows.length; });
}
const quotesBetween = (q, contract, from, to) => q.prepare('select * from quotes where contract = ? and t_quote >= ? and t_quote <= ? order by t_quote').all(contract, from, to);

module.exports = { open, openQuotes, schemaVersion, MIGRATIONS, QUOTE_MIGRATIONS, upsertBars, upsertNews, upsertSnapshot, upsertCandidates, upsertQuotes, quotesBetween };
