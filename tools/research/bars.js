// Phase 95 Task 3.2: consolidated (SIP) 1-minute stock bars into the research ledger, on the PC after the close (plan section 3, step 2).
// The free plan serves SIP history older than 15 minutes, so a session is fetched only once it ended at least 15 minutes ago. One
// symbol per request (a multi-symbol 1-minute request pages badly: Phase 87), every page followed, <= 60 requests a minute through the
// shared limiter (the VM collector and the trading server use the same account), 429 -> stand back and retry. Each (symbol, day) gets
// a status row with its count; a symbol-day already ok is not fetched again. Keys travel in headers only.
const cal = require('../../server/research/nyse-calendar');
const et = require('../../server/services/et-time');
const W = require('./db');

const READY_AFTER_MS = 15 * 60 * 1000;
const MAX_TRIES = 4;

async function fetchSymbolDay({ symbol, day, fetchImpl, limiter, keys, base }) {
  const start = et.toEpoch(day, 9, 30); const end = et.toEpoch(day, Math.floor(cal.closeMinOf(day) / 60), cal.closeMinOf(day) % 60) - 1;
  const rows = []; let token = null;
  do {
    const q = new URLSearchParams({ timeframe: '1Min', feed: 'sip', adjustment: 'raw', limit: '10000', start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    if (token) q.set('page_token', token);
    let res = null;
    for (let tries = 0; tries < MAX_TRIES; tries += 1) {
      await limiter.acquire();
      res = await fetchImpl(`${base}/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`, { headers: { 'APCA-API-KEY-ID': keys.key, 'APCA-API-SECRET-KEY': keys.secret, 'User-Agent': 'SignalDesk-research/1.0' }, signal: AbortSignal.timeout(30000) });
      limiter.report(res.status);
      if (res.status !== 429) break;
    }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`HTTP ${res.status}${j && j.message ? `: ${String(j.message).slice(0, 120)}` : ''}`); }
    const body = await res.json();
    for (const b of body.bars || []) rows.push({ symbol, t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, feed: 'sip' });
    token = body.next_page_token || null;
  } while (token);
  return rows;
}

// -> { fetched, skipped, notReady, holidays, errors, rows }
async function fetchDays(db, { symbols, days, now = Date.now(), fetchImpl = fetch, limiter, keys, base = 'https://data.alpaca.markets', refetch = false }) {
  const out = { fetched: 0, skipped: 0, notReady: 0, holidays: 0, errors: 0, rows: 0 };
  const done = db.prepare("select status from bars_days where symbol = ? and day = ?");
  const mark = db.prepare('insert into bars_days (symbol, day, rows, status, error, fetched_at) values (?, ?, ?, ?, ?, ?) on conflict (symbol, day) do update set rows = excluded.rows, status = excluded.status, error = excluded.error, fetched_at = excluded.fetched_at');
  for (const day of days) {
    if (!cal.isSessionDay(day)) { out.holidays += 1; continue; }
    const closeAt = et.toEpoch(day, Math.floor(cal.closeMinOf(day) / 60), cal.closeMinOf(day) % 60);
    if (now < closeAt + READY_AFTER_MS) { out.notReady += symbols.length; continue; }
    for (const symbol of symbols) {
      const prev = done.get(symbol, day);
      if (!refetch && prev && prev.status === 'ok') { out.skipped += 1; continue; }
      try {
        const rows = await fetchSymbolDay({ symbol, day, fetchImpl, limiter, keys, base });
        W.upsertBars(db, rows); mark.run(symbol, day, rows.length, 'ok', null, now);
        out.fetched += 1; out.rows += rows.length;
      } catch (err) { mark.run(symbol, day, 0, 'error', String(err.message).slice(0, 200), now); out.errors += 1; }
    }
  }
  return out;
}

// Daily bars (for ATR30 from PRIOR sessions, spec 8.1): one request per symbol over [from, to], stored by New York date.
async function fetchDaily(db, { symbols, from, to, fetchImpl = fetch, limiter, keys, base = 'https://data.alpaca.markets' }) {
  const st = db.prepare('insert into bars_1d (symbol, day, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?) on conflict (symbol, day) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v');
  const out = { symbols: 0, rows: 0, errors: 0 };
  for (const symbol of symbols) {
    try {
      let token = null; const rows = [];
      do {
        const q = new URLSearchParams({ timeframe: '1Day', feed: 'sip', adjustment: 'raw', limit: '10000', start: `${from}T00:00:00Z`, end: `${to}T23:59:59Z` });
        if (token) q.set('page_token', token);
        let res = null;
        for (let tries = 0; tries < MAX_TRIES; tries += 1) {
          await limiter.acquire();
          res = await fetchImpl(`${base}/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`, { headers: { 'APCA-API-KEY-ID': keys.key, 'APCA-API-SECRET-KEY': keys.secret, 'User-Agent': 'SignalDesk-research/1.0' }, signal: AbortSignal.timeout(30000) });
          limiter.report(res.status); if (res.status !== 429) break;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        for (const b of body.bars || []) rows.push([symbol, et.ymd(Date.parse(b.t)), b.o, b.h, b.l, b.c, b.v]);
        token = body.next_page_token || null;
      } while (token);
      db.exec('begin'); try { for (const r of rows) st.run(...r); db.exec('commit'); } catch (e) { db.exec('rollback'); throw e; }
      out.symbols += 1; out.rows += rows.length;
    } catch { out.errors += 1; }
  }
  return out;
}

module.exports = { fetchDays, fetchSymbolDay, fetchDaily, READY_AFTER_MS };

// CLI: node tools/research/bars.js [--sessions 20] [--symbols universe|pilot] [--db research-data/research.sqlite]
// Reads ONLY the Alpaca data keys from .env (headers only, never printed). Fetches the last N completed NYSE sessions.
if (require.main === module) {
  (async () => {
    const fs = require('fs'); const path = require('path');
    const a = process.argv.slice(2); const arg = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
    const ROOT = path.join(__dirname, '..', '..');
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^(ALPACA_API_KEY|ALPACA_API_SECRET|ALPACA_PAPER_API_KEY|ALPACA_PAPER_API_SECRET)=(.*)$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    const keys = require('../../server/research/data-keys').dataKeys(); if (!keys) { console.log('no Alpaca data keys'); process.exit(2); }
    const u = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'universe', 'universe-v1.json'), 'utf8'));
    const symbols = arg('--symbols', 'universe') === 'pilot' ? u.pilot.symbols : [...u.symbols.map((s) => s.symbol), ...u.benchmarks];
    const n = Number(arg('--sessions', 20)); const days = [];
    const ended = (d) => Date.now() >= et.toEpoch(d, Math.floor(cal.closeMinOf(d) / 60), cal.closeMinOf(d) % 60) + READY_AFTER_MS;
    for (let t = Date.now(); days.length < n; t -= 864e5) { const d = et.ymd(t); if (cal.isSessionDay(d) && ended(d) && !days.includes(d)) days.push(d); }
    const db = W.open(path.join(ROOT, arg('--db', 'research-data/research.sqlite')));
    const limiter = require('../../server/research/collector/budget').createLimiter({ perMin: 60 });
    const t0 = Date.now(); const r = await fetchDays(db, { symbols, days: days.reverse(), limiter, keys });
    console.log(`bars: ${symbols.length} symbols x ${days.length} sessions (${days[0]} .. ${days[days.length - 1]}): ${JSON.stringify(r)} in ${Math.round((Date.now() - t0) / 1000)} s`);
    db.close();
  })().catch((e) => { console.error(String(e.message).slice(0, 200)); process.exitCode = 1; });
}
