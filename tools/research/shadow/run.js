// Phase 95 Task 5.5: the shadow-paper engine run. Recomputed in full on every run (idempotent): every opportunity of every session
// with recorded option selections, every exits@1 rule, every book. Multi-day holds complete as later sessions arrive (OPEN until then).
// Mode: LIVE_PAPER for sessions on or after FROZEN_ON (triggers@1-lite + exits@1 frozen before any outcome was computed), REPLAY before.
// Nothing here can trade: no broker module is reachable from tools/research (tests/ph95shadow.js import guard).
const fs = require('fs');
const path = require('path');
const W = require('../db');
const et = require('../../../server/services/et-time');
const cal = require('../../../server/research/nyse-calendar');
const O = require('./opportunities');
const F = require('./fills');
const X = require('./exits');
const B = require('./books');

const FROZEN_ON = '2026-10-12';
const openDb = (file) => W.open(file);

function jsonl(file, pred) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && pred(l)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

// -> { days, opportunities, outcomes, books } (also written to the ledger)
function run(db, { quotesDir, dataDir, symbols, through, now = Date.now() }) {
  const cands = db.prepare('select * from candidates where recorded_at <= ? order by recorded_at').all(et.toEpoch(through, 23, 59));
  const days = [...new Set(cands.map((c) => et.ymd(c.recorded_at)))].filter((d) => d <= through && cal.isSessionDay(d)).sort();
  const candsBy = new Map(); for (const c of cands) { if (!candsBy.has(c.underlying)) candsBy.set(c.underlying, []); candsBy.get(c.underlying).push(c); }
  const barsOf = db.prepare('select t, o, h, l, c, v from bars_1m where symbol = ? and t >= ? and t < ? order by t');
  const prevCloseOf = db.prepare('select c from bars_1d where symbol = ? and day < ? order by day desc limit 1');
  const dailyOf = db.prepare('select day, h, l, c from bars_1d where symbol = ? and day < ? order by day'); const { atr30 } = require('../observe');
  let opps = [];
  for (const day of days) {
    const open = et.toEpoch(day, 9, 30); const cm = cal.closeMinOf(day); const close = et.toEpoch(day, Math.floor(cm / 60), cm % 60);
    for (const s of symbols) {
      const pc = prevCloseOf.get(s, day);
      opps.push(...O.triggers(s, day, barsOf.all(s, open, close), pc ? pc.c : null, atr30(dailyOf.all(s, day), day).atr), ...O.controls(s, day));
    }
    opps.push(...O.news(symbols, day, jsonl(path.join(dataDir, `events-${day}.jsonl`), (l) => l.includes('"kind":"NEWS"')).map((n) => ({ t_recv: n.t_recv, symbols: n.symbols })), cm));
    opps.push(...O.app(symbols, jsonl(path.join(dataDir, `decisions-${day}.jsonl`), (l) => l.includes('"type":"decision"'))).filter((o) => o.tAvail >= open && o.tAvail < close));
  }
  opps = O.dedupe(opps);
  // quotes per contract across the monthly databases
  const months = fs.existsSync(quotesDir) ? fs.readdirSync(quotesDir).filter((n) => /^quotes-\d{4}-\d{2}\.sqlite$/.test(n)).sort() : [];
  const qdbs = months.map((n) => W.openQuotes(quotesDir, n.slice(7, 14)));
  const cache = new Map(); let dataThrough = 0;
  for (const q of qdbs) { const m = q.prepare('select max(t_quote) m from quotes').get().m; if (m > dataThrough) dataThrough = m; }
  dataThrough = Math.min(now, Math.max(dataThrough, X.closeAt(through)));
  const quotesOf = (c) => {
    if (!cache.has(c)) cache.set(c, qdbs.flatMap((q) => q.prepare('select t_quote, bid, ask, feed from quotes where contract = ? order by t_quote').all(c)).sort((a, b) => a.t_quote - b.t_quote));
    return cache.get(c);
  };
  const defaultLabel = String(process.env.RESEARCH_OPTIONS_FEED || '').toLowerCase() === 'opra' ? 'MARKET_QUOTE' : 'INDICATIVE_ESTIMATE';
  const outcomes = [];
  try {
    for (const o of opps) for (const rule of B.RULES) {
      const side = o.dir === 'UP' ? 'call' : 'put';
      const base = { opp: o, rule: rule.id, label: defaultLabel, mode: o.day >= FROZEN_ON ? 'LIVE_PAPER' : 'REPLAY' };
      const sel = F.selectContract(candsBy.get(o.symbol) || [], { underlying: o.symbol, bucket: rule.bucket, side, tAvail: o.tAvail });
      if (!sel.contract) { outcomes.push({ ...base, status: 'NO_SELECTION' }); continue; }
      base.selection = sel;
      if (rule.family === 'D' || rule.family === 'W') {
        const ok = F.expiryOk({ expiry: sel.expiry, plannedExitDay: X.sessionAfter(o.day, rule.sessions) });
        if (!ok.ok) { outcomes.push({ ...base, status: 'INSUFFICIENT_EXPIRY', expiryCheck: ok }); continue; }
      }
      const qs = quotesOf(sel.contract);
      const entry = F.entryFill(qs, { tAvail: o.tAvail, latencyMs: 5000, maxWaitMs: rule.waitMs, dataThrough });
      if (entry.status !== 'FILLED') { outcomes.push({ ...base, status: entry.status }); continue; }
      const exit = X.runExit(qs, { t: entry.quote.t_quote, price: entry.price, fees: B.LIMITS.fees, day: o.day, expiry: sel.expiry }, { ...rule, latencyMs: 5000, dataThrough });
      const lbl = entry.feed === 'opra' ? 'MARKET_QUOTE' : entry.feed && entry.feed.includes('_') ? entry.feed : defaultLabel;
      outcomes.push({ ...base, label: lbl, status: 'FILLED', entry, exit, stressNet: exit.status === 'CLOSED' ? X.stressNet({ entryQuote: entry.quote, exitQuote: exit.fill, fees: B.LIMITS.fees }) : null });
    }
  } finally { for (const q of qdbs) q.close(); }
  // books: family x rule x label (PENDING entries wait for more data and are not booked yet)
  const groups = new Map();
  for (const oc of outcomes) {
    if (oc.status === 'PENDING') continue;
    const id = `${B.familyOf(oc.opp)}|${oc.rule}|${oc.label}`;
    if (!groups.has(id)) groups.set(id, []); groups.get(id).push(oc);
  }
  const books = [];
  for (const [id, list] of groups) { const [family, ruleId, label] = id.split('|'); const r = B.runBook(list, B.RULES.find((x) => x.id === ruleId)); books.push({ id, family, rule: ruleId, label, ...r }); }
  persist(db, outcomes, books);
  return { days, opportunities: opps, outcomes, books, dataThrough };
}

