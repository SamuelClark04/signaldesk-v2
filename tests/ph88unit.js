// Phase 88: Archive & Start New Paper Run. Run: node tests/ph88unit.js. Scratch ledger + runs file in the OS temp dir, blank keys,
// dead URLs, no network (fetch throws). Checks: the archive keeps every paper journal record intact, the active paper book (positions,
// journal, kill switch, cash) restarts, LIVE records are untouched, Alpaca Paper positions block the reset, persistence, the HTTP route.
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph88-'));
const DEAD = 'http://127.0.0.1:9';
const ENV = { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: '', ALPACA_PAPER_API_SECRET: '', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD };
Object.assign(process.env, ENV);
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
const NOW = Date.now(); const H = 3600e3;
// Phase 89: New York calendar stamps (NOW - 20 h was 'yesterday' only before 8 PM ET, NOW - 2 h 'today' only after 2 AM ET).
const ET = require(path.join(__dirname, '..', 'server', 'services', 'et-time'));
const TODAY = Math.max(ET.dayStart(NOW) + 60e3, NOW - 2 * H); const YESTERDAY = ET.dayStart(NOW) - 4 * H;
const paperT = (id, net, x = {}) => ({ id, asset: 'SPY', market: 'options', strategyId: 'options-system', direction: 'short', execution: 'PAPER', sizingBasis: 'paper', positionSize: 1, fillPrice: 500,
  dollarRisk: 100, netPnl: net, grossPnl: net + 1, fees: 1, rMultiple: net / 100, exitReason: 'MANUAL_CLOSE', openedAt: NOW - 30 * H, closedAt: TODAY, optionsData: { debit: 1.2, multiplier: 100, legs: [] }, ...x });
const JOURNAL = [paperT('p1', 40), paperT('p2', -150, { exitReason: 'STOP_LOSS' }), paperT('p3', 25, { closedAt: YESTERDAY }), { ...paperT('p3:trim:1', 10), parentId: 'p3' },
  paperT('c1', -3, { asset: 'ETH-USD', market: 'crypto', strategyId: 'speculative-crypto', direction: 'long' }),
  paperT('L1', 2.5, { asset: 'ETH-USD', market: 'crypto', execution: 'LIVE', sizingBasis: 'live', strategyId: 'speculative-crypto', broker: 'Coinbase', direction: 'long' })];
const internal = { id: 'equity-swing:KO:1', asset: 'KO', market: 'stocks', strategyId: 'equity-swing', setupType: 'Pullback', direction: 'long', execution: 'PAPER', sizingBasis: 'paper',
  positionSize: 10, fillPrice: 60, entryPrice: 60, invalidation: 58, dollarRisk: 20, openedAt: NOW - 5 * H, targets: [{ level: 1, price: 64, allocation: 1 }], entryZone: { min: 59.9, max: 60 } };
const atAlpaca = { ...internal, id: 'opt:NVDA:alpaca', asset: 'NVDA', paperBroker: 'alpaca', brokerId: 'x1' };
const liveCoin = { ...internal, id: 'live:ETH', asset: 'ETH-USD', market: 'crypto', execution: 'LIVE', sizingBasis: 'live', fillPrice: 2500, entryPrice: 2500, positionSize: 0.01 };
const adopted = { ...liveCoin, id: 'adopt:BTC', asset: 'BTC-USD', adopted: true, strategyId: 'adopted-hold' };
const setup = (id, x = {}) => ({ id, asset: 'AAPL', market: 'stocks', strategyId: 'equity-swing', direction: 'long', stagedAt: NOW - H, sizingBasis: 'paper', ...x });
fs.writeFileSync(ENV.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 10000, cryptoBankroll: 5000, stockMode: 'paper', cryptoMode: 'live', dailyLossLimitPaper: 100 },
  pendingOrders: [setup('paper-setup'), setup('live-setup', { sizingBasis: 'live', execution: 'LIVE' })], activePositions: [internal, atAlpaca, liveCoin, adopted],
  tradeJournal: JOURNAL, discardedOrders: [setup('old-rejected')], savedSetups: [], pilotActions: [] }, null, 2));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const PX = { KO: 61, NVDA: 180, 'ETH-USD': 2600, 'BTC-USD': 90000 };
const priceOf = (a) => PX[a] || null;

