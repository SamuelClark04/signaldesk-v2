// Phase 89c: Quick Flips deadline exits beyond 3:45 PM (escalation, restart near the close, stale / missing quotes, partial and rejected
// closing orders, the market closing first), failure alerts, the audit reconciliation bridge, the forward-test report's verdict rules,
// the version report. Run: node tests/ph89cunit.js. Scratch ledger, fake keys, dead URLs, stubbed Alpaca Paper.
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph89c-'));
const DEAD = 'http://127.0.0.1:9';
const ENV = { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), PAPER_RUNS_PATH: path.join(DIR, 'runs.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKTEST', ALPACA_PAPER_API_SECRET: 'test', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD };
Object.assign(process.env, ENV);
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
fs.writeFileSync(ENV.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 100000, stockMode: 'paper', paperStockBroker: 'alpaca', strategyPauseVersion: 90 },
  pendingOrders: [], activePositions: [], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const et = require(S + 'services/et-time');
const T = (h, m, s = 0, d = '2026-10-07') => et.toEpoch(d, h, m) + s * 1000; // Wednesday; the next day is a Thursday
const quiet = () => ({ b5: [] });

(async () => {
  const L = require(S + 'execution/paper-ledger'); const ap = require(S + 'execution/alpaca-paper'); const paperApi = require(S + 'connectors/alpaca-api').paper;
  const spreads = require(S + 'connectors/alpaca-options'); const od = require(S + 'connectors/options-data');
  const qf = require(S + 'strategies/7-options-quickflips'); const { processCandidate } = require(S + 'risk/risk-engine');
  const placed = []; let reject = null; let orders = {};
  spreads.closeSpread = async (pos, id, limit) => { if (reject) return { ok: false, error: reject }; placed.push(limit); return { ok: true, brokerId: `c${placed.length}` }; };
  paperApi.cancelOrder = async () => ({ ok: true });
  paperApi.getOrder = async (id) => orders[id] || { ok: true, terminal: true, filledQty: 0, status: 'canceled' };
  paperApi.getOrderStatus = async () => ({ ok: true, terminal: true, filledQty: 1, avgFillPrice: 5.1, status: 'filled' });
  let quote = { bid: 4.8, ask: 4.9, mid: 4.85 }; let quoteAge = 5000;
  od.freshQuote = (sym, maxAge) => (quote && quoteAge <= maxAge ? { ...quote, quoteTime: Date.now() - quoteAge, at: Date.now() - quoteAge } : null);
  const marks = require(S + 'execution/option-marks'); marks.saleValue = () => ({ value: 4.0 });
  const notes = []; const notify = async (m) => { notes.push(m.subject); };
  let n = 0;
  const open = (openedAt, x = {}) => {
    n += 1;
    const c = qf.candidate('SPY', { setup: 'S1', dir: 'long', endMin: 590 + n * 5, trigger: 769.5, vwap: 768, spot: 770.2, relVol: 2 },
      { contract: { symbol: 'SPY261013C00770000', expiration: '2026-10-13', strike: 770, dte: 6, iv: 0.15 }, quote: { bid: 5.0, ask: 5.1, quoteTime: openedAt }, mid: 5.05 }, openedAt, 'indicative');
    const sized = processCandidate(c, 100000, { riskPct: 0.02 });
    L.stageOrder(sized);
    L.executeOrder(sized.id, 770, { paperBroker: 'alpaca', broker: 'Alpaca Paper', brokerId: `e${n}`, fillEstimated: false, ...x });
    L.updatePositions((p) => (p.id === sized.id ? Object.assign(p, { openedAt }) && true : false));
    return sized.id;
  };
  const pos = (id) => L.getActivePositions().find((p) => p.id === id);
  let QX = require(S + 'execution/quickflip-exits');

  // 1. A close not yet started at 3:47 PM (after the old 3:45 cutoff) is still sent: the deadline is not gated by the options window.
  const a = open(T(15, 30));
  orders = { c1: { ok: true, terminal: true, filledQty: 1, avgFillPrice: 4.75, status: 'filled', orderId: 'c1' } };
  const r1 = await QX.run(L, { sessionFor: quiet, notify }, T(15, 47));
  check('3:47 PM (after the 3:45 window): a Quick Flip with no working close is closed (QF_DEADLINE), booked at the broker fill 4.75', r1.some((x) => x.trade) && !pos(a)
    && L.getTradeJournal().some((t) => t.id === a && t.exitReason === 'QF_DEADLINE' && t.optionsExitValue === 4.75), JSON.stringify(r1.map((x) => x.reason)));

  // 2. Escalation timing (from the deadline: the same clock times on the day) and the next-day carry-over.
  const P = { strategyId: 'options-quickflips', market: 'options', openedAt: T(15, 20), optionsData: { quickFlip: { deadlineMin: 940, maxHoldMin: 60 } } };
  check('urgency: 3:41:59 none, 3:42 -> 25%, 3:50 -> 50%, next morning 9:31 -> 50%; due next day = QF_DEADLINE', QX.urgency(P, T(15, 41, 59)) === null && QX.urgency(P, T(15, 42)) === 0.25
    && QX.urgency(P, T(15, 50)) === 0.5 && QX.urgency(P, T(9, 31, 0, '2026-10-08')) === 0.5 && QX.due(P, T(9, 31, 0, '2026-10-08'), quiet).reason === 'QF_DEADLINE');

  // 3. A restart near the close: the working close is persisted; fresh module state re-prices it 50% under at 3:51 PM.
  const b = open(T(15, 25), { paperExitOrderId: 'w1', paperExitReason: 'QF_DEADLINE', paperExitLeg: 'qf_deadline', exitWork: { kind: 'exit', reason: 'QF_DEADLINE', limit: 6.0, step: 4, stepAt: T(15, 40), placedAt: T(15, 40), q0: { bid: 5.0, mid: 5.05 }, triggeredAt: T(15, 40) } });
  for (const m of ['execution/quickflip-exits', 'execution/spread-exit', 'execution/quickflip-alerts']) delete require.cache[require.resolve(S + m)];
  QX = require(S + 'execution/quickflip-exits');
  orders = {}; placed.length = 0;
  await QX.run(L, { sessionFor: quiet, notify }, T(15, 51));
  check('restart near the close: after a reload (all in-memory state gone) the persisted close is re-priced 50% under the fresh bid 4.80 -> 2.40; the first trigger quote q0 is kept', placed[0] === 2.4 && pos(b).exitWork.q0.bid === 5.0, JSON.stringify(placed));

  // 4. Stale quote (none fresh): priced from the LAST known quote; no quote at all: the model value.
  quoteAge = 10 * 60000; placed.length = 0;
  L.updatePositions((p) => (p.id === b ? Object.assign(p, { exitWork: { ...p.exitWork, urgentAt: T(15, 51), limit: 2.4 } }) && true : false));
  await QX.run(L, { sessionFor: quiet, notify }, T(15, 52));
  check('stale quote: no lower re-price than 50% of the last known bid (2.40) -> no new order, the close keeps working', placed.length === 0);
  quote = null; L.updatePositions((p) => (p.id === b ? Object.assign(p, { exitWork: { ...p.exitWork, limit: 3.0 } }) && true : false));
  await QX.run(L, { sessionFor: quiet, notify }, T(15, 53));
  check('no quote at all: re-priced from the model value (4.00 -> 2.00)', placed[0] === 2.0, JSON.stringify(placed));
  quote = { bid: 4.8, ask: 4.9, mid: 4.85 }; quoteAge = 5000;

  // 5. Rejected closing orders: recorded, alerted (warn), emailed once; still open at the close: critical, emailed again.
  reject = 'insufficient qty'; placed.length = 0;
  L.updatePositions((p) => (p.id === b ? Object.assign(p, { exitWork: { ...p.exitWork, urgentAt: T(15, 50), limit: 9 } }) && true : false));
  await QX.run(L, { sessionFor: quiet, notify }, T(15, 54));
  const qa = require(S + 'execution/quickflip-alerts');
  let al = qa.alerts().find((x) => x.id === b);
  check('rejected re-price: no order, failure recorded; alert WARN (open past 3:45) names the error; e-mailed once', al && al.level === 'warn' && /insufficient qty/.test(al.text) && notes.length === 1, JSON.stringify([al && al.level, notes]));
  await QX.run(L, { sessionFor: quiet, notify }, T(15, 55));
  check('...the same level is not e-mailed again', notes.length === 1);
  const r5 = await QX.run(L, { sessionFor: quiet, notify }, T(16, 5));
  al = qa.alerts().find((x) => x.id === b);
  check('market closed with the position still open: no orders, alert CRITICAL ("held overnight"), e-mailed; the shield status carries it to the banner', r5.length === 0 && al && al.level === 'critical' && notes.length === 2
    && require(S + 'risk/entry-shields').status({}).quickFlipAlerts.some((x) => x.id === b && x.level === 'critical'));
  // next morning: due at once; a partial fill of the closing order books the part, the rest is closed next
  reject = null; L.updatePositions((p) => (p.id === b ? Object.assign(p, { positionSize: 2, dollarRisk: p.dollarRisk * 2, paperExitOrderId: 'w9', exitWork: { ...p.exitWork, urgentAt: 0 } }) && true : false));
  orders = { w9: { ok: true, terminal: true, filledQty: 1, avgFillPrice: 4.6, orderId: 'w9' } };
  await QX.run(L, { sessionFor: quiet, notify }, T(9, 36, 0, '2026-10-08'));
  check('next morning: the partially filled close books 1 of 2 contracts; 1 stays open with its exit cleared (still alerted)', pos(b) && pos(b).positionSize === 1 && !pos(b).paperExitOrderId
    && L.getTradeJournal().some((t) => t.parentId === b && t.positionSize === 1) && qa.alerts().some((x) => x.id === b));
  orders = { c2: { ok: true, terminal: true, filledQty: 1, avgFillPrice: 4.7, orderId: 'c2' }, c1: { ok: true, terminal: true, filledQty: 1, avgFillPrice: 4.7, orderId: 'c1' } };
  placed.length = 0; await QX.run(L, { sessionFor: quiet, notify }, T(9, 37, 0, '2026-10-08'));
  check('...the remaining contract is closed (QF_DEADLINE carried over) and the alert clears', !pos(b) && !qa.alerts().some((x) => x.id === b), JSON.stringify(qa.alerts()));
  // internal paper without a price: failure recorded, alerted
  const c = open(T(15, 20), { paperBroker: undefined, broker: undefined });
  L.updatePositions((p) => (p.id === c ? (delete p.paperBroker, true) : false));
  await QX.run(L, { sessionFor: quiet, notify }, T(15, 46));
  check('internal paper with no live price at the deadline: failure recorded and alerted, never silently skipped', qa.alerts().some((x) => x.id === c && /no live SPY price/.test(x.text)));

  // 6. Audit bridge: the bid/ask cost C and the overstatement overlap (0.7 x C).
  const AA = require(path.join(__dirname, '..', 'scripts', 'audit-attribution'));
  const rec = { strategyId: 'options-system', execution: 'PAPER', netPnl: 20, grossPnl: 22.6, fees: 2.6, exitReason: 'MANUAL_CLOSE', positionSize: 1, optionsData: { fill: 'package', combinedLegSpread: 0.5, multiplier: 100 } };
  const rc = AA.reconcile(rec, { netAtNatural: 20 - 35, flags: [] });
  check('bridge: C = $50 bid/ask; the model booked 30% ($15), the overstatement is the other 70% ($35); reconciled = recorded - $35 (C is not added again)', rc.spreadCost === 50 && Math.abs(rc.spreadBooked - 15) < 1e-9 && rc.overstatement === 35 && rc.reconciled === -15);

  // 7. Forward report rules (pass needs 150 trades; 12 months short of it = INCONCLUSIVE; checkpoint means in $/share).
  const mk = (i, net, x = {}) => ({ id: `qf${i}`, strategyId: 'options-quickflips', market: 'options', execution: 'PAPER', paperBroker: 'alpaca', asset: i % 2 ? 'SPY' : 'QQQ', openedAt: Date.parse('2026-10-08T15:00:00Z') + i * 864e5,
    closedAt: Date.parse('2026-10-08T15:30:00Z') + i * 864e5, netPnl: net, dollarRisk: 100, exitReason: 'QF_MAX_HOLD', optionsExitValue: 5.0, ...x,
    optionsData: { debit: 5.12, plannedDebit: 5.1, netMid: 5.05, refAt: 1000, quoteTime: 0, exitRule: { targetValue: 7.4 } }, exitWork: { kind: 'exit', q0: { bid: 5.03, mid: 5.08 } } });
  const report = (journal, nowDay) => { const f = path.join(DIR, 'fw.json'); fs.writeFileSync(f, JSON.stringify({ tradeJournal: journal, discardedOrders: [] }));
    return execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'quickflips-forward-report.js'), f, '--start', '2026-10-05', ...(nowDay ? ['--now', nowDay] : [])], { encoding: 'utf8' }); };
  const forty = report(Array.from({ length: 40 }, (_, i) => mk(i, i % 3 ? 30 : -40)));
  check('checkpoint: E1 = fill 5.12 - signal ask 5.10 = $0.02/share, X1 = trigger bid 5.03 - fill 5.00 = $0.03 (means <= $0.05): PASSED', /CHECKPOINT: PASSED/.test(forty) && /E1 mean 0\.020/.test(forty) && /X1 mean 0\.030/.test(forty));
  const late = report(Array.from({ length: 120 }, (_, i) => mk(i, 50)), '2027-10-10');
  check('12 months with 120 (< 150) trades: INCONCLUSIVE even with every trade a winner (no early pass)', /STATUS: INCONCLUSIVE/.test(late) && !/VERDICT: PASS/.test(late));

  // 7b. The banner text (client/components/shield-banner.js content(), loaded with a stub window).
  global.window = { SignalDesk: { ui: { el: () => ({}), money: (x) => `$${Number(x).toFixed(2)}` } } };
  require(path.join(__dirname, '..', 'client', 'components', 'shield-banner.js'));
  const ban = window.SignalDesk.shieldBanner.content({ at: Date.now(), quickFlipAlerts: [{ asset: 'SPY', level: 'critical', text: 'QUICK FLIP HELD OVERNIGHT: SPY ...' }], kill: { paper: { book: 'paper', active: true, limit: 150, pnl: -200 } } });
  check('banner: a Quick Flip alert outranks even the kill switch ("QUICK FLIP HELD OVERNIGHT (SPY)", red)', ban && ban[0] === 'is-stop' && /QUICK FLIP HELD OVERNIGHT \(SPY\)/.test(ban[1]));

  // 8. Version report.
  const v = require(S + 'version').report({ strategiesEnabled: { 'speculative-crypto': false }, stockMode: 'paper', strategyPauseVersion: 90 });
  check('version report: the commit read at boot + the switches / modes that decide what can trade (no secrets)', /^[0-9a-f]{7,}$|^unknown$/.test(v.commit) && v.strategyPauseVersion === 90 && v.strategiesEnabled['speculative-crypto'] === false && !('LAN_ACCESS_TOKEN' in v));

  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
