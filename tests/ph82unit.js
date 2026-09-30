// Phase 82: options liquidity defense. Run: node tests/ph82unit.js. Scratch fixtures (OS temp dir), blank broker keys,
// dead broker URLs: no network, no orders. Controlled spread values (option-marks.saleValue) and a controlled clock.
//   1. the 3:45 PM lockout: a stop / target hit after 3:45 PM is held overnight and sold at 9:35 AM ET; manual closes
//      always work; in-window exits are immediate; the Alpaca Paper path is gated the same way
//   2. OPTIONS_SPREAD_TOO_WIDE: net bid / ask over 25% of the mid is refused at staging / approval
//   3. AUTO_CLOSE_2_DTE: from 10:00 AM ET, within 2 calendar or trading days of expiry, profit or loss
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph82-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'watch.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'ext.json'),
  CREDENTIALS_PATH: path.join(DIR, 'vault.json'), RADAR_CACHE_PATH: path.join(DIR, 'radar.json'), CATALYSTS_PATH: path.join(DIR, 'catalysts.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: '', ALPACA_PAPER_API_SECRET: '', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, FINNHUB_API_KEY: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '' });
const spread = (id, asset, o = {}) => ({ id, asset, market: 'options', strategyId: 'options-system', direction: 'long', execution: 'PAPER', sizingBasis: 'paper', positionSize: 1, fillPrice: 100,
  entryPrice: 100, invalidation: 0, dollarRisk: 125, openedAt: Date.parse('2026-09-28T15:00:00Z'), entryLiquidity: 'taker',
  optionsData: { underlying: asset, type: 'call', structure: 'vertical', fill: 'package', debit: 2.5, width: 5, multiplier: 100, expiration: '2026-10-16',
    legs: [{ side: 'buy', type: 'call', strike: 100, ratio: 1, contract: `${asset}261016C00100000` }, { side: 'sell', type: 'call', strike: 105, ratio: 1, contract: `${asset}261016C00105000` }],
    exitRule: { stopValue: 1.25, targetValue: 4.25 } }, ...o });
fs.writeFileSync(process.env.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 3000, cryptoBankroll: 3000, stockMode: 'paper', cryptoMode: 'paper', paperStockBroker: 'internal' },
  pendingOrders: [], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [], activePositions: [
    spread('opt:GOOGL:late-stop', 'GOOGL'), spread('opt:MSFT:late-target', 'MSFT'), spread('opt:JPM:midday', 'JPM'), spread('opt:NVDA:manual', 'NVDA'),
    spread('opt:AMD:alpaca', 'AMD', { paperBroker: 'alpaca' }), spread('opt:SOFI:2dte', 'SOFI', { optionsData: { ...spread('x', 'SOFI').optionsData, expiration: '2026-10-02' } })] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

const value = new Map(); // position id -> the spread's value per share now
const om = require(S + 'execution/option-marks');
om.saleValue = (p) => (value.has(p.id) ? { value: value.get(p.id), mid: value.get(p.id), basis: 'mid' } : null); // before exit-quote / exit-monitor load
let clock = Date.now();
const realNow = Date.now;
Date.now = () => clock;
const et = require(S + 'services/et-time');
const at = (ymd, h, m) => et.toEpoch(ymd, h, m);

(async () => {
  const ledger = require(S + 'execution/paper-ledger');
  const prices = require(S + 'market/latest-prices');
  const win = require(S + 'execution/options-exit-window');
  const tick = (ms) => { clock = ms; for (const a of ['GOOGL', 'MSFT', 'JPM', 'NVDA', 'AMD', 'SOFI']) prices.setPolled(a, 100, ms); };
  const run = () => ledger.monitorPositions(prices.getLatestPrices()).map((t) => `${t.asset} ${t.exitReason}`);
  const open = (id) => ledger.getActivePositions().find((p) => p.id === id);
  const booked = (id) => ledger.getTradeJournal().find((t) => t.id === id);

  // ---------- 1. the window ----------
  const w = (h, m) => win.inWindow(at('2026-10-01', h, m));
  check('window (Thu 10/01): 9:30 and 9:34 closed; 9:35 open; 3:44 PM open; 3:45 PM closed; Saturday closed', !w(9, 30) && !w(9, 34) && w(9, 35) && w(15, 44) && !w(15, 45) && !win.inWindow(at('2026-10-03', 12, 0)));
  check('ET conversion per date: 3:45 PM EDT = 19:45 UTC (Oct); 3:45 PM EST = 20:45 UTC (Nov)', new Date(at('2026-10-01', 15, 45)).toISOString() === '2026-10-01T19:45:00.000Z'
    && new Date(at('2026-11-05', 15, 45)).toISOString() === '2026-11-05T20:45:00.000Z');

  // 3:52 PM: GOOGL through its stop (value 0.90 < 1.25), MSFT at its target (4.40 >= 4.25): both HELD.
  value.set('opt:GOOGL:late-stop', 0.9); value.set('opt:MSFT:late-target', 4.4);
  tick(at('2026-10-01', 15, 52)); const a1 = run();
  tick(at('2026-10-01', 15, 53)); const a2 = run(); // the stop's 2nd confirmation
  check('3:52 PM: a stop breach and a target hit are NOT sold (no late-day market order); both held with the exit recorded', a1.length === 0 && a2.length === 0 && !!open('opt:GOOGL:late-stop')
    && open('opt:GOOGL:late-stop').deferredExit.reason === 'STOP_LOSS' && open('opt:MSFT:late-target').deferredExit.reason === 'TAKE_PROFIT', JSON.stringify(open('opt:GOOGL:late-stop').deferredExit));
  const saved = JSON.parse(fs.readFileSync(process.env.LEDGER_STATE_PATH, 'utf8')).activePositions.find((p) => p.id === 'opt:GOOGL:late-stop');
  check('the held exit is saved in the ledger file (survives a restart overnight)', saved && saved.deferredExit && saved.deferredExit.reason === 'STOP_LOSS');
  const man = ledger.closePosition('opt:NVDA:manual', 100, 'MANUAL_CLOSE');
  check('3:55 PM: a MANUAL close still works (it never passes the window)', man && man.exitReason === 'MANUAL_CLOSE' && !open('opt:NVDA:manual'));
  value.set('opt:JPM:midday', 0.8);
  tick(at('2026-10-01', 20, 0)); run(); tick(at('2026-10-01', 20, 1)); const night = run();
  check('8 PM (market closed): nothing sold and no new held exit (overnight marks are models); JPM re-checked at the open', night.length === 0 && !open('opt:JPM:midday').deferredExit);
  tick(at('2026-10-02', 9, 31)); const early = run(); tick(at('2026-10-02', 9, 32)); run();
  check('9:31 AM next day (opening quotes wide): still held; JPM, through its stop at 9:31, is held for 9:35 too', early.length === 0 && !!open('opt:GOOGL:late-stop') && open('opt:JPM:midday').deferredExit
    && open('opt:JPM:midday').deferredExit.reason === 'STOP_LOSS');
  value.set('opt:GOOGL:late-stop', 1.6); // recovered overnight: the stop was hit, the plan is to be out
  tick(at('2026-10-02', 9, 35)); const morning = run();
  const g = booked('opt:GOOGL:late-stop');
  check('9:35 AM: the held exits execute (GOOGL STOP_LOSS, MSFT TAKE_PROFIT, JPM STOP_LOSS), the journal keeps when the stop was hit', morning.includes('GOOGL STOP_LOSS') && morning.includes('MSFT TAKE_PROFIT')
    && morning.includes('JPM STOP_LOSS') && g && g.deferredExit && et.clock(g.deferredExit.at) === '3:53 PM ET', morning.join(', ')); // the stop's 2nd confirmation (3:53) records it
  const mid = spread('opt:QQQ:noon', 'QQQ');
  value.set('opt:AMD:alpaca', 0.5);
  const ap = require(S + 'execution/alpaca-paper');
  tick(at('2026-10-02', 15, 50)); await ap.exits(ledger); tick(at('2026-10-02', 15, 51)); const apOut = await ap.exits(ledger);
  check('Alpaca Paper spreads are gated the same way: a 3:50 PM stop sends no closing order, it is held for 9:35 AM', apOut.length === 0 && open('opt:AMD:alpaca').deferredExit
    && open('opt:AMD:alpaca').deferredExit.reason === 'STOP_LOSS');
  check('in the window the gate passes an exit straight through (11:00 AM stop = sold now)', win.gate(mid, 'STOP_LOSS', at('2026-10-05', 11, 0)) === 'STOP_LOSS' && win.gate(mid, null, at('2026-10-05', 11, 0)) === null);
  const ctx = fs.readFileSync(path.join(__dirname, '..', 'client', 'components', 'trade-context.js'), 'utf8');
  check('the position panel says so ("... after the 3:45 PM cutoff ...: sells at 9:35 AM ET")', /after the 3:45 PM cutoff/.test(ctx) && /sells at 9:35 AM ET/.test(ctx));

  // ---------- 2. OPTIONS_SPREAD_TOO_WIDE ----------
  const shields = require(S + 'risk/entry-shields');
  const setup = (legs) => ({ id: `options-system:X:${Math.random()}`, asset: 'KO', market: 'options', strategyId: 'options-system', sizingBasis: 'paper', direction: 'long', optionsData: { legs } });
  const ex = shields.optionsSpreadReason(setup([{ side: 'buy', bid: 1.0, ask: 1.3 }]));
  const tsla = setup([{ side: 'buy', ratio: 1, bid: 12.48, ask: 12.85 }, { side: 'sell', ratio: 1, bid: 10.13, ask: 10.28 }]);
  const wide = setup([{ side: 'buy', ratio: 1, bid: 3.1, ask: 3.6 }, { side: 'sell', ratio: 1, bid: 1.6, ask: 2.0 }]);
  check('bid 1.00 / ask 1.30: 0.30 wide = 26% of the 1.15 mid (> 25%) -> OPTIONS_SPREAD_TOO_WIDE', /^OPTIONS_SPREAD_TOO_WIDE: net bid 1\.00 \/ ask 1\.30 is 0\.30 wide = 26% of its 1\.15 mid \(max 25%\)/.test(ex || ''), ex);
  const tw = shields.spreadWidth(tsla.optionsData);
  check('a real vertical (TSLA 372.5/367.5 put legs): net 2.20 / 2.72 = 21% of the 2.46 mid: allowed', Math.abs(tw.bid - 2.2) < 1e-9 && Math.abs(tw.ask - 2.72) < 1e-9 && shields.optionsSpreadReason(tsla) === null, `${Math.round(tw.pct * 100)}%`);
  const wr = shields.check(wide, { positions: [], pending: [], settings: ledger.getSettings(), now: at('2026-10-05', 11, 0) });
  check('the entry shield refuses a wide vertical at staging / approval (net 1.10 / 2.00 = 58% of the 1.55 mid); stocks and manual tickets untouched', /^OPTIONS_SPREAD_TOO_WIDE: .*58% of its 1\.55 mid/.test(wr || '')
    && shields.optionsSpreadReason({ market: 'stocks' }) === null && shields.check({ ...wide, id: 'manual:1' }, { settings: ledger.getSettings() }) === null, wr);
  check('...and it shows in the rejection breakdown', /^OPTIONS_SPREAD_TOO_WIDE/.test(require(S + 'execution/rejection-stats').bucket(wr)));

  // ---------- 3. AUTO_CLOSE_2_DTE ----------
  const tx = require(S + 'execution/time-exits');
  const two = open('opt:SOFI:2dte'); // expires Fri 10/02
  check('Wed 9/30 (2 DTE): 9:59 AM held; 10:00 AM AUTO_CLOSE_2_DTE; 3:45 PM (window closed) held; Tue 9/29 (3 DTE) held', tx.due(two, at('2026-09-30', 9, 59)) === null
    && tx.due(two, at('2026-09-30', 10, 0)).reason === 'AUTO_CLOSE_2_DTE' && tx.due(two, at('2026-09-30', 15, 45)) === null && tx.due(two, at('2026-09-29', 11, 0)) === null);
  const mon = { ...two, optionsData: { ...two.optionsData, expiration: '2026-10-05' } };
  check('a Monday expiry closes the Thursday before (2 trading days) - never held into expiry morning; weekends never act', tx.due(mon, at('2026-10-01', 10, 30)).reason === 'AUTO_CLOSE_2_DTE'
    && tx.due(mon, at('2026-09-30', 10, 30)) === null && tx.due(mon, at('2026-10-03', 10, 30)) === null);
  value.set('opt:SOFI:2dte', 3.9); // in profit: closed anyway
  tick(at('2026-09-30', 10, 0));
  const out = await tx.run(ledger, {}, at('2026-09-30', 10, 0));
  const sofi = booked('opt:SOFI:2dte');
  check('run() at 10:00 AM: the 2 DTE spread is closed AUTO_CLOSE_2_DTE even in profit (pin / gamma risk)', out.some((o) => o.reason === 'AUTO_CLOSE_2_DTE') && sofi && sofi.exitReason === 'AUTO_CLOSE_2_DTE' && sofi.netPnl > 0,
    sofi && `net ${sofi.netPnl.toFixed(2)}`);
  const live = { ...two, id: 'opt:LIVE', execution: 'LIVE', broker: 'Alpaca' };
  const lo = await tx.run({ getActivePositions: () => [live], closePosition: () => { throw new Error('must not close'); } }, {}, at('2026-09-30', 10, 5));
  check('a LIVE spread at 2 DTE is reported, never sold automatically', lo.length === 1 && lo[0].live === true);

  Date.now = realNow;
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exitCode = fails ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300).unref();
})().catch((e) => { Date.now = realNow; console.error(e); process.exit(1); });
