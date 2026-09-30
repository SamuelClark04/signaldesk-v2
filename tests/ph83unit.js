// Phase 83: options risk sizing, limit exits, loop parity, full-debit portfolio risk, paper / live kill switches.
// Run: node tests/ph83unit.js. Scratch fixtures (OS temp dir), blank broker keys and dead URLs; the Alpaca Paper API is a
// fake in memory (no network, no orders).
const fs = require('fs'); const os = require('os'); const path = require('path'); const vm = require('vm');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph83-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: '', ALPACA_PAPER_API_SECRET: '', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '' });
const leg = (side, strike, bid, ask) => ({ side, type: 'call', strike, ratio: 1, contract: `SPY261016C00${strike * 1000}`, bid, ask });
const LEGS = [leg('buy', 500, 3.0, 3.1), leg('sell', 502.5, 1.8, 1.9)]; // natural 1.10 / 1.30, mid 1.20, width 0.20
const od = (debit, stop, target, legs = LEGS) => ({ underlying: 'SPY', type: 'call', structure: 'vertical', fill: 'package', debit, width: 2.5, multiplier: 100, expiration: '2026-10-16',
  netMid: debit - 0.05, combinedLegSpread: 0.2, riskPerShare: debit - stop, valueAtStop: stop, valueAtTarget: target, exitRule: { stopValue: stop, targetValue: target }, legs });
const pos = { id: 'opt:SPY:alpaca', asset: 'SPY', market: 'options', strategyId: 'options-system', direction: 'long', execution: 'PAPER', paperBroker: 'alpaca', sizingBasis: 'paper',
  positionSize: 1, fillPrice: 500, entryPrice: 500, invalidation: 0, dollarRisk: 65, openedAt: Date.parse('2026-09-30T14:00:00Z'), optionsData: od(1.2, 0.65, 2.1), brokerId: 'entry-1', fillEstimated: false };
fs.writeFileSync(process.env.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 3000, cryptoBankroll: 3000, stockMode: 'paper', cryptoMode: 'live', riskProfile: 'aggressive', dailyLossLimit: 90 },
  pendingOrders: [], activePositions: [pos, { ...pos, id: 'opt:SPY:held', paperBroker: undefined }], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// A fake Alpaca Paper account: orders fill when their limit is at or under `fillAt` (the price a buyer pays now).
const broker = { orders: new Map(), bodies: [], fillAt: 0, n: 0 };
const alpacaApi = require(S + 'connectors/alpaca-api');
alpacaApi.paper.getClock = async () => ({ ok: true, isOpen: true });
alpacaApi.paper.request = async (p, { body } = {}) => { broker.bodies.push(body); const id = `o${++broker.n}`; broker.orders.set(id, { id, limit: Math.abs(Number(body.limit_price)), status: 'new' }); return { ok: true, body: { id, status: 'new' } }; };
alpacaApi.paper.cancelOrder = async (id) => { const o = broker.orders.get(id); if (o && o.status === 'new') o.status = 'canceled'; return { ok: true }; };
alpacaApi.paper.getOrder = async (id) => { const o = broker.orders.get(id); if (!o) return { ok: false, error: 'no order' };
  if (o.status === 'new' && o.limit <= broker.fillAt + 1e-9) o.status = 'filled';
  return { ok: true, orderId: id, status: o.status, terminal: o.status !== 'new', filledQty: o.status === 'filled' ? 1 : 0, avgFillPrice: o.status === 'filled' ? -o.limit : 0 }; };
const optionsData = require(S + 'connectors/options-data');
const quotes = new Map(LEGS.map((l) => [l.contract, { bid: l.bid, ask: l.ask }]));
optionsData.refreshQuotes = async () => { broker.quoteCalls = (broker.quoteCalls || 0) + 1; };
optionsData.freshQuote = (sym) => quotes.get(sym) || null;

