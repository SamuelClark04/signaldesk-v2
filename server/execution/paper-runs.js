// Paper trading runs (Phase 88): "Archive & Start New Paper Run". A run = the PAPER book from its start to its reset; resetting
// archives it whole (every closed paper trade, untouched) and starts the next run at the paper bankrolls.
//   Storage: paper-runs.json NEXT TO the ledger file (PAPER_RUNS_PATH overrides; a scratch ledger keeps its runs beside it), not inside
//     ledger-state.json: the ledger is rewritten on every fill / close / setting, and archived journals only grow.
//     { version, current: { runId, number, startedAt, initialBankroll, initialCryptoBankroll }, archived: [run] }
//   resetRun():
//     refused while a paper position is held / working at ALPACA PAPER (real broker orders: removing them from the ledger would
//       orphan them; [Close] them first) or while an internal one has no price to close at
//     internal paper positions are closed at their mark as RUN_RESET (the normal closePosition math), part of the archived run
//     the archive is written FIRST (atomic), then the paper book is cleared (ledger-extras.resetPaper: paper journal, positions,
//       staged / discarded setups, Pilot proposals; LIVE / adopted / external records and their journal stay; a backup file is
//       saved), then the paper daily kill switch is released (risk/daily-loss resetBook). Paper cash is derived (paper-pools:
//       bankroll + realized - open cost), so it is back at the bankroll. Synchronous from the first close to the reset: no trade
//       can be booked in between. A crash between the archive and the reset leaves the trades in both (never lost).
const fs = require('fs');
const path = require('path');
const { isPaper, poolOf } = require('./paper-pools');

const VERSION = 1;
const liveSetup = (o) => o.execution === 'LIVE' || (!!o.sizingBasis && o.sizingBasis !== 'paper' && o.execution !== 'PAPER');
const NAME_MAX = 60;
const file = () => process.env.PAPER_RUNS_PATH
  || path.join(path.dirname(process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', 'data', 'ledger-state.json')), 'paper-runs.json');
const empty = () => ({ version: VERSION, current: null, archived: [] });
const clone = (x) => JSON.parse(JSON.stringify(x));
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
const day = (ms) => dateFmt.format(new Date(ms));
function range(a, b) { const x = day(a); const y = day(b); return x === y ? y : x.slice(-4) === y.slice(-4) ? `${x.slice(0, -6)} – ${y}` : `${x} – ${y}`; }

let data = null;
function load() {
  if (data) return data;
  data = empty();
  const f = file();
  if (!fs.existsSync(f)) return data;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!d || !Array.isArray(d.archived)) throw new Error('"archived" is missing');
    data = { version: VERSION, current: d.current || null, archived: d.archived };
  } catch (err) { // never silently overwritten: moved aside, like the ledger
    const aside = `${f}.corrupt-${Date.now()}`;
    try { fs.renameSync(f, aside); } catch { /* leave it */ }
    console.error(`[runs] could not read ${f} (${err.message}); moved to ${aside}`);
  }
  return data;
}
function save() {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
  fs.renameSync(`${f}.tmp`, f);
}

// The run in progress (derived when none was recorded: number = archived + 1, started at its first paper trade).
function current(ledger) {
  const d = load();
  if (d.current) return { ...d.current };
  const s = ledger.getSettings();
  const times = [...ledger.getTradeJournal(), ...ledger.getActivePositions()].filter(isPaper).map((x) => x.openedAt || x.closedAt).filter((t) => t > 0);
  const number = d.archived.length + 1;
  return { runId: `run-${number}`, number, startedAt: times.length ? Math.min(...times) : Date.now(), initialBankroll: s.bankroll, initialCryptoBankroll: s.cryptoBankroll };
}

// Summary of a run's closed paper trades (the Journal scorecard's own math: lib/scorecard.js).
function summarize(journal) {
  const sc = require('../../client/lib/scorecard').build(journal);
  const byExit = {};
  for (const t of journal) { const k = String(t.exitReason || '?').replace(/ @ .*/, ''); const e = byExit[k] || (byExit[k] = { n: 0, net: 0 }); e.n += 1; e.net += t.netPnl || 0; }
  const byPool = { stocks: 0, crypto: 0 };
  for (const t of journal) byPool[poolOf(t.market)] += t.netPnl || 0;
  const pick = (r) => ({ strategy: r.strategy, label: r.label, trades: r.trades, wins: r.wins, winRate: r.winRate, avgR: r.avgR, profitFactor: r.profitFactor, net: r.net });
  return { finalNetPnl: sc.total.net, tradeCount: sc.total.trades, records: journal.length, winRate: sc.total.winRate,
    summary: { byStrategy: sc.rows.map(pick), whoClosed: sc.exits.map(pick), byExit, byPool } };
}

