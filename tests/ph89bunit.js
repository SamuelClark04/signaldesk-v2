// Phase 89b: Quick Flips completeness vs REST IEX bars + restart recovery, automatic paper execution, the signal-anchored entry
// deadline, 1 contract, deadline exits re-priced when unfilled (unfilled close, no quote, partial close), versioned pauses
// (Moonshots), the audit attribution. Run: node tests/ph89bunit.js. Scratch ledger, fake keys, dead URLs, stubbed brokers.
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph89b-'));
const DEAD = 'http://127.0.0.1:9';
const ENV = { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), PAPER_RUNS_PATH: path.join(DIR, 'runs.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKTEST', ALPACA_PAPER_API_SECRET: 'test', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD };
Object.assign(process.env, ENV);
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
fs.writeFileSync(ENV.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 100000, cryptoBankroll: 5000, stockMode: 'paper', cryptoMode: 'paper', paperStockBroker: 'alpaca', strategyPauseVersion: 90 },
  pendingOrders: [], activePositions: [], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const et = require(S + 'services/et-time');
const T = (h, m, s = 30) => et.toEpoch('2026-10-07', h, m) + s * 1000; // a Wednesday
const slots = (mins) => { const a = new Array(390).fill(null); for (const m of mins) a[m] = { c: 1 }; return a; };
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

