// Phase 85: no pipeline stage waits on the network serially; Alpaca option exits run once at a time, side by side, under
// a deadline; the option quote refresh honours its 12 s age; upstream failures are never a 5xx through the tunnel.
// Run: node tests/ph85unit.js. Scratch fixtures (OS temp dir), blank broker keys, dead URLs, fetch stubbed (no network).
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph85-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKFAKEFAKEFAKE', ALPACA_PAPER_API_SECRET: 'fake', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD });
// No request leaves the process: option snapshots are answered here, anything else fails at once.
const fetched = [];
global.fetch = async (url) => {
  const u = String(url);
  fetched.push(u);
  if (!u.includes('/v1beta1/options/snapshots?')) throw new Error(`test: no network (${u.slice(0, 60)})`);
  const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split(',');
  const snapshots = Object.fromEntries(syms.map((s) => [s, { latestQuote: { bp: 1, ap: 1.2, t: new Date().toISOString() } }]));
  return { ok: true, status: 200, text: async () => JSON.stringify({ snapshots }) };
};
const leg = (side, strike) => ({ side, type: 'call', strike, ratio: 1, contract: `SPY261016C00${strike * 1000}` });
const od = { underlying: 'SPY', type: 'call', structure: 'vertical', fill: 'package', debit: 1.2, width: 2.5, multiplier: 100, expiration: '2026-10-16',
  exitRule: { stopValue: 0.65, targetValue: 2.1 }, legs: [leg('buy', 500), leg('sell', 502.5)] };
const pos = (id) => ({ id, asset: 'SPY', market: 'options', strategyId: 'options-system', direction: 'long', execution: 'PAPER', paperBroker: 'alpaca', sizingBasis: 'paper',
  positionSize: 1, fillPrice: 500, entryPrice: 500, invalidation: 0, dollarRisk: 60, openedAt: Date.parse('2026-09-30T14:00:00Z'), optionsData: od, brokerId: `${id}-entry`, fillEstimated: false });
fs.writeFileSync(process.env.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 3000, cryptoBankroll: 3000, stockMode: 'paper', cryptoMode: 'paper' },
  pendingOrders: [], activePositions: [pos('opt:A'), pos('opt:B')], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// A controllable history source, patched in BEFORE daily-bars / watch-triggers / http-routes take their copy.
const hb = require(S + 'connectors/history-bars');
const hist = { calls: 0, delay: {}, hang: new Set() };
const DAY = 86400;
const bars = (n, step, now) => Array.from({ length: n }, (_, i) => { const c = 100 + i * 0.1; return { time: Math.floor(now / 1000) - (n - i + 1) * step, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }; });
hb.getHistory = async (symbol, tf) => {
  hist.calls += 1;
  if (hist.hang.has(symbol)) return new Promise(() => {}); // a host that never answers
  if (symbol === 'DOWN-USD') return { ok: false, status: 502, error: 'timed out after 8s' };
  await sleep(hist.delay[symbol] || 0);
  return { ok: true, bars: tf === '1d' ? bars(30, DAY, Date.now()) : bars(30, 3600, Date.now()) };
};