(async () => {
  const ledger = require(S + 'execution/paper-ledger');
  const re = require(S + 'risk/risk-engine');
  const W = require(S + 'risk/option-spread-width');
  const cand = (o) => ({ id: `options-system:T:CALL:SPY:${Math.random()}`, asset: 'SPY', market: 'options', strategyId: 'options-system', setupType: 'Bull call spread', direction: 'long', timeframe: '1h',
    tradeType: 'Options Momentum', entryZone: { min: 500, max: 500.5 }, invalidation: 495, targets: [{ level: 1, price: 506, allocation: 1 }], thesis: 't', confirmationCriteria: ['t'],
    timestamp: new Date().toISOString(), catalyst: { type: 'technical', headline: 't', sentimentScore: 0 }, optionsData: o });
  const size = (o) => re.processCandidate(cand(o), 3000, { riskPct: 0.02, maxCapitalPct: 0.1, sizingBasis: 'paper' });

  // ---------- 1. strict options sizing ($3,000 at 2%: budget $60, max $75 = 1.25x, max cost $180 = 6%) ----------
  const tsla = od(2.54, 1.29, 4.32, [leg('buy', 500, 12.48, 12.85), leg('sell', 502.5, 10.13, 10.28)]);
  check('1R at the EXPECTED EXIT FILL: TSLA spread = debit 2.54 - (stop 1.29 - half the 0.52 bid/ask gap) = 1.51 / share, not the mid-based 1.25', near(W.expectedExitRisk(tsla), 1.51, 1e-9) && tsla.riskPerShare === 1.25);
  const ok = size(od(1.2, 0.55, 2.1)); // expected fill risk 1.20 - (0.55 - 0.10) = 0.75 -> $75... at the 1.25x edge
  const fit = size(od(1.2, 0.7, 2.1)); // 1.20 - (0.70 - 0.10) = 0.60 -> $60 = the budget
  check('a spread risking $60 at its expected fill (the 2% budget) and costing $120: 1 contract, dollarRisk $60 (not the $50 at the mid)', fit.approved && fit.positionSize === 1 && near(fit.dollarRisk, 60) && !fit.smallAccountCap, fit.reason);
  check('$75 of risk (exactly 1.25x the budget = 2.5%): still 1 contract, tagged "1 contract within 1.25x the risk budget"', ok.approved && ok.positionSize === 1 && near(ok.dollarRisk, 75) && ok.smallAccountCap && /1\.25x/.test(ok.smallAccountLabel), ok.reason);
  const over = size(od(1.2, 0.45, 2.1)); // 1.20 - (0.45 - 0.10) = 0.85 -> $85 > $75
  check('$85 of risk (2.8% > 2.5%): REJECTED OPTIONS_RISK_EXCEEDS_CAP (no 5.5% override any more)', !over.approved && /^OPTIONS_RISK_EXCEEDS_CAP: one contract risks \$85\.00/.test(over.reason || ''), over.reason);
  const costly = size(od(1.9, 1.45, 3.3, [leg('buy', 500, 3.7, 3.8), leg('sell', 502.5, 1.8, 1.9)])); // $190 cost > $180, risk small
  check('a $190 spread (6.3% of the bankroll > 6%): REJECTED OPTIONS_RISK_EXCEEDS_CAP even with little risk to its stop', !costly.approved && /^OPTIONS_RISK_EXCEEDS_CAP/.test(costly.reason || '') && /costs \$190\.00 \(max \$180\.00/.test(costly.reason), costly.reason);
  check('the old 1-contract override is gone from the code (no 5.5% / 12%); the builder caps match (6%, 1.25x)', !re.SMALL_ACCOUNT && re.OPTIONS_CAP.riskMultiple === 1.25 && re.OPTIONS_CAP.maxDebitPct === 0.06
    && !/0\.055|maxDebitPct: 0\.12/.test(fs.readFileSync(S + 'risk/risk-engine.js', 'utf8')) && require(S + 'strategies/options-spread-builder').CONFIG.smallCap.debitPct === 0.06);

  // Trade Amount override: never past 3% risk / 8% capital (options: 1.25x the budget / 6%), confirmed or not.
  const stock = re.processCandidate({ id: 'equity-swing:PULLBACK:KO:t', asset: 'KO', market: 'stocks', strategyId: 'equity-swing', setupType: 'Pullback', direction: 'long', timeframe: '1d',
    entryZone: { min: 99.8, max: 100 }, invalidation: 97, targets: [{ level: 1, price: 106, allocation: 0.5 }, { level: 2, price: 109, allocation: 0.5 }], thesis: 't', confirmationCriteria: ['t'],
    catalyst: { type: 'technical', headline: 't', sentimentScore: 0 }, timestamp: new Date().toISOString() }, 3000, { riskPct: 0.02, maxCapitalPct: 0.1, sizingBasis: 'paper' });
  const bigStock = re.resizeOrder(stock, 400, { confirmed: true });
  const bigOpt = re.resizeOrder(fit, 240, { confirmed: true });
  check('Trade Amount above the engine\'s size, CONFIRMED: $400 of a $3,000 stock book (13%) and 2 option contracts ($120 risk > $75) are refused AMOUNT_ABOVE_HARD_CAP',
    stock.approved && !bigStock.approved && /^AMOUNT_ABOVE_HARD_CAP/.test(bigStock.reason || '') && !bigOpt.approved && /^AMOUNT_ABOVE_HARD_CAP/.test(bigOpt.reason || ''), `${bigStock.reason} | ${bigOpt.reason}`);
  check('...a smaller amount still resizes freely', re.resizeOrder(stock, 200).approved);

  // ---------- 2. limit exits (spread-exit.js) against the fake broker ----------
  const SX = require(S + 'execution/spread-exit');
  const ap = require(S + 'execution/alpaca-paper');
  const deps = ap.exitDeps();
  const T0 = Date.parse('2026-10-01T15:00:00Z'); // Thu 11:00 AM ET
  const P = () => ledger.getActivePositions().find((p) => p.id === pos.id);
  const x0 = await SX.startExit(ledger, P(), 'STOP_LOSS', 'stop_loss', deps, T0);
  const b0 = broker.bodies[broker.bodies.length - 1];
  check('stop exit, step 0: a LIMIT at the NBBO mid 1.20 (never a market order); Alpaca mleg credit sent NEGATIVE (-1.20)', x0.pending && x0.limit === 1.2 && b0.type === 'limit' && b0.limit_price === '-1.20'
    && b0.order_class === 'mleg' && P().exitWork.kind === 'exit' && P().paperExitReason === 'STOP_LOSS', JSON.stringify(b0).slice(0, 160));
  const steps = [];
  for (const dt of [10, 15, 30, 45, 60, 75]) { const m = await SX.manage(ledger, P(), deps, T0 + dt * 1000); steps.push(m && m.stepped ? m.limit : m && m.floor ? 'floor' : '-'); }
  check('unfilled: re-priced every 15 s by 25% of the 0.20 gap: 1.15 -> 1.10 (natural bid) -> 1.05 -> 1.00, then no more steps (60 s)', steps.join(',') === '-,1.15,1.1,1.05,1,-', steps.join(','));
  check('...each re-price cancels the old order first (confirmed canceled), so only one close is ever working', [...broker.orders.values()].filter((o) => o.status === 'new').length === 1);
  const wide = { bid: 0.5, ask: 1.5, mid: 1.0, width: 1.0 };
  check('floor: never under 10% below the natural bid (bid 0.50: steps 1.00, 0.75, 0.50, 0.45, 0.45)', [0, 1, 2, 3, 4].map((k) => SX.stepLimit(wide, k)).join(',') === '1,0.75,0.5,0.45,0.45');
  broker.fillAt = 1.05;
  const filled = await SX.manage(ledger, P(), deps, T0 + 90 * 1000);
  const j = ledger.getTradeJournal().find((t) => t.id === pos.id);
  check('a fill books the trade STOP_LOSS at the net fill (1.00 credit: -$20 gross on the 1.20 debit)', filled && filled.trade && j && j.exitReason === 'STOP_LOSS' && near(j.optionsExitValue, 1.0, 1e-9) && near(j.grossPnl, -20, 1e-6), j && `${j.exitReason} ${j.optionsExitValue}`);

  // Targets rest at the broker; a stop cancels the target first; a target that already filled is booked instead.
  const p2 = { ...pos, id: 'opt:SPY:target', brokerId: 'entry-2' };
  const fake = { positions: [p2], getActivePositions() { return this.positions; }, updatePositions(f) { let n = 0; for (const p of this.positions) if (f(p)) n += 1; return n; } };
  broker.fillAt = 0;
  const t = await SX.placeTarget(fake, p2, deps, T0);
  const tb = broker.bodies[broker.bodies.length - 1];
  check('the take-profit RESTS at the broker as a limit at the target value (2.10 credit)', t && t.placed && tb.type === 'limit' && tb.limit_price === '-2.10' && fake.positions[0].exitWork.kind === 'target');
  const booked = []; const deps2 = { ...deps, book: (l, p, o, reason) => { booked.push(reason); return { id: p.id, exitReason: reason }; } };
  const s2 = await SX.startExit(fake, fake.positions[0], 'STOP_LOSS', 'stop_loss', deps2, T0 + 5000);
  check('a stop first CANCELS the resting target (confirmed), then sends its mid limit', s2.pending && broker.orders.get(t.brokerExitId).status === 'canceled' && fake.positions[0].exitWork.kind === 'exit' && booked.length === 0);
  const p3 = { ...pos, id: 'opt:SPY:raced', brokerId: 'entry-3' }; fake.positions.push(p3);
  const t3 = await SX.placeTarget(fake, p3, deps2, T0); broker.orders.get(t3.brokerExitId).status = 'filled';
  const s3 = await SX.startExit(fake, fake.positions[1], 'STOP_LOSS', 'stop_loss', deps2, T0 + 5000);
  check('...if the target filled first, it is booked TAKE_PROFIT and no stop order is sent', s3.trade && booked.includes('TAKE_PROFIT') && fake.positions[1].exitWork.kind === 'target');
  const single = await require(S + 'connectors/alpaca-options').closeSpread({ positionSize: 1, optionsData: { contract: 'SPY261016C00500000' } }, 'id', 0.85);
  const sb = broker.bodies[broker.bodies.length - 1];
  const none = await require(S + 'connectors/alpaca-options').closeSpread({ positionSize: 1, optionsData: { contract: 'X' } }, 'id', null);
  check('a single contract: a plain sell LIMIT at +0.85; no limit price -> refused (market orders are not used at all)', single.ok && sb.type === 'limit' && sb.side === 'sell' && sb.limit_price === '0.85' && !none.ok);

  // ---------- 3. loop parity: Alpaca option exits every 5 s, quotes every 12 s ----------
  const ep = require(S + 'execution/exit-pass');
  let exitCalls = 0;
  ap.exits = async () => { exitCalls += 1; return []; };
  broker.quoteCalls = 0;
  const L = require(S + 'execution/paper-ledger');
  const had = L.getActivePositions().length;
  const ticks = [];
  for (let k = 0; k < 6; k += 1) ticks.push(await ep.fastOptions(() => {}, T0 + k * 5000));
  check('the fast loop runs every 5 s (FAST_EXIT_MS) and checks Alpaca option exits on EVERY tick (6 ticks = 6 checks)', ep.FAST_EXIT_MS === 5000 && had > 0 && exitCalls === 6, `${exitCalls} exit checks / ${had} open`);
  check('held option legs re-quoted every 12 s in market hours (ticks 0-25 s: quoted at 0 and 15 s)', ep.QUOTE_REFRESH_MS === 12000 && broker.quoteCalls === 2
    && ticks.map((x) => (x.quoted ? 'Q' : '.')).join('') === 'Q..Q..', ticks.map((x) => (x.quoted ? 'Q' : '.')).join(''));
  check('fastTick drives the option exits too (not only the 60 s pass)', /fastOptionsRun = fastOptions\(/.test(fs.readFileSync(S + 'execution/exit-pass.js', 'utf8')));

  // ---------- 4. portfolio risk counts an option's WHOLE debit ----------
  const PR = require(S + 'risk/portfolio-risk');
  const open = { ...pos, id: 'o1', positionSize: 2, dollarRisk: 130 };
  check('an open 2-contract $1.20 spread counts $240 (its whole debit), not its $130 stop risk', PR.riskOf(open) === 240);
  const block = PR.check({ ...fit, market: 'options' }, { positions: [open, { ...open, id: 'o2' }], bankroll: 3000, settings: { maxOpenRiskPct: 0.15 } });
  check('with a 15% ceiling ($450): $480 already committed + this $120 debit -> PORTFOLIO_RISK_CAP', /^PORTFOLIO_RISK_CAP: \$480\.00 already at risk on open trades \+ \$120\.00/.test(block || ''), block);

  // ---------- 5. separate paper / live kill switches ----------
  const daily = require(S + 'risk/daily-loss');
  const sh = require(S + 'risk/entry-shields');
  check('settings: Phase 81\'s dailyLossLimit ($90 here) became the PAPER limit; the live limit defaults to $25', L.getSettings().dailyLossLimitPaper === 90 && L.getSettings().dailyLossLimitLive === 25
    && L.getSettings().dailyLossLimit === undefined);
  const now = Date.now();
  const k = daily.refresh({ journal: [{ execution: 'PAPER', closedAt: now - 1000, netPnl: -289.15 }, { execution: 'LIVE', closedAt: now - 1000, netPnl: -4.1 }], positions: [], settings: L.getSettings(), now });
  const paperSetup = { id: 'options-system:x', market: 'options', strategyId: 'options-system', sizingBasis: 'paper', asset: 'KO' };
  const liveSetup = { id: 'speculative-crypto:x', market: 'crypto', strategyId: 'speculative-crypto', sizingBasis: 'okx-live', asset: 'AVT-USD' };
  check('a -$289 PAPER day trips only the paper switch: paper setups DAILY_LOSS_LIMIT_REACHED, LIVE crypto keeps trading', k.paper.active && !k.live.active
    && /^DAILY_LOSS_LIMIT_REACHED: today's paper P\/L -\$289\.15/.test(sh.check(paperSetup, { settings: L.getSettings() }) || '') && sh.check(liveSetup, { settings: L.getSettings() }) === null);
  const k2 = daily.refresh({ journal: [{ execution: 'LIVE', closedAt: now - 1000, netPnl: -26 }], positions: [], settings: L.getSettings(), now: now + 1000 });
  check('a -$26 LIVE day trips only the live switch ($25): live setups refused; the paper book is judged on paper trades alone', k2.live.active
    && /^DAILY_LOSS_LIMIT_REACHED: today's live P\/L/.test(sh.check(liveSetup, { settings: L.getSettings() }) || ''));
  const win = { SignalDesk: { ui: { el: (tag, p = {}, c = []) => ({ tag, ...p, children: [].concat(c) }), money: (x) => `$${Number(x).toFixed(2)}` } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'components', 'shield-banner.js'), 'utf8'), { window: win, document: { querySelectorAll: () => [] }, Date });
  const ban = win.SignalDesk.shieldBanner.content({ at: now, kill: { paper: { book: 'paper', active: true, limit: 150, pnl: -289.15 }, live: { book: 'live', active: false } }, macro: { enabled: true, upcoming: [] } });
  check('banner: "DAILY KILL SWITCH ACTIVE (Paper): -$150.00 loss limit reached" + "Live trading is not affected"', ban[1] === 'DAILY KILL SWITCH ACTIVE (Paper): -$150.00 loss limit reached' && /Live trading is not affected/.test(ban[2]), ban[1]);

  // ---------- 6. code health ----------
  const lines = (f) => fs.readFileSync(S + f, 'utf8').split('\n').length;
  check('split: 6-speculative-crypto.js and server.js have room again (< 280 / < 190 lines)', lines('strategies/6-speculative-crypto.js') < 280 && lines('server.js') < 190, `${lines('strategies/6-speculative-crypto.js')} / ${lines('server.js')}`);

  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exitCode = fails ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300).unref();
})().catch((e) => { console.error(e); process.exit(1); });
