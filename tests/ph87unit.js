// Phase 87: options signals get their 200-day history; Options Spreads off by default (no edge in the replay); options entry
// pacing; the backtest loader never drops symbols silently; the scorecard splits system exits from manual closes.
// Run: node tests/ph87unit.js. Scratch fixtures (OS temp dir), blank keys, dead URLs; fetch is a fake Alpaca (no network).
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph87-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKFAKEFAKEFAKE', ALPACA_PAPER_API_SECRET: 'fake', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD });
// A fake Alpaca data API: /v2/stocks/bars pages of `PAGE` bars, `PAGES[sym]` pages per symbol (Infinity = a token that never ends),
// one 429 first when `rate429` is set. Every URL recorded; nothing leaves the process.
const PAGE = 190; const PAGES = {}; const fake = { urls: [], rate429: 0 };
global.fetch = async (url) => {
  const u = new URL(String(url)); fake.urls.push(u);
  if (fake.rate429 > 0) { fake.rate429 -= 1; return { ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({ message: 'too many requests' }) }; }
  const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
  const page = Number(u.searchParams.get('page_token') || 0);
  const tf = u.searchParams.get('timeframe');
  const count = tf === '1Day' ? 300 : PAGE;
  const bars = Object.fromEntries(syms.map((s) => [s, Array.from({ length: count }, (_, i) => ({ t: new Date(Date.UTC(2025, 0, 2) + (page * count + i) * (tf === '1Day' ? 864e5 : 36e5)).toISOString(), o: 100, h: 101, l: 99, c: 100 + i * 0.01, v: 1000 }))]));
  const more = tf !== '1Day' && syms.length === 1 && page + 1 < (PAGES[syms[0]] || 1);
  return { ok: true, status: 200, json: async () => ({ bars, next_page_token: more ? String(page + 1) : null }) };
};
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const NOW = Date.parse('2026-10-01T16:30:00Z'); // Thu 12:30 PM ET