function persist(db, outcomes, books) {
  const insO = db.prepare(`insert into shadow_outcomes (key, rule, symbol, day, source, trig, dir, t_avail, status, reason, contract, selected_at, entry_t, entry_price,
    exit_t, exit_bid, net, stress_net, labels, label, mode, detail) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insE = db.prepare('insert into shadow_book_entries (book, key, status, reason, state) values (?, ?, ?, ?, ?)');
  const insB = db.prepare('insert into shadow_books (book, family, rule, label, summary) values (?, ?, ?, ?, ?)');
  db.exec('begin');
  try {
    db.exec('delete from shadow_outcomes; delete from shadow_book_entries; delete from shadow_books;');
    for (const oc of outcomes) {
      const o = oc.opp; const ex = oc.exit || {};
      insO.run(o.key, oc.rule, o.symbol, o.day, o.source, o.trigger, o.dir, o.tAvail, ex.status || oc.status, ex.reason || ex.pendingReason || null,
        oc.selection ? oc.selection.contract : null, oc.selection ? oc.selection.selectedAt : null, oc.entry ? oc.entry.quote.t_quote : null, oc.entry ? oc.entry.price : null,
        ex.fill ? ex.fill.t_quote : null, ex.fill ? ex.fill.bid : null, ex.net ?? null, oc.stressNet ?? null, JSON.stringify(ex.labels || []), oc.label, oc.mode,
        JSON.stringify({ selection: oc.selection || null, latencyMs: oc.entry ? oc.entry.latencyMs : null, gapMs: ex.gapMs ?? null, slippage: ex.slippage ?? null,
          lossBeyondStop: ex.lossBeyondStop ?? null, mfe: Number.isFinite(ex.mfe) ? ex.mfe : null, mae: Number.isFinite(ex.mae) ? ex.mae : null, mark: ex.mark ?? null, expiryCheck: oc.expiryCheck || null }));
    }
    for (const b of books) {
      for (const e of b.entries) insE.run(b.id, e.key, e.status, e.reason, JSON.stringify(e.state));
      insB.run(b.id, b.family, b.rule, b.label, JSON.stringify(b.summary));
    }
    db.exec('commit');
  } catch (err) { db.exec('rollback'); throw err; }
}

module.exports = { run, openDb, FROZEN_ON };