const meta = (r) => { const { tradeJournal, ...rest } = r; return { ...rest, records: tradeJournal ? tradeJournal.length : rest.records }; }; // eslint-disable-line no-unused-vars

// Run list for the Journal selector: the current run (+ its live summary) and the archived runs (without their journals).
function list(ledger) {
  const cur = current(ledger);
  const journal = ledger.getTradeJournal().filter(isPaper);
  return { current: { ...cur, ...summarize(journal), open: ledger.getActivePositions().filter(isPaper).length }, archived: load().archived.map(meta).reverse() };
}
const get = (runId) => { const r = load().archived.find((x) => x.runId === runId); return r ? clone(r) : null; };

// -> { ok, archived (meta), current, removed, backupFile } | { ok: false, code, error, ids? }
function resetRun(ledger, { name = '', now = Date.now(), priceOf = defaultPrice } = {}) {
  const paper = ledger.getActivePositions().filter(isPaper);
  const atAlpaca = paper.filter((p) => p.paperBroker === 'alpaca');
  if (atAlpaca.length) {
    return { ok: false, code: 'ALPACA_POSITIONS_OPEN', ids: atAlpaca.map((p) => p.id),
      error: `${atAlpaca.length} paper position${atAlpaca.length === 1 ? ' is' : 's are'} open or working at Alpaca Paper (${atAlpaca.map((p) => p.asset).join(', ')}): `
        + 'those are real broker orders, so close them first ([Close] on each in Portfolio), then start the new run' };
  }
  const noPrice = paper.filter((p) => !(priceOf(p.asset) > 0));
  if (noPrice.length) return { ok: false, code: 'NO_PRICE', ids: noPrice.map((p) => p.id), error: `no price yet to close ${noPrice.map((p) => p.asset).join(', ')} at; try again in a minute` };
  const run = current(ledger);
  const label = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  // ---- synchronous from here to the reset ----
  const closed = paper.map((p) => ledger.closePosition(p.id, priceOf(p.asset), 'RUN_RESET').id);
  const journal = clone(ledger.getTradeJournal().filter(isPaper));
  const record = { runId: run.runId, number: run.number, name: label || `Run ${run.number} (${range(run.startedAt, now)})`, startedAt: run.startedAt, endedAt: now,
    initialBankroll: run.initialBankroll, initialCryptoBankroll: run.initialCryptoBankroll, ...summarize(journal), closedAtReset: closed,
    stagedDiscarded: ledger.getPendingOrders().filter((o) => !liveSetup(o)).length, tradeJournal: journal };
  const d = load();
  const s = ledger.getSettings();
  const next = d.archived.length + 2;
  d.archived.push(record);
  d.current = { runId: `run-${next}`, number: next, startedAt: now, initialBankroll: s.bankroll, initialCryptoBankroll: s.cryptoBankroll };
  save(); // the archive first: if anything below fails, the trades are still in the ledger AND the archive
  const r = ledger.resetPaper('all', { keepLiveSetups: true }); // LIVE setups waiting in Approvals are not part of a paper run
  require('../risk/daily-loss').resetBook('paper');
  console.warn(`[runs] archived ${record.name}: ${record.tradeCount} trades, net ${record.finalNetPnl.toFixed(2)} (${closed.length} closed at the reset); `
    + `removed ${JSON.stringify(r.removed)}; paper restarts at $${s.bankroll} / $${s.cryptoBankroll}; backup ${r.backupPath}`);
  return { ok: true, archived: meta(record), current: { ...d.current }, removed: r.removed, backupFile: r.backupPath ? path.basename(r.backupPath) : null };
}

function defaultPrice(asset) {
  const prices = require('../market/latest-prices');
  return prices.getLatestPrice(asset) || prices.getMarkPrice(asset) || null;
}

const reset = () => { data = null; }; // tests: re-read the file

module.exports = { resetRun, list, get, current, summarize, load, reset, file, NAME_MAX };