(async () => {
  // 1. Completeness vs the bars REST says exist, scaled to now (not a full session); fail closed without REST.
  const qf = require(S + 'strategies/7-options-quickflips');
  const iexMinutes = range(0, 21).filter((m) => m !== 7 && m !== 13); // IEX had no trade at 9:37 and 9:43
  const ref = { at: T(9, 51), minutes: new Set(iexMinutes) };
  check('9:51 AM, the 19 IEX bars REST reports for 9:30-9:50 all present -> complete (IEX silent minutes are not "missing"; no full session needed)', qf.completeness(slots(iexMinutes), T(9, 51), ref).ok);
  check('...3 of them missing (a gap after a restart) -> incomplete; 1 missing -> allowed', !qf.completeness(slots(iexMinutes.slice(3)), T(9, 51), ref).ok && qf.completeness(slots(iexMinutes.slice(1)), T(9, 51), ref).ok);
  check('...the newest bar gets 15 s to arrive (9:51:05 does not expect the 9:50 bar yet)', qf.completeness(slots(iexMinutes.filter((m) => m !== 20)), T(9, 51, 5), ref).ok);
  check('...no REST read (or one older than 2 min) -> cannot verify -> NO entry (fail closed)', !qf.completeness(slots(iexMinutes), T(9, 51), null).ok && !qf.completeness(slots(iexMinutes), T(9, 55), ref).ok);
  // restart recovery: REST bars are merged into the stream store
  const hb = require(S + 'connectors/history-bars'); const stream = require(S + 'connectors/alpaca-stock-socket');
  hb.getMinuteBarsSince = async (syms, since) => ({ ok: true, bars: { SPY: range(0, 21).map((m) => ({ symbol: 'SPY', open: 1, high: 1, low: 1, close: 1, volume: 10, time: new Date(since + m * 60000).toISOString() })) } });
  const r0 = await qf.syncSession('SPY', T(9, 51));
  check('restart recovery: syncSession reads REST IEX bars and merges them into the stream store (21 bars since 9:30)', r0 && r0.minutes.size === 21 && (stream.getLatestBars().get('SPY') || []).length === 21);

  // 2. 1 contract; signal-anchored deadline; approval expiry.
  const cand = qf.candidate('SPY', { setup: 'S1', dir: 'long', endMin: 590, trigger: 769.5, vwap: 768, spot: 770.2, relVol: 2 },
    { contract: { symbol: 'SPY261013C00770000', expiration: '2026-10-13', strike: 770, dte: 6, iv: 0.15, delta: 0.52 }, quote: { bid: 5.0, ask: 5.1, quoteTime: T(9, 51) }, mid: 5.05 }, T(9, 51), 'indicative');
  const { processCandidate } = require(S + 'risk/risk-engine');
  const sized = processCandidate(cand, 100000, { riskPct: 0.02 });
  check('1 contract even on a $100,000 bankroll (the tested size); entry deadline = 9:51 + 3 min', sized.approved && sized.positionSize === 1 && cand.optionsData.entryDeadlineAt === et.toEpoch('2026-10-07', 9, 54), `${sized.positionSize}`);
  const ttl = require(S + 'execution/setup-ttl');
  check('approval window ends at the entry deadline (9:54): pending at 9:53, EXPIRED at 9:55', ttl.expiresAt(cand) === et.toEpoch('2026-10-07', 9, 54) && !ttl.staleness(cand, 770, T(9, 53, 0)) && /EXPIRED/.test(ttl.staleness(cand, 770, T(9, 55, 0)) || ''));
  const SE = require(S + 'execution/spread-entry');
  const work = { ...cand, brokerId: 'b1', fillEstimated: true, entryWork: { placedAt: T(9, 53, 50), limit: 5.1 } };
  const api = { cancelOrder: async () => ({ ok: true }), getOrderStatus: async () => ({ ok: true, terminal: true, filledQty: 0 }) };
  check('an entry placed late (9:53:50) is canceled at the signal\'s deadline (9:54), not 3 min after placement', (await SE.work(work, {}, { api, place: null, now: T(9, 54, 5) })).void === 'ENTRY_UNFILLED');

  // 3. Automatic paper execution (the user's choice), paper only, once, via the normal approval path.
  const auto = require(S + 'execution/auto-paper');
  const calls = []; const router = { inFlight: new Set(), approveWithGuard: async (id) => { calls.push(id); return { ok: true }; } };
  const led = { getPendingOrders: () => [], getActivePositions: () => [] };
  await auto.consider(sized, { settings: { stockMode: 'paper' }, router, ledger: led });
  await auto.consider(sized, { settings: { stockMode: 'paper' }, router, ledger: led });
  check('auto paper: a staged Quick Flip is approved through order-router.approveWithGuard, exactly once', calls.length === 1 && calls[0] === sized.id);
  check('...never when the options book is LIVE, when switched off, or for other strategies', !auto.eligible(sized, { stockMode: 'live' }) && !auto.eligible(sized, { quickFlipsAutoPaper: false })
    && !auto.eligible({ ...sized, strategyId: 'options-system' }, {}) && !auto.eligible({ ...sized, sizingBasis: 'alpaca-live' }, {}));

  // 4. Deadline exits re-priced when they do not fill (Alpaca Paper, stubbed).
  const L = require(S + 'execution/paper-ledger'); const ap = require(S + 'execution/alpaca-paper'); const paperApi = require(S + 'connectors/alpaca-api').paper;
  const spreads = require(S + 'connectors/alpaca-options'); const od = require(S + 'connectors/options-data');
  const placed = []; spreads.closeSpread = async (pos, id, limit) => { placed.push(limit); return { ok: true, brokerId: `x${placed.length}` }; };
  paperApi.cancelOrder = async () => ({ ok: true }); paperApi.getOrder = async () => ({ ok: true, terminal: true, filledQty: 0, status: 'canceled' });
  L.stageOrder(sized); L.executeOrder(sized.id, 770, { paperBroker: 'alpaca', broker: 'Alpaca Paper', brokerId: 'e1', fillEstimated: false,
    paperExitOrderId: 'x0', paperExitReason: 'QF_DEADLINE', paperExitLeg: 'qf_deadline', exitWork: { kind: 'exit', reason: 'QF_DEADLINE', limit: 6.0, step: 4, stepAt: T(15, 40), placedAt: T(15, 40) } });
  L.updatePositions((p) => (p.id === sized.id ? Object.assign(p, { openedAt: T(15, 30) }) && true : false)); // opened on the test day (Phase 89c: the deadline is that day's 3:40 PM)
  od.freshQuote = (sym, maxAge) => (maxAge > 60e3 ? { bid: 4.8, ask: 4.9, quoteTime: T(15, 30), at: T(15, 30) } : null); // only a STALE quote exists
  const QX = require(S + 'execution/quickflip-exits');
  const quiet = () => ({ b5: [] });
  const r1 = await QX.run(L, { sessionFor: quiet }, T(15, 42, 10));
  check('3:42 PM, the close resting unfilled at a model price (no fresh quote): re-priced 25% under the LAST known bid 4.80 -> 3.60 (marketable, bounded)', r1.length === 1 && placed[placed.length - 1] === 3.6, JSON.stringify(placed));
  const r2 = await QX.run(L, { sessionFor: quiet }, T(15, 42, 20));
  check('...not re-placed again within 20 s', r2.length === 0 && placed.length === 1);
  await QX.run(L, { sessionFor: quiet }, T(15, 50, 30));
  check('...3:50 PM still unfilled: 50% under -> 2.40', placed[placed.length - 1] === 2.4, JSON.stringify(placed));
  od.freshQuote = () => null; require(S + 'execution/option-marks').saleValue = () => ({ value: 4.0 });
  const st = await require(S + 'execution/spread-exit').urgent(L, L.getActivePositions().find((p) => p.id === sized.id), ap.exitDeps(), 0.5, T(15, 52));
  check('...no quote at all: priced from the model value (4.00 -> 2.00), never left without an order', st.placed && st.limit === 2.0, JSON.stringify(st));
  // a closing order that filled 1 of 2 contracts books that part only
  const p2 = { ...L.getActivePositions().find((p) => p.id === sized.id) };
  L.updatePositions((p) => (p.id === sized.id ? Object.assign(p, { positionSize: 2, dollarRisk: p.dollarRisk * 2 }) && true : false));
  const tr = ap.book(L, L.getActivePositions().find((p) => p.id === sized.id), { orderId: 'x9', filledQty: 1, avgFillPrice: 4.7, terminal: true }, 'QF_DEADLINE', 'qf_deadline');
  const rest = L.getActivePositions().find((p) => p.id === sized.id);
  check('partial closing fill (1 of 2): the journal gets the 1 contract sold; 1 stays open with its exit cleared (retried)', tr && tr.positionSize === 1 && rest && rest.positionSize === 1 && !rest.paperExitOrderId && p2.id === sized.id, JSON.stringify([tr && tr.positionSize, rest && rest.positionSize]));

  // 5. Versioned pauses: Moonshots paused by 90 without re-pausing what the user switched on after 89.
  const tg = require(S + 'strategies/strategy-toggles');
  const after89 = tg.applyPause(89, { ...tg.DEFAULTS, 'equity-day': true, 'speculative-crypto': true });
  const fresh = tg.applyPause(0, Object.fromEntries(tg.IDS.map((id) => [id, true])));
  check('pause 90 (Moonshots) on a ledger past 89: Moonshots off, Equity Day (re-enabled by the user) stays on; an old ledger gets every pause; current: nothing', after89['speculative-crypto'] === false && after89['equity-day'] === true
    && tg.IDS.filter((id) => id !== 'options-quickflips').every((id) => fresh[id] === false) && tg.applyPause(90, {}) === null && tg.DEFAULTS['speculative-crypto'] === false);

  // 6. Audit attribution adds up (recorded net = signal + execution + discretion).
  const A = require(path.join(__dirname, '..', 'scripts', 'audit-attribution'));
  const stop = { strategyId: 'x', execution: 'LIVE', direction: 'long', fillPrice: 10, invalidation: 9, exitPrice: 8.9, positionSize: 2, fees: 0.1, grossPnl: -2.2, netPnl: -2.3, exitReason: 'STOP_LOSS', targets: [{ price: 12 }] };
  const a = A.attribute(stop, { flags: [], netAtNatural: null });
  check('attribution: a stop filled 0.10 under its level = signal -2.00, execution -0.30 (slippage 0.20 + fees 0.10), summing to the recorded -2.30', Math.abs(a.signal + 2) < 1e-9 && Math.abs(a.execution + 0.3) < 1e-9 && Math.abs(a.signal + a.execution - stop.netPnl) < 1e-9, JSON.stringify(a));

  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
