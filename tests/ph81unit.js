// Phase 81: entry shields. Run: node tests/ph81unit.js. Scratch fixtures only (OS temp dir), every broker key blank and
// every broker / feed URL at a dead port BEFORE any server module loads: no network, no orders, no email, no server/data.
//   1. macro calendar: blackout boundaries (DST + EST), feed parsing, fail-open (timeout, bad JSON, broken state)
//   2. sector cap  3. daily loss kill switch (entries blocked, stops still close)  4. a real pipeline pass + approval
//   5. settings validation, rejection buckets, the client banner
const fs = require('fs'); const os = require('os'); const path = require('path'); const vm = require('vm');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph81-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'watch.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'ext.json'),
  CREDENTIALS_PATH: path.join(DIR, 'vault.json'), RADAR_CACHE_PATH: path.join(DIR, 'radar.json'), CATALYSTS_PATH: path.join(DIR, 'catalysts.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: '', ALPACA_PAPER_API_SECRET: '', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, FINNHUB_API_KEY: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '' });
const NOW = Date.now();
const T = (h) => NOW - h * 3600e3;
const pos = (o) => ({ market: 'options', direction: 'long', execution: 'PAPER', sizingBasis: 'paper', strategyId: 'options-system', positionSize: 1, fillPrice: 100, invalidation: 95, dollarRisk: 50, openedAt: T(30), ...o });
fs.writeFileSync(process.env.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 3000, cryptoBankroll: 3000, stockMode: 'paper', cryptoMode: 'paper', paperStockBroker: 'internal', maxOpenRiskPct: 0.45, maxEquityPerDirection: 10 },
  pendingOrders: [], activePositions: [pos({ id: 'options-system:AMZN:1', asset: 'AMZN', optionsData: { underlying: 'AMZN', type: 'call', structure: 'vertical', fill: 'package', debit: 2.5, width: 5, multiplier: 100, expiration: '2026-11-20',
    legs: [{ side: 'buy', type: 'call', strike: 250, ratio: 1, contract: 'AMZN261120C00250000' }, { side: 'sell', type: 'call', strike: 255, ratio: 1, contract: 'AMZN261120C00255000' }] } }), pos({ id: 'equity-swing:KO:1', asset: 'KO', market: 'stocks', strategyId: 'equity-swing', positionSize: 10, fillPrice: 60, invalidation: 57, dollarRisk: 30 })],
  tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
const C = path.join(__dirname, '..', 'client') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

(async () => {
  const et = require(S + 'services/et-time');
  const macro = require(S + 'services/macro-calendar');
  const shields = require(S + 'risk/entry-shields');
  const daily = require(S + 'risk/daily-loss');
  const ledger = require(S + 'execution/paper-ledger');
  const settings = () => ledger.getSettings();

  // ---------- 1. Macro News Shield ----------
  macro._setFeed([]);
  const cpi = et.toEpoch('2026-10-14', 8, 30); // built-in CPI release (EDT, UTC-4)
  const b = (ms) => macro.isMacroBlackoutActive(ms);
  check('CPI 10/14 8:30 AM ET is 12:30 UTC (EDT), FOMC 12/09 2:00 PM ET is 19:00 UTC (EST): wall times convert per date, never by the VM zone',
    new Date(cpi).toISOString() === '2026-10-14T12:30:00.000Z' && new Date(et.toEpoch('2026-12-09', 14, 0)).toISOString() === '2026-12-09T19:00:00.000Z');
  check('blackout boundaries: 31 min before off; 30 min before ON; at the release ON; 15 min after ON; 15 min 1 s after off',
    !b(cpi - 31 * 60e3).active && b(cpi - 30 * 60e3).active && b(cpi).active && b(cpi + 15 * 60e3).active && !b(cpi + 15 * 60e3 + 1000).active);
  const at = b(cpi - 10 * 60e3);
  check('inside: { active, event, releaseTime, resumesAt } = CPI at 8:30, resumes 8:45 AM ET', at.event === 'CPI' && at.releaseTime === cpi && at.resumesAt === cpi + 15 * 60e3 && et.clock(at.resumesAt) === '8:45 AM ET', JSON.stringify(at));
  check('built-in schedule: payrolls Fri 10/02 8:30, PCE 10/29 8:30, FOMC 10/28 2:00 PM ET all shielded', b(et.toEpoch('2026-10-02', 8, 20)).event === 'Non-Farm Payrolls'
    && b(et.toEpoch('2026-10-29', 8, 40)).event === 'PCE' && b(et.toEpoch('2026-10-28', 13, 45)).event === 'FOMC');
  const rows = [{ title: 'Core PCE Price Index m/m', country: 'USD', date: '2026-11-05T08:30:00-05:00', impact: 'High' }, { title: 'Final GDP q/q', country: 'USD', date: '2026-11-05T08:30:00-05:00', impact: 'High' },
    { title: 'CPI m/m', country: 'EUR', date: '2026-11-05T05:00:00-05:00', impact: 'High' }, { title: 'Unemployment Claims', country: 'USD', date: '2026-11-05T08:30:00-05:00', impact: 'Medium' },
    { title: 'Non-Farm Employment Change', country: 'USD', date: '2026-11-06T08:30:00-05:00', impact: 'High' }, { title: 'Unemployment Rate', country: 'USD', date: '2026-11-06T08:30:00-05:00', impact: 'High' },
    { title: 'FOMC Statement', country: 'USD', date: 'not a date', impact: 'High' }];
  const parsed = macro.parseFeed(rows);
  check('feed: only USD + High major movers (Core PCE, payrolls, unemployment rate); GDP, EUR, medium impact and an unreadable date dropped', parsed.length === 3
    && parsed.map((e) => e.event).join('|') === 'Core PCE|Non-Farm Payrolls|Unemployment Rate', parsed.map((e) => e.event).join(', '));
  const ok = await macro.refresh({ now: NOW, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) }) });
  const nfp = b(et.toEpoch('2026-11-06', 8, 25));
  check('a fetched feed merges with the schedule: releases at one time are named together', ok.ok && nfp.active && nfp.event === 'Non-Farm Payrolls + Unemployment Rate' && b(Date.parse('2026-11-05T08:40:00-05:00')).event === 'Core PCE', nfp.event);
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now();
  const slow = await macro.refresh({ now: NOW, fetchImpl: hang, timeoutMs: 200 });
  check('fail-open: a hung feed is aborted (5 s in the app) and reported, never thrown; the schedule still applies', !slow.ok && /timed out/.test(slow.error) && Date.now() - t0 < 2000
    && macro.FETCH_TIMEOUT_MS === 5000 && b(cpi).active && !b(et.toEpoch('2026-10-15', 12, 0)).active, slow.error);
  const bad = await macro.refresh({ now: NOW, fetchImpl: async () => ({ ok: true, text: async () => '<html>oops' }) });
  const notList = await macro.refresh({ now: NOW, fetchImpl: async () => ({ ok: true, text: async () => '{"a":1}' }) });
  const dead = await macro.refresh({ now: NOW }); // the real fetch at a dead port
  check('fail-open: invalid JSON, a non-list payload and a dead host are logged, not thrown; nothing outside a window is blocked', !bad.ok && !notList.ok && !dead.ok && !b(et.toEpoch('2026-10-15', 12, 0)).active, `${bad.error} | ${notList.error} | ${dead.error}`);
  macro._setFeed(null); // corrupt state: the check itself must fail open
  check('fail-open: a broken calendar state -> { active: false }, never a throw', b(cpi).active === false);
  macro._setFeed([]);

  // ---------- 2. Sector cap ----------
  const setup = (asset, o = {}) => ({ id: `options-system:${asset}:${Math.random()}`, asset, market: 'options', direction: 'short', strategyId: 'options-system', sizingBasis: 'paper', dollarRisk: 50, ...o });
  const ctx = { positions: ledger.getActivePositions(), pending: [], settings: settings(), now: et.toEpoch('2026-10-15', 12, 0) };
  const g = shields.check(setup('GOOGL'), ctx);
  check('AMZN open -> a 2nd Technology setup (GOOGL) is rejected SECTOR_CAP_REACHED "Max 1 open trade for Technology"', /^SECTOR_CAP_REACHED: Max 1 open trade for Technology \(AMZN open\)/.test(g || ''), g);
  check('...while a Financials (JPM) or Energy (XOM) setup is allowed', shields.check(setup('JPM'), ctx) === null && shields.check(setup('XOM'), ctx) === null);
  check('staged setups count too; Consumer Staples (KO stock open) blocks WMT; a LIVE book, crypto, manual and Pilot orders are separate / exempt',
    /SECTOR_CAP_REACHED.*JPM staged/.test(shields.check(setup('BAC'), { ...ctx, pending: [setup('JPM')] }) || '') && /Consumer Staples/.test(shields.check(setup('WMT'), ctx) || '')
    && shields.check(setup('NVDA', { sizingBasis: 'alpaca-live', execution: 'LIVE' }), ctx) === null && shields.check(setup('ETH-USD', { market: 'crypto' }), ctx) === null
    && shields.check(setup('NVDA', { id: 'manual:1' }), ctx) === null && shields.check(setup('NVDA', { strategyId: 'portfolio-pilot' }), ctx) === null);
  check('maxTradesPerSector 2 allows a second Technology trade', shields.check(setup('GOOGL'), { ...ctx, settings: { ...settings(), maxTradesPerSector: 2 } }) === null);

  // ---------- 1b. macro at staging: scope ----------
  const inCpi = { ...ctx, now: cpi - 5 * 60e3 };
  const m1 = shields.check(setup('JPM'), inCpi);
  check('in a blackout: stocks / options setups -> MACRO_SHIELD_ACTIVE "... resumes at 8:45 AM ET"; crypto keeps trading unless "Apply to crypto"; shield off -> allowed',
    /^MACRO_SHIELD_ACTIVE: CPI at 8:30 AM ET: .*resumes at 8:45 AM ET$/.test(m1 || '') && shields.check(setup('ETH-USD', { market: 'crypto' }), inCpi) === null
    && /^MACRO_SHIELD_ACTIVE/.test(shields.check(setup('ETH-USD', { market: 'crypto' }), { ...inCpi, settings: { ...settings(), macroShieldCrypto: true } }) || '')
    && shields.check(setup('JPM'), { ...inCpi, settings: { ...settings(), macroShield: false } }) === null, m1);

  // ---------- 3. Daily loss kill switch ----------
  daily.reset();
  const mark = (v) => () => v;
  const m0 = daily.measure({ journal: [{ closedAt: T(26), netPnl: -500 }, { closedAt: NOW - 60e3, netPnl: -40 }], positions: [{ id: 'a', openedAt: T(30), positionSize: 1 }], now: NOW, markOf: mark(-100) });
  const m2 = daily.measure({ journal: [{ closedAt: NOW - 60e3, netPnl: -40 }], positions: [{ id: 'a', openedAt: T(30), positionSize: 1 }], now: NOW + 60e3, markOf: mark(-130) });
  check('today = realized since midnight ET (yesterday\'s -$500 ignored) + unrealized moves TODAY (an older position counts from its first mark)', m0.realized === -40 && m0.pnl === -40 && m2.pnl === -70, `${m0.pnl} -> ${m2.pnl}`);
  daily.reset();
  const lossDay = { journal: [{ closedAt: NOW - 120e3, netPnl: -289.15 }], positions: [] };
  const k = daily.refresh({ ...lossDay, settings: settings(), now: NOW }).paper; // Phase 83: one switch per book (these trades are paper)
  const kr = shields.check(setup('JPM'), ctx);
  check('-$289.15 of PAPER losses today past the $150 default -> the paper switch trips: every new paper setup (any market) is DAILY_LOSS_LIMIT_REACHED', k.active && k.limit === 150 && /^DAILY_LOSS_LIMIT_REACHED: today's paper P\/L -\$289\.15 hit the -\$150/.test(kr || '')
    && /^DAILY_LOSS_LIMIT_REACHED/.test(shields.check(setup('ETH-USD', { market: 'crypto' }), ctx) || '') && shields.check(setup('NVDA', { id: 'manual:2' }), ctx) === null, kr);
  const still = daily.refresh({ journal: [{ closedAt: NOW - 120e3, netPnl: -289.15 }, { closedAt: NOW - 60e3, netPnl: 300 }], positions: [], settings: settings(), now: NOW + 1000 }).paper;
  check('latched for the day: a later +$300 does not re-open entries; raising the limit past the loss (Settings) releases it; 0 = off',
    still.active && daily.refresh({ ...lossDay, settings: { ...settings(), dailyLossLimitPaper: 500 }, now: NOW + 2000 }).paper.active === false && daily.refresh({ ...lossDay, settings: { ...settings(), dailyLossLimitPaper: 0 }, now: NOW + 3000 }).paper.active === false);
  daily.refresh({ ...lossDay, settings: settings(), now: NOW + 4000 }); // tripped again at $150
  ledger.getActivePositions(); // the KO paper stock: a stop at 57 must still close it while tripped
  const closed = ledger.monitorPositions(new Map([['KO', 56.5]]));
  check('while tripped, a stop-loss still executes (paper KO closed STOP_LOSS at 56.5): the shields never touch exits', closed.length === 1 && closed[0].exitReason === 'STOP_LOSS' && daily.current().paper.active, closed.map((c) => `${c.asset} ${c.exitReason}`).join(', '));
  const exitSrc = ['execution/exit-pass.js', 'execution/exit-monitor.js', 'execution/ratchet.js', 'execution/time-exits.js', 'execution/bracket-ops.js', 'execution/coinbase-exit.js'].map((f) => fs.readFileSync(S + f, 'utf8')).join('\n');
  check('no exit path references the entry shields', !/entry-shields|daily-loss|macro-calendar/.test(exitSrc));

  // ---------- 4. A real pipeline pass + approval ----------
  daily.reset();
  const runner = require(S + 'execution/strategy-runner');
  require(S + 'execution/exit-pass').reconcile = async () => null;
  require(S + 'execution/exit-pass').run = async () => null;
  require(S + 'connectors/macro-events').refresh = async () => false;
  require(S + 'connectors/coinbase-discovery').stream = () => [];
  const prices = require(S + 'market/latest-prices');
  const stock = (asset, px) => { prices.setPolled(asset, px, Date.now()); return { id: `equity-swing:PULLBACK:${asset}:t`, asset, market: 'stocks', strategyId: 'equity-swing', setupType: 'Pullback', direction: 'long', timeframe: '1d',
    entryZone: { min: px * 0.998, max: px }, invalidation: +(px * 0.97).toFixed(2), targets: [{ level: 1, price: +(px * 1.07).toFixed(2), allocation: 0.5 }, { level: 2, price: +(px * 1.1).toFixed(2), allocation: 0.5 }],
    catalyst: { type: 'technical', headline: 't', sentimentScore: 0 }, thesis: 'test', confirmationCriteria: ['t'], expectedDuration: '1-5 days', tradeType: 'Swing', timestamp: new Date().toISOString() }; };
  let cands = [stock('INTC', 40), stock('JPM', 250)]; // priced to size (whole shares under the 10% capital cap)
  runner.collect = async () => cands; runner.takeBlocks = () => []; runner.scans = () => [];
  const pipeline = require(S + 'execution/pipeline');
  const stats = require(S + 'execution/rejection-stats');
  await pipeline.runPipeline({ trigger: 'test' });
  const staged = ledger.getPendingOrders().map((o) => o.asset);
  const why = (label) => (stats.snapshot().reasons.find((r) => r.reason.startsWith(label)) || { count: 0 }).count;
  check('pipeline pass: INTC (Technology, AMZN open) rejected SECTOR_CAP_REACHED; JPM staged', !staged.includes('INTC') && staged.includes('JPM') && why('SECTOR_CAP_REACHED') === 1, `staged ${staged.join(', ') || 'none'}`);
  macro._setFeed([{ event: 'CPI', title: 'CPI m/m', releaseTime: Date.now() + 10 * 60e3, source: 'feed' }]);
  cands = [stock('XOM', 60)];
  await pipeline.runPipeline({ trigger: 'test' });
  check('...during a blackout the next pass stages nothing (XOM: MACRO_SHIELD_ACTIVE)', !ledger.getPendingOrders().some((o) => o.asset === 'XOM') && why('MACRO_SHIELD_ACTIVE') === 1);
  macro._setFeed([]);
  const jpm = ledger.getPendingOrders().find((o) => o.asset === 'JPM');
  ledger.updateSettings({ dailyLossLimitPaper: 30 }); // today's real KO paper stop-out (~-$35, above) now passes the paper limit
  let err = null;
  try { await require(S + 'execution/order-router').approveWithGuard(jpm.id, { actor: 'user' }); } catch (e) { err = e.message; }
  check('approval after the kill switch trips: refused with DAILY_LOSS_LIMIT_REACHED and the setup STAYS pending', /^DAILY_LOSS_LIMIT_REACHED/.test(err || '') && ledger.getPendingOrders().some((o) => o.id === jpm.id), err);

  // ---------- 5. Settings, buckets, banner ----------
  const defaults = { ...settings(), dailyLossLimitPaper: 150 };
  const refused = (v) => { try { ledger.updateSettings(v); return false; } catch { return true; } };
  ledger.updateSettings({ dailyLossLimitPaper: 150 });
  check('settings: defaults Macro Shield on / crypto off / 1 per sector / $150; invalid values refused; 0 (off) accepted', defaults.macroShield === true && defaults.macroShieldCrypto === false
    && defaults.maxTradesPerSector === 1 && settings().dailyLossLimitPaper === 150 && settings().dailyLossLimitLive === 25 && refused({ macroShield: 'maybe' }) && refused({ dailyLossLimitPaper: -5 }) && refused({ maxTradesPerSector: 0 })
    && !refused({ macroShield: false }) && settings().macroShield === false && !refused({ dailyLossLimitPaper: 0 }) && settings().dailyLossLimitPaper === 0);
  const labels = ['MACRO_SHIELD_ACTIVE: x', 'SECTOR_CAP_REACHED: x', 'DAILY_LOSS_LIMIT_REACHED: x'].map((r) => stats.bucket(r));
  check('rejection breakdown shows MACRO_SHIELD_ACTIVE / SECTOR_CAP_REACHED / DAILY_LOSS_LIMIT_REACHED', labels.every((l, i) => l.startsWith(['MACRO_SHIELD_ACTIVE', 'SECTOR_CAP_REACHED', 'DAILY_LOSS_LIMIT_REACHED'][i])), labels.join(' | '));
  const el = (tag, props = {}, kids = []) => ({ tag, ...props, children: [].concat(kids) });
  const win = { SignalDesk: { ui: { el, money: (x) => `$${Number(x).toFixed(2)}` } } };
  vm.runInNewContext(fs.readFileSync(C + 'components/shield-banner.js', 'utf8'), { window: win, document: { querySelectorAll: () => [] }, Date });
  const SB = win.SignalDesk.shieldBanner;
  const killText = SB.content({ at: NOW, kill: { paper: { book: 'paper', active: true, limit: 150, pnl: -310.5, trippedPnl: -289.15 }, live: { book: 'live', active: false } }, macro: { enabled: true } });
  const macroText = SB.content({ at: NOW, kill: null, macro: { enabled: true, active: true, event: 'CPI', releaseClock: '8:30 AM ET', resumesClock: '8:45 AM ET', upcoming: [] } });
  check('banners: "DAILY KILL SWITCH ACTIVE (Paper): -$150.00 loss limit reached" and "PAUSED FOR MACRO EVENT: CPI · Resumes at 8:45 AM ET"', killText[1] === 'DAILY KILL SWITCH ACTIVE (Paper): -$150.00 loss limit reached'
    && macroText[1] === 'PAUSED FOR MACRO EVENT: CPI · Resumes at 8:45 AM ET' && SB.content({ at: NOW, macro: { enabled: true, upcoming: [] } }) === null, `${killText[1]} | ${macroText[1]}`);

  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exitCode = fails ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300).unref();
})().catch((e) => { console.error(e); process.exit(1); });