(async () => {
  const L = require(S + 'execution/paper-ledger');
  const runs = require(S + 'execution/paper-runs');
  const pools = require(S + 'execution/paper-pools');
  const dl = require(S + 'risk/daily-loss');
  const settings = () => L.getSettings();
  // Today's paper losses trip the paper kill switch first (-150 + 40 + 10 ... closed today).
  const k0 = dl.refresh({ journal: L.getTradeJournal(), positions: [], settings: settings(), now: NOW, markOf: () => null });
  check('before: today\'s paper P/L tripped the PAPER kill switch (live untouched)', k0.paper.active && !k0.live.active, `${k0.paper.pnl}`);
  const cash0 = pools.summary(L).stocks.cash;

  // 1. Alpaca Paper positions block the reset; nothing changes.
  const before = JSON.stringify({ j: L.getTradeJournal(), p: L.getActivePositions() });
  const refused = runs.resetRun(L, { priceOf, now: NOW });
  check('refused while a paper position is open at Alpaca Paper (real broker orders would be orphaned): code ALPACA_POSITIONS_OPEN, nothing changed, no archive written',
    !refused.ok && refused.code === 'ALPACA_POSITIONS_OPEN' && refused.ids.join() === 'opt:NVDA:alpaca' && JSON.stringify({ j: L.getTradeJournal(), p: L.getActivePositions() }) === before && !fs.existsSync(runs.file()), refused.error);
  let threw = ''; try { L.resetPaper('all'); } catch (e) { threw = e.message; }
  check('...and the old Settings reset (Danger zone) is refused the same way now', /open or working at Alpaca Paper \(NVDA\)/.test(threw) && L.getActivePositions().length === 4, threw);
  L.closePosition(atAlpaca.id, 180, 'MANUAL_CLOSE @ Alpaca Paper'); // the user closes it at Alpaca first (a paper trade of this run)
  check('no price for an internal paper position -> refused NO_PRICE (it is closed at its mark, never at a guess)', runs.resetRun(L, { priceOf: () => null, now: NOW }).code === 'NO_PRICE');

  // 2. The reset.
  const paperBefore = JSON.parse(JSON.stringify(L.getTradeJournal().filter((t) => t.execution !== 'LIVE')));
  const r = runs.resetRun(L, { priceOf, now: NOW, name: '  First stress test\u0007  ' });
  const archived = runs.get(r.archived.runId);
  const intact = paperBefore.every((t) => JSON.stringify(archived.tradeJournal.find((x) => x.id === t.id)) === JSON.stringify(t));
  check('archived: EVERY paper journal record intact (deep-equal, partials included) + the open paper position closed at its mark as RUN_RESET',
    r.ok && intact && archived.tradeJournal.length === paperBefore.length + 1 && archived.tradeJournal.some((t) => t.id === internal.id && t.exitReason === 'RUN_RESET' && t.exitPrice === 61), `${archived.tradeJournal.length}`);
  const runSum = archived.tradeJournal.reduce((s, t) => s + t.netPnl, 0);
  check('archive summary: final net = the sum of its records, trades counted once per position (a T1 partial + runner = 1), win rate, by strategy / who closed it / exit / pool',
    Math.abs(archived.finalNetPnl - runSum) < 1e-9 && archived.tradeCount === 6 && archived.summary.byStrategy.length === 3
    && archived.summary.whoClosed.some((x) => /Closed by you/.test(x.label)) && archived.summary.byExit.STOP_LOSS.n === 1 && archived.summary.byPool.crypto === -3 && Math.abs(archived.winRate - 4 / 6) < 1e-9,
    JSON.stringify({ net: archived.finalNetPnl, n: archived.tradeCount, w: archived.winRate }));
  check('run metadata: run-1, the custom name cleaned (trimmed, control chars removed), started at its first paper trade, initial bankrolls',
    archived.runId === 'run-1' && archived.name === 'First stress test' && archived.startedAt === NOW - 30 * H && archived.endedAt === NOW && archived.initialBankroll === 10000 && archived.initialCryptoBankroll === 5000, archived.name);
  const pos = L.getActivePositions(); const j = L.getTradeJournal(); const pend = L.getPendingOrders();
  check('active book: no paper positions, no paper journal records, paper setups cleared', !pos.some(pools.isPaper) && !j.some(pools.isPaper) && !pend.some((o) => o.id === 'paper-setup'));
  check('LIVE untouched: the LIVE trade (taxes), the LIVE + adopted positions and the LIVE setup waiting in Approvals', j.length === 1 && j[0].id === 'L1'
    && pos.map((p) => p.id).sort().join() === 'adopt:BTC,live:ETH' && pend.map((o) => o.id).join() === 'live-setup');
  const p1 = pools.summary(L);
  check(`paper cash back at the bankrolls: stocks $${p1.stocks.cash} (was $${cash0.toFixed(2)}), crypto $${p1.crypto.cash}`, p1.stocks.cash === 10000 && p1.crypto.cash === 5000 && p1.stocks.realized === 0);
  const k1 = dl.current();
  const k2 = dl.refresh({ journal: L.getTradeJournal(), positions: [], settings: settings(), now: NOW + 1000, markOf: () => null });
  check('daily kill switch: the paper book is released at once and stays released (today\'s paper P/L restarts at $0)', !k1.paper.active && k1.paper.trippedAt === null && !k2.paper.active && k2.paper.pnl === 0);
  const cur = runs.current(L);
  check('the next run: run-2, started now, at the current bankrolls; a backup of the ledger file was saved', cur.runId === 'run-2' && cur.number === 2 && cur.startedAt === NOW && cur.initialBankroll === 10000
    && r.backupFile && fs.existsSync(path.join(DIR, r.backupFile)), JSON.stringify(cur));
  check('stored NEXT TO the ledger file (paper-runs.json), not inside ledger-state.json', runs.file() === path.join(DIR, 'paper-runs.json') && !('archivedRuns' in JSON.parse(fs.readFileSync(ENV.LEDGER_STATE_PATH, 'utf8'))));

  // 3. Persistence across a restart.
  const SF = S.split(path.sep).join('/'); // forward slashes inside the child's source
  const out = execFileSync(process.execPath, ['-e', `const L = require('${SF}execution/paper-ledger'); const R = require('${SF}execution/paper-runs');
    const l = R.list(L); const a = R.get('run-1'); console.log(JSON.stringify({ cur: l.current.runId, n: l.archived.length, recs: a.tradeJournal.length, paper: L.getTradeJournal().length }))`],
  { env: { ...process.env, ...ENV } }).toString().trim().split('\n').pop();
  const o = JSON.parse(out);
  check('a restart restores both: the archive (run-1 with its 7 records) and the cleared active ledger (1 LIVE record)', o.cur === 'run-2' && o.n === 1 && o.recs === 7 && o.paper === 1, out);

  // 4. A second run.
  L.getTradeJournal().push(paperT('n1', 12, { openedAt: NOW + H, closedAt: NOW + 2 * H }));
  const r2 = runs.resetRun(L, { priceOf, now: NOW + 3 * H });
  const l = runs.list(L);
  check('the second run archives as run-2 with a default name "Run 2 (<dates>)"; the list is newest first and carries no journals',
    r2.ok && r2.archived.runId === 'run-2' && /^Run 2 \(/.test(r2.archived.name) && l.archived.map((x) => x.runId).join() === 'run-2,run-1' && l.archived.every((x) => !x.tradeJournal) && l.current.runId === 'run-3');

  // 5. HTTP routes.
  require(S + 'security/access-policy').checkHttp = () => ({ ok: true });
  require(S + 'execution/broker-state').publishBrokerState = async () => {};
  require(S + 'intelligence/dashboard-intel').publishIntelligence = () => {};
  const routes = {}; const sent = [];
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  require(S + 'http-routes').installPaperRuns(app, 3999, { broadcast: (type) => sent.push(type) });
  const call = (key, req) => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, set() { return this; }, json(b) { this.body = b; return this; } }; routes[key]({ params: {}, body: {}, ...req }, res); return res; };
  const no = call('POST /api/paper/reset-run', { body: {} });
  L.getTradeJournal().push(paperT('h1', 5, { openedAt: NOW + 4 * H, closedAt: NOW + 5 * H }));
  const yes = call('POST /api/paper/reset-run', { body: { confirm: true, name: 'via http' } });
  check('POST /api/paper/reset-run: needs confirm: true (400); then archives ("via http") and broadcasts the fresh state (positions, journal, queue, kill switch banner, runs)',
    no.code === 400 && yes.code === 200 && yes.body.ok && yes.body.archived.name === 'via http' && ['POSITIONS_UPDATED', 'JOURNAL_UPDATED', 'QUEUE_UPDATED', 'ENTRY_SHIELDS', 'PAPER_RUNS'].every((t) => sent.includes(t)), JSON.stringify(sent));
  const g = call('GET /api/paper/runs/:runId', { params: { runId: 'run-1' } }); const g404 = call('GET /api/paper/runs/:runId', { params: { runId: 'run-99' } });
  const lst = call('GET /api/paper/runs', {});
  check('GET /api/paper/runs (3 archived, no journals) and /api/paper/runs/:id (the whole journal; unknown -> 404)', lst.body.archived.length === 3 && g.body.run.tradeJournal.length === 7 && g404.code === 404);

  // 6. Client wiring.
  const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
  check('UI: Journal run selector (#journal-runs), Settings > Paper trading run (#settings-paper-run), scripts + stylesheet loaded; the modal states the spec\'s message',
    /id="journal-runs"/.test(html) && /id="settings-paper-run"/.test(html) && /views\/journal-runs\.js/.test(html) && /styles\/paper-runs\.css/.test(html)
    && /This will archive your current trades to the Journal history and reset your cash balance, daily kill switch, and active positions to start fresh\./.test(fs.readFileSync(path.join(__dirname, '..', 'client', 'views', 'settings-paper-run.js'), 'utf8')));

  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
