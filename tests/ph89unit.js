// Phase 89: research pause, daily profit target, combined exposure, Options Quick Flips (signals, rules, exits, entry timeout,
// partial fills, paper only) and realistic paper fills. Run: node tests/ph89unit.js. Scratch ledger in the OS temp dir, blank /
// fake keys, dead URLs; the only "network" is a stub answering Alpaca option snapshots from a local table.
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph89-'));
const DEAD = 'http://127.0.0.1:9';
const ENV = { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), PAPER_RUNS_PATH: path.join(DIR, 'runs.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKTEST', ALPACA_PAPER_API_SECRET: 'test', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: 'http://data.test', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD };
Object.assign(process.env, ENV);
const QUOTES = {}; // option symbol -> { bp, ap, t }
global.fetch = async (u) => {
  const m = /\/v1beta1\/options\/snapshots\?symbols=([^&]+)/.exec(String(u));
  if (!m) throw new Error(`test: no network (${String(u).slice(0, 50)})`);
  const snapshots = Object.fromEntries(decodeURIComponent(m[1]).split(',').filter((s) => QUOTES[s]).map((s) => [s, { latestQuote: QUOTES[s] }]));
  return { ok: true, status: 200, text: async () => JSON.stringify({ snapshots }) };
};
const quote = (sym, bp, ap, ageMs = 2000) => { QUOTES[sym] = { bp, ap, t: new Date(Date.now() - ageMs).toISOString() }; };
const OLD_MAP = Object.fromEntries(['crypto-swing', 'crypto-intraday', 'speculative-crypto', 'equity-day', 'equity-swing', 'options-system'].map((id) => [id, true]));
fs.writeFileSync(ENV.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 10000, cryptoBankroll: 5000, stockMode: 'paper', cryptoMode: 'paper', paperStockBroker: 'internal',
  radarVersion: 1, strategiesEnabled: OLD_MAP }, pendingOrders: [], activePositions: [], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const et = require(S + 'services/et-time');
const T = (h, m) => et.toEpoch('2026-10-07', h, m); // a Wednesday
const qfPos = (x = {}) => ({ id: `options-quickflips:S1:CALL:SPY:${x.k || 1}`, asset: 'SPY', market: 'options', strategyId: 'options-quickflips', direction: 'long', execution: 'PAPER', sizingBasis: 'paper',
  positionSize: 1, fillPrice: 770, entryPrice: 770, invalidation: 768, dollarRisk: 158, openedAt: T(10, 0), entryZone: { min: 769, max: 771 }, targets: [{ level: 1, price: 772, allocation: 1 }],
  optionsData: { underlying: 'SPY', type: 'call', structure: 'single', fill: 'single', contract: 'SPY261013C00770000', strike: 770, expiration: '2026-10-13', multiplier: 100, debit: 5.1, netMid: 5.05,
    combinedLegSpread: 0.1, legs: [{ side: 'buy', contract: 'SPY261013C00770000', ratio: 1, bid: 5, ask: 5.1 }], exitRule: { stopValue: 3.57, targetValue: 7.4 }, riskPerShare: 1.53,
    quickFlip: { setup: 'S1', signalEndMin: 590, trigger: 769.5, vwap: 768, maxHoldMin: 60, deadlineMin: 940 }, entryTimeoutMs: 180000 }, ...x });