(async () => {
  // ---------- 1. watch-triggers: every history at once, under a budget; levels from the cache ----------
  const wt = require(S + 'intelligence/watch-triggers');
  const coins = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'].map((x) => `${x}-USD`);
  for (const c of coins) hist.delay[c] = 250;
  const items = coins.map((symbol) => ({ symbol, market: 'crypto', lastPrice: 101 }));
  let t = Date.now();
  const out1 = await wt.computeTriggers(items, new Map(), {});
  const ms1 = Date.now() - t;
  check(`7 coins whose history takes 250 ms per request (14 requests: 3.5 s one by one) are fetched side by side: ${ms1} ms`, ms1 < 1200 && hist.calls === 14, `${hist.calls} calls`);
  check('...and every coin gets its nearest level from those bars (20-day high breakout / 1h mean)', coins.every((c) => out1[c] && out1[c].level > 0), JSON.stringify(out1[coins[0]]));
  const before = hist.calls;
  t = Date.now();
  const out2 = await wt.computeTriggers(items, new Map(), {});
  check(`the next pass is served from the cache: no request, ${Date.now() - t} ms, the same levels`, hist.calls === before && Date.now() - t < 200 && out2[coins[0]].level === out1[coins[0]].level);

  const warns = [];
  const ow = console.warn;
  console.warn = (m) => warns.push(String(m));
  hist.hang.add('HANG-USD');
  t = Date.now();
  const out3 = await wt.computeTriggers([...items, { symbol: 'HANG-USD', market: 'crypto', lastPrice: 5 }], new Map(), {}, Date.now(), { budgetMs: 300 });
  const ms3 = Date.now() - t;
  console.warn = ow;
  check(`a host that NEVER answers costs the stage its budget only (300 ms here, 8 s live): ${ms3} ms, never 45 s`, ms3 >= 280 && ms3 < 900);
  check('...the other coins still get their levels; the hung one has none yet', coins.every((c) => out3[c]) && !out3['HANG-USD']);
  check('...and it is logged once, naming what is still loading', warns.length === 1 && /2 histories still loading after 0\.3 s \(HANG-USD 1d, HANG-USD 1h\)/.test(warns[0]), warns[0]);
  check('the watchlist stage no longer awaits getDailyBars / hourlyBars symbol by symbol', !/await getDailyBars\(symbol|await hourlyBars\(symbol/.test(fs.readFileSync(S + 'intelligence/watch-triggers.js', 'utf8')));

  // ---------- 2. the watchdog names how long each stage of the stalled pass took ----------
  const loop = require(S + 'execution/loop-pace');
  const w2 = [];
  console.warn = (m) => w2.push(String(m));
  const r = await loop.watchdog(loop.inPass(async () => { await loop.during('alpha', () => sleep(30)); await loop.during('beta', () => sleep(400)); }), 200);
  console.warn = ow;
  await sleep(300);
  check('a pass over the watchdog: "stage times: alpha 0.0 s, beta 0.2 s (still running)" in the warning', r && r.timedOut && /stage times: alpha 0\.\d s, beta 0\.\d s \(still running\)/.test(w2[0] || ''), w2[0]);

  // ---------- 3. Alpaca Paper option exits: one run at a time, positions side by side, a deadline for the pass ----------
  const T0 = Date.parse('2026-10-01T15:00:00Z'); // Thu 11:00 AM ET: inside the 9:35-3:45 exit window
  const broker = { placed: [], n: 0 };
  const alpacaApi = require(S + 'connectors/alpaca-api');
  alpacaApi.paper.getClock = async () => ({ ok: true, isOpen: true });
  alpacaApi.paper.request = async (p, { body } = {}) => { await sleep(300); broker.placed.push(body); return { ok: true, body: { id: `o${++broker.n}`, status: 'new' } }; };
  alpacaApi.paper.getOrder = async (id) => ({ ok: true, orderId: id, status: 'new', terminal: false, filledQty: 0 });
  alpacaApi.paper.cancelOrder = async () => ({ ok: true });
  const ledger = require(S + 'execution/paper-ledger');
  const ap = require(S + 'execution/alpaca-paper');
  t = Date.now();
  const a = ap.exits(ledger, T0);
  const b = ap.exits(ledger, T0);
  await Promise.all([a, b]);
  const ms5 = Date.now() - t;
  const targets = broker.placed.filter((x) => x && x.limit_price === '-2.10');
  check('two exit runs at once (the 5 s loop + the pipeline) share ONE run: one resting take-profit per position, never two', a === b && targets.length === 2 && broker.placed.length === 2, `${broker.placed.length} orders`);
  check(`positions are handled side by side: two 300 ms Alpaca calls took ${ms5} ms (one by one: 600+)`, ms5 < 550);
  const held = ledger.getActivePositions();
  check('...each position records its own resting target', held.every((p) => p.paperExitOrderId && p.exitWork && p.exitWork.kind === 'target'), held.map((p) => p.paperExitOrderId).join(','));
  const ep = require(S + 'execution/exit-pass');
  t = Date.now();
  const late = await ep.within(new Promise(() => {}), 150);
  check(`the pipeline waits for Alpaca option exits at most EXITS_WAIT_MS (${ep.EXITS_WAIT_MS / 1000} s), then moves on`, late === ep.LATE && Date.now() - t < 400 && ep.EXITS_WAIT_MS === 20000);

  // ---------- 4. the fast loop's 12 s quote refresh is real (refreshQuotes kept quotes 60 s before) ----------
  const opt = require(S + 'connectors/options-data');
  opt.reset();
  const C = od.legs.map((l) => l.contract);
  const q0 = Date.now();
  await opt.refreshQuotes(C, q0);
  const n0 = fetched.filter((u) => u.includes('options/snapshots')).length;
  await opt.refreshQuotes(C, q0 + 20000);
  const n1 = fetched.filter((u) => u.includes('options/snapshots')).length;
  await opt.refreshQuotes(C, q0 + 20000, null, ep.QUOTE_REFRESH_MS);
  const n2 = fetched.filter((u) => u.includes('options/snapshots')).length;
  check('a 20 s old quote: kept by the default 60 s refresh, re-requested at the exit loop\'s 12 s age (one batched request for both legs)', n0 === 1 && n1 === 1 && n2 === 2 && ep.QUOTE_REFRESH_MS === 12000, `${n0}/${n1}/${n2}`);
  check('the exit loop passes its 12 s age, and an exit step re-quotes legs older than 10 s', /refreshQuotes\([^;]*QUOTE_REFRESH_MS\)/.test(fs.readFileSync(S + 'execution/exit-pass.js', 'utf8'))
    && /EXIT_QUOTE_MAX_AGE_MS = 10 \* 1000/.test(fs.readFileSync(S + 'execution/alpaca-paper.js', 'utf8')));

  // ---------- 5. upstream failures are never a 5xx through the tunnel ----------
  require(S + 'security/access-policy').checkHttp = () => ({ ok: true });
  require(S + 'connectors/coinbase-discovery').stream = () => {};
  const ai = require(S + 'services/ai-analyst');
  const routes = {};
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  const http = require(S + 'http-routes');
  http.install(app, 3999);
  http.installAi(app, 3999);
  const call = async (key, req) => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, set() { return this; }, json(b) { this.body = b; return this; } }; await routes[key](req, res); return res; };
  const codes = {};
  for (const code of ['PROVIDER', 'NO_KEY', 'RATE_LIMIT']) {
    ai.analyze = async () => ({ ok: false, code, error: code });
    codes[code] = (await call('POST /api/ai/analyze', { body: {} })).code;
  }
  check('AI Analyst: provider failure / no key -> 424 (not 502 / 503), rate limit stays 429', codes.PROVIDER === 424 && codes.NO_KEY === 424 && codes.RATE_LIMIT === 429, JSON.stringify(codes));
  const h = await call('GET /api/history/:symbol', { params: { symbol: 'DOWN-USD' }, query: { tf: '1h' } });
  check('chart history: a market-data host timing out -> 424 with the reason (was 502)', h.code === 424 && /timed out/.test(h.body.error), `${h.code} ${JSON.stringify(h.body)}`);
  const cl = fs.readFileSync(path.join(__dirname, '..', 'client', 'components', 'ai-analyst.js'), 'utf8');
  check('the AI modal explains a tunnel 5xx page (not JSON) as "SignalDesk did not answer in time"', /SignalDesk did not answer in time \(HTTP \$\{res\.status\} from the tunnel\)/.test(cl));

  // ---------- 6. Phase 85b: the Gemini generateContent body ("HTTP 400: Request contains an invalid argument") ----------
  const AIa = require(S + 'services/ai-analyst');
  const g = AIa.request({ provider: 'gemini', key: 'gm-test', model: AIa.GEMINI_DEFAULT }, 'SYS', 'USER').body;
  check('Gemini body: systemInstruction { parts: [{ text }] }, contents [{ role: "user", parts: [{ text }] }], generationConfig { maxOutputTokens } and nothing else',
    JSON.stringify(g) === JSON.stringify({ systemInstruction: { parts: [{ text: 'SYS' }] }, contents: [{ role: 'user', parts: [{ text: 'USER' }] }], generationConfig: { maxOutputTokens: 2048 } }), JSON.stringify(g));
  check('default model gemini-flash-latest (2.5 Flash is closed to new keys); native generateContent, never the OpenAI-compatible endpoint',
    AIa.GEMINI_DEFAULT === 'gemini-flash-latest' && /\/models\/gemini-flash-latest:generateContent$/.test(AIa.request({ provider: 'gemini', key: 'k', model: AIa.GEMINI_DEFAULT }, 's', 'u').url));
  const th = (m) => AIa.geminiBody(m, 's', 'u').generationConfig.thinkingConfig;
  check('thinkingConfig only where documented: 2.5 Flash / Flash-Lite get thinkingBudget 0; 2.0 Flash, Gemini 3.x and the alias get none (no temperature either)',
    th('gemini-2.5-flash').thinkingBudget === 0 && th('gemini-2.5-flash-lite').thinkingBudget === 0 && !th('gemini-2.0-flash') && !th('gemini-3.8-flash') && !th('gemini-flash-latest')
    && !('temperature' in AIa.geminiBody('gemini-2.5-flash', 's', 'u').generationConfig));
  const sent = [];
  const bad = { error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'generation_config.thinking_config', description: 'not supported' }] }] } };
  const gfetch = (seq) => async (url, init) => { sent.push(JSON.parse(init.body)); const r = seq.shift(); return { ok: r.status === 200, status: r.status, json: async () => r.body }; };
  const wq = []; console.warn = (m) => wq.push(String(m));
  const ok1 = await AIa.callProvider({ provider: 'gemini', key: 'k', model: 'gemini-2.5-flash' }, 's', 'u',
    { fetchImpl: gfetch([{ status: 400, body: bad }, { status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }]) });
  console.warn = ow;
  check('a 400 to a body with thinkingConfig is retried ONCE without it (logged with the field Google named), and answers',
    ok1.ok && ok1.text === 'ok' && sent.length === 2 && sent[0].generationConfig.thinkingConfig && !sent[1].generationConfig.thinkingConfig && /generation_config\.thinking_config: not supported/.test(wq[0] || ''), wq[0]);
  sent.length = 0;
  const e1 = await AIa.callProvider({ provider: 'gemini', key: 'k', model: 'gemini-flash-latest' }, 's', 'u', { fetchImpl: gfetch([{ status: 400, body: bad }]) });
  const e2 = await AIa.callProvider({ provider: 'gemini', key: 'k', model: 'gemini-2.5-flash' }, 's', 'u', { fetchImpl: gfetch([{ status: 404, body: { error: { message: 'not found' } } }]) });
  const e3 = await AIa.callProvider({ provider: 'gemini', key: 'k', model: 'gemini-flash-latest' }, 's', 'u', { fetchImpl: gfetch([{ status: 200, body: { candidates: [{ finishReason: 'MAX_TOKENS', content: {} }] } }]) });
  check('a bare body is not retried; the error names the field; a 404 says the model is closed to the key; an empty reply says why (MAX_TOKENS)',
    sent.length === 3 && /HTTP 400: Request contains an invalid argument\. \[generation_config/.test(e1.error) && /not available to this key: unset GEMINI_MODEL/.test(e2.error) && /no text \(MAX_TOKENS\)/.test(e3.error),
    `${e1.error} | ${e2.error} | ${e3.error}`);

  check('no request left the process (only the stubbed option snapshots)', fetched.every((u) => u.includes('/v1beta1/options/snapshots?') && u.startsWith(DEAD)));
  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