(async () => {
  // ---------- 1. the options signals see 200+ sessions ----------
  const db = require(S + 'connectors/daily-bars');
  const sig = require(S + 'strategies/options-signals');
  const short = await db.getDailyBars('AAPL', Date.UTC(2026, 9, 2));
  const long = await db.getLongDailyBars('AAPL', Date.UTC(2026, 9, 2));
  check('the bug: the 1d history keeps 100 sessions, so the signals\' 200-day SMA was always empty (TREND calls could never fire)', short.length === 100 && sig.daily(short, 130).ctx.s200 === null, `${short.length}`);
  check('the fix: the options system reads the 260-session history: the 200-day SMA exists', long.length >= 200 && sig.daily(long, 130).ctx.s200 > 0
    && /const bars = await getLongDailyBars\(symbol, env\.now\)/.test(fs.readFileSync(S + 'strategies/5-options-system.js', 'utf8')), `${long.length}`);

  // ---------- 2. Options Spreads off by default; a saved choice is kept ----------
  const tg = require(S + 'strategies/strategy-toggles');
  check('Options Spreads is OFF by default (new installs), with the replay result under its switch', tg.DEFAULTS['options-system'] === false && !tg.isEnabled('options-system', {})
    && /profit factor 0\.75/.test(tg.REASONS['options-system']) && /reversed lose as much/.test(tg.REASONS['options-system']));
  check('...an existing ledger that saved it ON keeps it on (the user\'s call, e.g. paper stress tests)', tg.isEnabled('options-system', { strategiesEnabled: { 'options-system': true } }));

  // ---------- 3. options entry pacing ----------
  const P = require(S + 'risk/option-pacing');
  const opt = (id, minAgo, dir = 'short', x = {}) => ({ id, market: 'options', strategyId: 'options-system', direction: dir, execution: 'PAPER', sizingBasis: 'paper', openedAt: NOW - minAgo * 60000, ...x });
  const order = (dir = 'short', x = {}) => ({ id: 'options-system:NEW', market: 'options', strategyId: 'options-system', direction: dir, execution: 'PAPER', sizingBasis: 'paper', ...x });
  const set = { maxOptionEntriesPerDay: 2 };
  const two = [opt('a', 200), opt('b', 150, 'long')];
  check('2 automated option entries today (max 2): a 3rd is held back OPTIONS_DAILY_ENTRY_CAP', /^OPTIONS_DAILY_ENTRY_CAP: 2 automated option entries today/.test(P.pacingReason(order('long'), { positions: two, settings: set, now: NOW }) || ''));
  check('...closed today counts too (journal), a T1 partial and its runner once; yesterday\'s do not', /^OPTIONS_DAILY_ENTRY_CAP/.test(P.pacingReason(order('long'), { journal: [opt('c', 200), { ...opt('c:trim:1', 200), parentId: 'c' }, opt('d', 180, 'long')], settings: set, now: NOW }) || '')
    && P.pacingReason(order('long'), { journal: [opt('c', 200), { ...opt('c:trim:1', 200), parentId: 'c' }, opt('old', 60 * 24 * 2, 'long')], settings: set, now: NOW }) === null);
  check('a bearish entry 20 min after another bearish one: OPTIONS_SAME_DIRECTION_GAP; a bullish one is fine', /^OPTIONS_SAME_DIRECTION_GAP: a bearish option entry 20 min ago \(a\)/.test(P.pacingReason(order('short'), { positions: [opt('a', 20)], settings: set, now: NOW }) || '')
    && P.pacingReason(order('long'), { positions: [opt('a', 20)], settings: set, now: NOW }) === null && P.pacingReason(order('short'), { positions: [opt('a', 61)], settings: set, now: NOW }) === null);
  check('staged setups waiting in Approvals count at staging (stagedAt)', /^OPTIONS_SAME_DIRECTION_GAP/.test(P.pacingReason(order('short'), { pending: [{ ...opt('s', 0), openedAt: undefined, stagedAt: NOW - 5 * 60000 }], settings: set, now: NOW }) || ''));
  check('exempt: manual tickets, live vs paper books are separate, stocks; 0 = pacing off (both rules)',
    P.pacingReason(order('long', { id: 'manual:OPT:1' }), { positions: two, settings: set, now: NOW }) === null
    && P.pacingReason(order('long', { execution: 'LIVE', sizingBasis: 'live' }), { positions: two, settings: set, now: NOW }) === null
    && P.pacingReason(order('long', { market: 'stocks' }), { positions: two, settings: set, now: NOW }) === null
    && P.pacingReason(order('short'), { positions: [...two, opt('z', 5)], settings: { maxOptionEntriesPerDay: 0 }, now: NOW }) === null
    && P.DEFAULT_PER_DAY === 2 && P.pacingReason(order('long'), { positions: two, settings: {}, now: NOW }) !== null);
  const ES = require(S + 'risk/entry-shields');
  const tw = [opt('a', 200, 'short', { asset: 'AAPL' }), opt('b', 150, 'long', { asset: 'JPM' })]; // different sectors: only pacing applies
  check('wired into the entry shields (staging + approval): the same reason through entryShields.check', /^OPTIONS_DAILY_ENTRY_CAP/.test(ES.check(order('long', { asset: 'XOM' }), { positions: tw, settings: set, now: NOW }) || '')
    && /journal: ledger\.getTradeJournal\(\)/.test(fs.readFileSync(S + 'execution/pipeline.js', 'utf8')) && /journal: ledger\.getTradeJournal\(\)/.test(fs.readFileSync(S + 'execution/order-router.js', 'utf8')));
  const L = require(S + 'execution/paper-ledger');
  check('setting maxOptionEntriesPerDay: default 2, 0 allowed; Settings > Portfolio risk has the field', L.getSettings().maxOptionEntriesPerDay === 2 && L.updateSettings({ maxOptionEntriesPerDay: 0 }).maxOptionEntriesPerDay === 0
    && /settings-option-pacing/.test(fs.readFileSync(path.join(__dirname, '..', 'client', 'views', 'settings-portfolio-risk.js'), 'utf8')));

  // ---------- 4. the backtest loader never drops symbols silently ----------
  const H = require(S + 'backtest/history');
  const syms = ['AAPL', 'MSFT', 'SPY', 'NVDA', 'XOM'];
  for (const s of syms) PAGES[s] = 30; // 30 pages x 190 bars each: the old shared 200-page cap covered 6 symbols' worth
  fake.urls.length = 0;
  let r = await H.load(syms, '1h', 'stocks', 760, NOW);
  check('every symbol loaded in full, one symbol per request (30 pages x 190 bars each)', r.ok && syms.every((s) => r.series[s] && r.series[s].length >= 29 * 190) && fake.urls.every((u) => !(u.searchParams.get('symbols') || '').includes(',')),
    syms.map((s) => `${s}:${r.series[s] && r.series[s].length}`).join(' '));
  H.reset(); PAGES.AMD = Infinity; fake.urls.length = 0;
  r = await H.load(['AMD', 'INTC'], '1h', 'stocks', 760, NOW);
  check(`a series that never ends is REPORTED missing ("truncated" after ${H.MAX_PAGES} pages), never returned partial; the next symbol still loads`,
    r.ok && !r.series.AMD && r.missing.some((m) => m.symbol === 'AMD' && /^truncated/.test(m.error)) && r.series.INTC && r.series.INTC.length === 190, JSON.stringify(r.missing));
  H.reset(); fake.rate429 = 1; const t0 = Date.now();
  r = await H.load(['JPM'], '1h', 'stocks', 760, NOW);
  check(`a 429 is retried after a pause (${Date.now() - t0} ms), not a failed backtest`, r.ok && r.series.JPM && r.series.JPM.length === 190 && Date.now() - t0 >= 1900);

  // ---------- 5. scorecard: who closed it ----------
  const SC = require(path.join(__dirname, '..', 'client', 'lib', 'scorecard.js'));
  const j = (id, net, reason, x = {}) => ({ id, strategyId: 'options-system', execution: 'PAPER', netPnl: net, dollarRisk: 100, exitReason: reason, closedAt: NOW - 1000, ...x });
  const sc = SC.build([j('a', 30, 'MANUAL_CLOSE'), j('b', 25, 'MANUAL_CLOSE'), j('c', -150, 'STOP_LOSS'), j('d', 60, 'TAKE_PROFIT_T1', { closedAt: NOW - 5000 }),
    j('d:trim:1', 40, 'MANUAL_CLOSE', { parentId: 'd', closedAt: NOW - 100 }), j('e', -0.05, 'CLOSED_EXTERNALLY')]);
  const ex = Object.fromEntries(sc.exits.map((r2) => [r2.strategy, r2]));
  check('"Who closed it": your manual closes (2 + the runner you closed) vs the system\'s stop vs outside; the last part decides',
    ex['exit:manual'].trades === 3 && ex['exit:manual'].net === 155 && ex['exit:system'].trades === 1 && ex['exit:system'].net === -150 && ex['exit:external'].trades === 1
    && /Closed by you/.test(ex['exit:manual'].label), JSON.stringify(sc.exits.map((r2) => [r2.label, r2.trades, r2.net])));
  check('...rendered under the strategy table (tbody #scorecard-exits)', /<tbody id="scorecard-exits"><\/tbody>/.test(fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8'))
    && /scorecard-exits/.test(fs.readFileSync(path.join(__dirname, '..', 'client', 'views', 'journal-scorecard.js'), 'utf8')));

  check('no request left the process', fake.urls.every((u) => u.origin === DEAD));
  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