(async () => {
  const L = require(S + 'execution/paper-ledger');
  // 1. Research pause (applied once to an old ledger; the user's re-enable sticks).
  const map = L.getSettings().strategiesEnabled;
  check('research pause: Crypto Intraday, Equity Day, Equity Swing (unvalidated) and Options Spreads / Crypto Swing (lost in replay, the user had them ON) switched OFF in an old ledger; Moonshots too (Phase 89b pause 90); Quick Flips OFF (Quick Flips ON by the Phase 91 radar default)',
    !map['crypto-intraday'] && !map['equity-day'] && !map['equity-swing'] && !map['options-system'] && !map['crypto-swing'] && map['speculative-crypto'] === false && map['options-quickflips'] === true && L.getSettings().strategyPauseVersion === 90, JSON.stringify(map));
  L.updateSettings({ strategiesEnabled: { ...map, 'equity-day': true } });
  const reread = JSON.parse(execFileSync(process.execPath, ['-e', `require(${JSON.stringify(S + 'execution/paper-ledger')}); console.log(JSON.stringify(require(${JSON.stringify(S + 'execution/paper-ledger')}).getSettings().strategiesEnabled))`],
    { env: { ...process.env, ...ENV }, encoding: 'utf8' }).trim().split('\n').pop());
  check('...the pause runs once: a strategy the user switched back on stays on after a restart', reread['equity-day'] === true && reread['crypto-intraday'] === false, JSON.stringify(reread));

  // 2. Quick Flips signals (the frozen S1 rule) on a synthetic session.
  const sig = require(S + 'strategies/quickflips-signals');
  const prior = Array.from({ length: 20 }, (_, d) => ({ closes5m: Array.from({ length: 78 }, (_, k) => 99 + d * 0.01 + k * 0.001), vols5m: new Array(78).fill(1000) }));
  const mk = (closeAt20 = 100.9) => { const t = []; for (let m = 0; m < 25; m += 1) { const c = m < 15 ? 100 + (m % 3) * 0.2 : m < 20 ? 100.8 : closeAt20; t.push({ min: 570 + m, o: c, h: Math.max(c, m < 15 ? 100.5 : c), l: m < 15 ? 100 : c - 0.05, c, v: m < 15 ? 200 : 1500 }); } return sig.slots(t); };
  let today = mk(); let s = sig.build(prior, today);
  const sigs = sig.detect(s, today);
  check('S1: the first 5m close above the opening range and VWAP on >= 1.2x relative volume -> a CALL signal at the 9:50 close, decided at 9:51', sigs.length === 1 && sigs[0].setup === 'S1' && sigs[0].dir === 'long' && sigs[0].endMin === 590 && sigs[0].D === 21 && !sigs[0].skip, JSON.stringify(sigs[0]));
  today = mk(100.4); s = sig.build(prior, today);
  check('...confirmation: the 9:50 minute closed back under the OR high -> skipped ("confirmation failed")', sig.detect(s, today)[0].skip === 'confirmation failed');
  check('...fewer than 20 prior sessions: no RelVol, no signal', sig.detect(sig.build(prior.slice(5), mk()), mk()).length === 0);
  check('setup failure: a later 5m close under VWAP is found; one at / before the entry minute is not', !!sig.failed({ b5: [{ endMin: 605, c: 99, vwap: 100 }] }, 'long', 600) && !sig.failed({ b5: [{ endMin: 600, c: 99, vwap: 100 }] }, 'long', 600));

  // 3. The candidate and the risk engine (existing limits: 2% risk, 1.25x tolerance, 6% max debit).
  const qf = require(S + 'strategies/7-options-quickflips');
  const pick = (ask) => ({ contract: { symbol: 'SPY261013C00770000', expiration: '2026-10-13', strike: 770, dte: 6, iv: 0.15, delta: 0.52 }, quote: { bid: ask - 0.1, ask, quoteTime: T(9, 51), delta: 0.52 }, mid: ask - 0.05 });
  const cand = qf.candidate('SPY', { setup: 'S1', dir: 'long', endMin: 590, trigger: 769.5, vwap: 768, spot: 770.2, relVol: 2 }, pick(5.1), T(9, 51), 'indicative');
  const { processCandidate } = require(S + 'risk/risk-engine');
  const sized = processCandidate(cand, 10000, { riskPct: 0.02 });
  check('Quick Flip candidate: single call at the ASK, -30% / +45% exits, sized by the existing risk engine (1 contract, 1R at the expected exit fill)',
    sized.approved && sized.positionSize === 1 && cand.optionsData.debit === 5.1 && cand.optionsData.exitRule.stopValue === 3.57 && cand.optionsData.exitRule.targetValue === 7.4 && Math.abs(sized.dollarRisk - 158) < 1, `${sized.reason || sized.dollarRisk}`);
  const dear = processCandidate(qf.candidate('SPY', { setup: 'S1', dir: 'long', endMin: 590, trigger: 769.5, vwap: 768, spot: 770.2, relVol: 2 }, pick(8.5), T(9, 51), 'indicative'), 10000, { riskPct: 0.02 });
  check('...an $850 contract on a $10,000 bankroll is refused by the existing 6% cap (no limit was loosened for the new mode)', !dear.approved && /OPTIONS_RISK_EXCEEDS_CAP/.test(dear.reason), dear.reason);

  // 4. Quick Flips entry rules.
  const R = require(S + 'risk/quickflip-rules');
  const ord = { ...qfPos(), id: 'new', stagedAt: T(10, 30) };
  const J = (x) => ({ ...qfPos(x), closedAt: x.closedAt, exitReason: x.exitReason || 'TAKE_PROFIT', rMultiple: x.r ?? 1 });
  check('rules: a clean paper Quick Flip at 10:30 is allowed', R.reason(ord, { now: T(10, 30), fomc: [] }) === null);
  check('rules: LIVE refused (paper only)', /QUICKFLIPS_PAPER_ONLY/.test(R.reason({ ...ord, execution: 'LIVE', sizingBasis: 'alpaca-live' }, { now: T(10, 30), fomc: [] })));
  check('rules: 9:40 and 2:40 PM are outside the window; FOMC day after 1:30 PM refused', /WINDOW/.test(R.reason(ord, { now: T(9, 40), fomc: [] })) && /WINDOW/.test(R.reason(ord, { now: T(14, 40), fomc: [] }))
    && /FOMC/.test(R.reason(ord, { now: T(13, 45), fomc: ['2026-10-07'] })));
  check('rules: one per symbol; at most 2 open', /SYMBOL_BUSY/.test(R.reason(ord, { positions: [qfPos()], now: T(10, 30), fomc: [] }))
    && /MAX_OPEN/.test(R.reason({ ...ord, asset: 'IWM' }, { positions: [qfPos({ asset: 'QQQ', k: 2 })], pending: [{ ...qfPos({ asset: 'DIA', k: 3 }) }], now: T(10, 30), fomc: [] })));
  check('rules: 3 entries a symbol a day', /DAILY_ENTRIES/.test(R.reason(ord, { journal: [1, 2, 3].map((k) => J({ k, openedAt: T(10, 0), closedAt: T(10, 5) })), now: T(11, 30), fomc: [] })));
  check('rules: 15-minute cooldown after an exit on the symbol', /COOLDOWN/.test(R.reason(ord, { journal: [J({ closedAt: T(10, 25) })], now: T(10, 30), fomc: [] })));
  check('rules: stopped out -> no new entry that direction today (the other direction may)', /STOPPED_TODAY/.test(R.reason(ord, { journal: [J({ closedAt: T(10, 0), exitReason: 'STOP_LOSS', r: -1 })], now: T(10, 30), fomc: [] }))
    && R.reason({ ...ord, direction: 'short' }, { journal: [J({ closedAt: T(10, 0), exitReason: 'STOP_LOSS', r: -1 })], now: T(10, 30), fomc: [] }) === null);
  check('rules: -2R realized today -> no more Quick Flips', /DAILY_STOP/.test(R.reason({ ...ord, asset: 'QQQ' }, { journal: [J({ k: 7, closedAt: T(10, 0), r: -1.1 }), J({ k: 8, asset: 'SPY', closedAt: T(10, 1), r: -1 })], now: T(10, 30), fomc: [] })));
  const pacing = require(S + 'risk/option-pacing');
  const two = [1, 2].map((k) => ({ id: `o${k}`, asset: 'AAPL', market: 'options', strategyId: 'options-system', direction: 'long', execution: 'PAPER', sizingBasis: 'paper', openedAt: T(9, 40) }));
  check('swing-option pacing never blocks (or counts) Quick Flips; it still blocks a swing spread', pacing.pacingReason(ord, { positions: two, now: T(10, 30) }) === null && !!pacing.pacingReason({ ...two[0], id: 'o3' }, { positions: two, now: T(10, 30) }));

  // 5. Daily profit target (stops automated entries only; never resizes, forces or closes).
  const dl = require(S + 'risk/daily-loss'); const shields = require(S + 'risk/entry-shields');
  const won = [{ id: 'w1', execution: 'PAPER', netPnl: 210, closedAt: T(10, 0) }];
  const crypto = { id: 'speculative-crypto:X', asset: 'SOL-USD', market: 'crypto', strategyId: 'speculative-crypto', direction: 'long', execution: 'PAPER', sizingBasis: 'paper', dollarRisk: 5 };
  dl.reset(); dl.refresh({ journal: won, positions: [], settings: { dailyProfitTargetOn: false, dailyProfitTarget: 200 }, now: T(11, 0) });
  check('profit target OFF (the default): +$210 today changes nothing', shields.check(crypto, { now: T(11, 0) }) === null);
  const st = dl.refresh({ journal: won, positions: [], settings: { dailyProfitTargetOn: true, dailyProfitTarget: 200 }, now: T(11, 0) });
  const before = JSON.stringify(crypto);
  check('profit target ON: realized +$210 >= $200 -> DAILY_PROFIT_TARGET_REACHED for automated PAPER entries; the order is not modified',
    st.paper.target.reached && /DAILY_PROFIT_TARGET_REACHED/.test(shields.check(crypto, { now: T(11, 0) })) && JSON.stringify(crypto) === before);
  check('...manual orders and the LIVE book are not affected', shields.check({ ...crypto, id: 'manual:1' }, { now: T(11, 0) }) === null && shields.check({ ...crypto, execution: 'LIVE', sizingBasis: 'coinbase-live' }, { now: T(11, 0) }) === null);
  dl.refresh({ journal: won, positions: [], settings: { dailyProfitTargetOn: true, dailyProfitTarget: 300 }, now: T(11, 5) });
  check('...raising the target past today\'s realized P/L releases it', shields.check(crypto, { now: T(11, 5) }) === null);
  dl.reset();

  // 6. Combined options + crypto exposure, max open positions.
  const X = require(S + 'risk/exposure-limits');
  const set = { bankroll: 10000, cryptoBankroll: 5000, maxOpenRiskPct: 0.06 };
  const open = [{ id: 'op', market: 'options', strategyId: 'options-system', execution: 'PAPER', positionSize: 2, optionsData: { debit: 3, multiplier: 100 } },
    { id: 'cr', market: 'crypto', strategyId: 'speculative-crypto', execution: 'PAPER', dollarRisk: 250, fillPrice: 10, invalidation: 9, direction: 'long' }];
  check('combined risk: $600 option debit + $250 crypto + $100 new = $950 > 6% of $15,000 -> COMBINED_RISK_CAP; $40 new fits', /COMBINED_RISK_CAP/.test(X.check({ ...crypto, dollarRisk: 100 }, { positions: open, settings: set }))
    && X.check({ ...crypto, dollarRisk: 40 }, { positions: open, settings: set }) === null);
  check('max open positions (paper): 2 automated open, max 2 -> refused; manual / live positions do not count', /MAX_OPEN_POSITIONS/.test(X.check({ ...crypto, dollarRisk: 1 }, { positions: open, settings: { ...set, maxOpenPositions: 2 } }))
    && X.check({ ...crypto, dollarRisk: 1 }, { positions: [open[0], { ...open[1], id: 'manual:9' }, { ...open[1], id: 'l', execution: 'LIVE' }], settings: { ...set, maxOpenRiskPct: 0.5, maxOpenPositions: 2 } }) === null);

  // 7. Realistic paper fills.
  const F = require(S + 'execution/paper-fills');
  require(S + 'connectors/coinbase-socket').getLatest = (p) => (p ? { bid: 99.9, ask: 100.1, price: 100, time: new Date().toISOString() } : {});
  const cf = await F.price({ market: 'crypto', direction: 'long', asset: 'SOL-USD' }, 100);
  check('paper crypto buy: filled at the best ASK and pays the TAKER fee (no free maker fill at the last price)', cf.fillPrice === 100.1 && cf.extra.entryLiquidity === 'taker', JSON.stringify(cf));
  quote('AAA261016C00100000', 2.0, 2.2); quote('AAA261016C00105000', 1.0, 1.1);
  const spreadOd = { legs: [{ side: 'buy', contract: 'AAA261016C00100000', ratio: 1 }, { side: 'sell', contract: 'AAA261016C00105000', ratio: 1 }], debit: 1.1, netMid: 1.05, combinedLegSpread: 0.3, multiplier: 100, fill: 'package' };
  const sf = await F.price({ market: 'options', strategyId: 'options-system', optionsData: spreadOd }, 100);
  check('paper spread buy: at the NATURAL price 2.20 - 1.00 = 1.20 (the old model paid 1.095)', sf.extra.optionsData.debit === 1.2 && sf.extra.optionsData.plannedDebit === 1.1, JSON.stringify(sf.extra.optionsData.debit));
  const ef = await F.price({ market: 'options', strategyId: 'options-system', optionsData: { ...spreadOd, legs: [{ side: 'buy', contract: 'ZZZ261016C00001000', ratio: 1 }] } }, 100);
  check('...no fresh quote: the natural ESTIMATE, net mid + half the legs\' bid/ask (1.20)', ef.extra.optionsData.debit === 1.2 && /estimate/.test(ef.extra.optionsData.paperFillBasis));
  quote('SPY261013C00771000', 5.0, 5.1, 10 * 60000);
  let stale = ''; try { await F.price({ market: 'options', strategyId: 'options-quickflips', optionsData: { ...qfPos().optionsData, legs: [{ side: 'buy', contract: 'SPY261013C00771000', ratio: 1 }] } }, 770); } catch (e) { stale = e.message; }
  check('stale quote (10 min old): a Quick Flip is NOT filled (QUICKFLIPS_STALE_QUOTE)', /QUICKFLIPS_STALE_QUOTE/.test(stale), stale);
  const marks = require(S + 'execution/option-marks');
  const sv = marks.saleValue({ market: 'options', optionsData: { ...spreadOd, expiration: '2026-10-16' } }, 100);
  check('paper spread SALE value: the natural bid 2.00 - 1.10 = 0.90 (was mid - 0.15 x combined = 1.005)', Math.abs(sv.value - 0.9) < 1e-9 && Math.abs(sv.mid - 1.05) < 1e-9, JSON.stringify({ v: sv.value, m: sv.mid }));

  // 8. Quick Flips exits, entry timeout, partial fills, paper-only routing.
  const QX = require(S + 'execution/quickflip-exits');
  const quiet = () => ({ b5: [] });
  check('exits: 10:30 nothing; 11:01 QF_MAX_HOLD (60 min); 3:40 PM QF_DEADLINE; LIVE never', QX.due(qfPos(), T(10, 30), quiet) === null && QX.due(qfPos(), T(11, 1), quiet).reason === 'QF_MAX_HOLD'
    && QX.due(qfPos({ openedAt: T(15, 20) }), T(15, 40), quiet).reason === 'QF_DEADLINE' && QX.due(qfPos({ execution: 'LIVE' }), T(15, 41), quiet) === null);
  check('exits: a 5m close back under VWAP after the fill -> QF_SETUP_FAILED (puts: above VWAP); a working entry only meets the deadline', QX.due(qfPos(), T(10, 6), () => ({ b5: [{ endMin: 605, c: 767, vwap: 768 }] })).reason === 'QF_SETUP_FAILED'
    && QX.due(qfPos({ direction: 'short' }), T(10, 6), () => ({ b5: [{ endMin: 605, c: 769, vwap: 768 }] })).reason === 'QF_SETUP_FAILED' && QX.due(qfPos({ fillEstimated: true }), T(11, 1), quiet) === null);
  require(S + 'market/latest-prices').setPolled('SPY', 770, Date.now());
  const pos = { ...cand, ...sized, id: cand.id, execution: 'PAPER', fillPrice: 770.2, openedAt: T(15, 30), status: 'open' };
  L.stageOrder(sized);
  let dup = ''; try { L.stageOrder(sized); } catch (e) { dup = e.message; }
  check('duplicate staging of the same Quick Flip is refused', !!dup, dup);
  L.executeOrder(sized.id, 770.2, { openedAt: T(15, 30) }); L.updatePositions((p) => (p.id === pos.id ? Object.assign(p, { openedAt: T(15, 30) }) && true : false));
  quote('SPY261013C00770000', 5.3, 5.4); await require(S + 'connectors/options-data').refreshQuotes(['SPY261013C00770000']);
  const ran = await QX.run(L, { sessionFor: quiet }, T(15, 41));
  const t = L.getTradeJournal().find((x) => x.id === pos.id);
  check('exit near the close: run() at 3:41 PM closes the open Quick Flip (QF_DEADLINE) at the natural bid 5.30', ran.length === 1 && t && t.exitReason === 'QF_DEADLINE' && Math.abs(t.optionsExitValue - 5.3) < 1e-9 && !L.getActivePositions().some((p) => p.id === pos.id), JSON.stringify(t && [t.exitReason, t.optionsExitValue]));
  const SE = require(S + 'execution/spread-entry');
  const api = (st2) => ({ cancelOrder: async () => ({ ok: true }), getOrderStatus: async () => st2 });
  const work = { ...qfPos(), brokerId: 'b1', fillEstimated: true, entryWork: { placedAt: Date.now() - 200000, limit: 5.1 } };
  check('entry timeout: unfilled after 3 min -> canceled and voided ENTRY_UNFILLED', (await SE.work(work, {}, { api: api({ ok: true, terminal: true, filledQty: 0 }), place: null })).void === 'ENTRY_UNFILLED');
  check('...cancel race: it filled while canceling -> waits (synced next pass), never voided', (await SE.work(work, {}, { api: api({ ok: true, terminal: true, filledQty: 1 }), place: null })).action === 'waiting');
  check('...cancel not confirmed -> waits; before the timeout a Quick Flip is never re-priced (no chasing)', (await SE.work(work, {}, { api: api({ ok: true, terminal: false, filledQty: 0 }), place: null })).action === 'waiting'
    && (await SE.work({ ...work, entryWork: { placedAt: Date.now() - 60000, limit: 5.1 } }, {}, { api: api({}), place: () => { throw new Error('re-priced'); } })) === null);
  const ap = require(S + 'execution/alpaca-paper'); const paperApi = require(S + 'connectors/alpaca-api').paper;
  const two2 = { ...qfPos({ k: 9, positionSize: 2, dollarRisk: 316, notional: 1020 }), paperBroker: 'alpaca', brokerId: 'b2', fillEstimated: true, entryWork: { placedAt: Date.now() - 30000, limit: 5.1 } };
  L.stageOrder(processCandidate({ ...cand, id: two2.id }, 10000, { riskPct: 0.02 })); L.executeOrder(two2.id, 770, two2); // 2 contracts ordered
  paperApi.getOrderStatus = async () => ({ ok: true, terminal: false, filledQty: 1, avgFillPrice: 5.15, status: 'partially_filled' });
  const w1 = await ap.reconcileOwn(L.getActivePositions().find((p) => p.id === two2.id), L);
  check('partial fill still working: stays a WORKING order (not booked as 2 contracts)', L.getActivePositions().find((p) => p.id === two2.id).fillEstimated === true && w1.action !== 'synced', w1.action);
  paperApi.getOrderStatus = async () => ({ ok: true, terminal: true, filledQty: 1, avgFillPrice: 5.15, status: 'canceled' });
  const w2 = await ap.reconcileOwn(L.getActivePositions().find((p) => p.id === two2.id), L);
  const p2 = L.getActivePositions().find((p) => p.id === two2.id);
  check('partial fill then canceled: the position is what Alpaca filled (1 of 2), 1R and debit follow the broker', w2.partial === '1 of 2' && p2.positionSize === 1 && Math.abs(p2.dollarRisk - 158) < 1e-6 && p2.optionsData.debit === 5.15, JSON.stringify(w2));
  L.updateSettings({ stockMode: 'live' });
  let live = ''; try { await require(S + 'execution/order-router').routeApproved({ ...sized, id: 'qf-live' }, 770); } catch (e) { live = e.message; }
  L.updateSettings({ stockMode: 'paper' });
  check('paper only: a Quick Flip routed while stocks / options are LIVE is refused before anything is sent', /QUICKFLIPS_PAPER_ONLY/.test(live), live);
  const out = await qf.generateCandidates(T(10, 30), { stockMode: 'live' });
  check('...and the strategy proposes nothing while the options book is LIVE, or while the market is closed', out.length === 0 && (await qf.generateCandidates(T(20, 0), { stockMode: 'paper' })).length === 0);
  check('2-DTE time exit skips Quick Flips (they close the same day); 3-minute approval window', require(S + 'execution/time-exits').due(qfPos({ optionsData: { ...qfPos().optionsData, expiration: '2026-10-08' } }), T(11, 0)) === null
    && require(S + 'execution/setup-ttl').ttlOf(cand) === 180000);

  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
