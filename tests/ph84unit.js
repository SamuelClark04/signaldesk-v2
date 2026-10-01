// Phase 84: AI Trade Analyst. Run: node tests/ph84unit.js. Scratch fixtures (OS temp dir); every broker key blank and
// URL dead; the AI keys blank too, and every provider call goes through an injected fake fetch: no network, no billed call.
//   payload generation (server-side, from the ledger), prompt formatting, OpenAI / Gemini request shapes and parsing,
//   15 s abort, missing key / HTTP errors, cache + hourly cap, the timing-claim guardrail, the HTTP guard, the safe
//   Markdown renderer, the vault / settings / UI wiring.
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph84-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: '', ALPACA_PAPER_API_SECRET: '', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '',
  OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD, OPENAI_MODEL: '', GEMINI_MODEL: '' });
const NOW = Date.now();
const leg = (side, strike, bid, ask) => ({ side, type: 'call', strike, ratio: 1, contract: `SPY261016C00${strike * 1000}`, bid, ask });
const od = { underlying: 'SPY', type: 'call', structure: 'vertical', fill: 'package', label: 'SPY Oct 16 500/502.5 call spread', debit: 1.2, width: 2.5, multiplier: 100,
  expiration: new Date(NOW + 10 * 864e5).toISOString().slice(0, 10), exitRule: { stopValue: 0.6, targetValue: 2.1 }, legs: [leg('buy', 500, 3.0, 3.1), leg('sell', 502.5, 1.8, 1.9)], iv: 0.18 };
const order = { id: 'options-system:BREAKOUT:CALL:SPY:t', asset: 'SPY', market: 'options', strategyId: 'options-system', setupType: 'Bull call spread · Breakout', direction: 'long', timeframe: '1h',
  entryZone: { min: 500, max: 500.5 }, entryPrice: 500.5, invalidation: 495, targets: [{ level: 1, price: 506, allocation: 1 }, { level: 2, price: 509, allocation: 0 }], positionSize: 1, notional: 120,
  dollarRisk: 70, sizingBankroll: 3000, riskPct: 0.02, t1NetRR: 1.4, feeDrag: 0.04, estimatedFees: 2.6, thesis: 'Broke over the 1h EMA21 on 3x volume. Bull call spread for a 1-5 day move.',
  confirmationCriteria: ['Broke over the 1h EMA21'], catalysts: [{ type: 'CPI', date: '2026-10-14', time: '08:30 ET', title: 'CPI inflation report' }], optionsData: od, expiresAt: NOW + 20 * 60000,
  sizingBasis: 'paper', approved: true, stagedAt: NOW - 60000, status: 'pending' };
const eth = { id: 'crypto-intraday:ETH:t', asset: 'ETH-USD', market: 'crypto', strategyId: 'crypto-intraday', setupType: '1h squeeze breakout', direction: 'long', execution: 'PAPER', sizingBasis: 'paper',
  positionSize: 0.04, fillPrice: 2500, entryPrice: 2500, invalidation: 2425, initialStop: 2425, dollarRisk: 3, targets: [{ level: 1, price: 2650, allocation: 1 }], openedAt: NOW - 5 * 3600e3, entryLiquidity: 'maker' };
fs.writeFileSync(process.env.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 3000, cryptoBankroll: 3000, stockMode: 'paper', cryptoMode: 'paper', paperStockBroker: 'internal' },
  pendingOrders: [order], activePositions: [eth, { ...order, id: 'opt:SPY:open', status: 'open', execution: 'PAPER', fillPrice: 500.5, openedAt: NOW - 26 * 3600e3, deferredExit: { reason: 'STOP_LOSS', at: NOW - 3600e3 } }],
  tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
const C = path.join(__dirname, '..', 'client') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

(async () => {
  require(S + 'data/news-feed').newsFor = async () => ({ items: [{ title: 'SPY rallies as yields ease', outlet: 'Reuters', at: NOW - 2 * 3600e3 }, { title: 'Old news', outlet: 'X', at: NOW - 9 * 864e5 }] });
  require(S + 'market/latest-prices').setPolled('ETH-USD', 2550, NOW);
  const AP = require(S + 'services/ai-payload');
  const AI = require(S + 'services/ai-analyst');

  // ---------- 1. payload generation (server-side, from the ledger) ----------
  const pre = await AP.build('PRE_TRADE', order.id, NOW);
  const f = pre.facts || {};
  check('PRE_TRADE facts: ticker, class, strategy name, trigger, entry / stop / T1 / T2, risk vs budget, the spread\'s net bid / ask, DTE, events, headlines, paper',
    pre.ok && f.asset === 'SPY' && f.assetClass === 'options' && f.strategy === 'Options Spreads' && /EMA21/.test(f.thesis) && f.entry.zoneHigh === 500.5 && f.stop === 495 && f.target1 === 506 && f.target2 === 509
    && f.risk.dollarRisk === 70 && f.risk.pctOfBankroll === '2.33%' && f.risk.budgetPct === '2.00%' && f.options.netBidAsk.widthPctOfMid === '16.67%' && f.options.dte >= 9 && f.options.legs.length === 2
    && /CPI/.test(f.scheduledEventsInHold[0]) && f.headlines.length === 1 && f.headlines[0].title === 'SPY rallies as yields ease' && /PAPER/.test(f.account) && f.approvalExpiresInMin === Math.round((require(S + 'execution/paper-ledger').getPendingOrders()[0].expiresAt - NOW) / 60000), JSON.stringify(f).slice(0, 200)); // the ledger's own approval deadline
  const inn = await AP.build('IN_TRADE', eth.id, NOW);
  const g = inn.facts || {};
  check('IN_TRADE facts: opened / hold time, price vs fill and stop, unrealized gross / net / fees, R-multiple now, distance to the stop in R',
    inn.ok && g.holdHours === 5 && g.currentPrice === 2550 && g.fillPrice === 2500 && g.unrealized && Number.isFinite(g.unrealized.net) && g.unrealized.gross > 0
    && Math.abs(g.rMultipleNow - g.unrealized.net / 3) < 0.01 && g.distanceToStop.inR === 1.67, JSON.stringify({ u: g.unrealized, r: g.rMultipleNow, d: g.distanceToStop }));
  const opt = await AP.build('IN_TRADE', 'opt:SPY:open', NOW);
  check('IN_TRADE option: DTE, debit / stop / target values, and a held late-day exit are in the facts', opt.ok && opt.facts.options.dte >= 9 && opt.facts.options.stopValue === 0.6 && /after the 3:45 PM cutoff/.test(opt.facts.heldLateDayExit));
  const all = JSON.stringify([f, g, opt.facts]);
  check('facts are compact and carry no secrets / account ids (no key, token, broker order id)', all.length < 9000 && !/apiKey|API_KEY|secret|token|brokerId/i.test(all), `${all.length} chars`);
  check('unknown id -> a clear "no longer waiting / open" answer', /no longer waiting/.test((await AP.build('PRE_TRADE', 'nope', NOW)).error) && /no longer open/.test((await AP.build('IN_TRADE', 'nope', NOW)).error));

  // ---------- 2. prompts ----------
  const sp = AI.systemPrompt('PRE_TRADE'); const si = AI.systemPrompt('IN_TRADE');
  check('system prompt: risk manager / desk coach role, facts-only, no price or timing predictions, never widen a stop, the 4 headings and the verdict line',
    /Senior Quantitative Risk Manager and Trading Desk Coach/.test(sp) && /Use ONLY the facts/.test(sp) && /Never predict or guarantee future prices/.test(sp) && /never suggest moving a stop further away/.test(sp)
    && ['## 1. Setup Thesis Assessment', '## 2. Catalyst & News Conflict Check', '## 3. Risk/Reward & Spread Quality Check', '## 4. Final Recommendation'].every((h) => sp.includes(h))
    && /Recommendation: PROCEED \| CAUTION \| PASS/.test(sp) && ['## 1. Current State vs Original Thesis', '## 2. Market Noise vs Structural Invalidation', '## 3. Time Horizon & Greeks', '## 4. Action Plan'].every((h) => si.includes(h))
    && /Action: HOLD \| TAKE_PROFIT \| TRIM \| EXIT/.test(si));
  check('user prompt: the mode + the facts as JSON', /^Mode: PRE_TRADE/.test(AI.userPrompt('PRE_TRADE', f)) && AI.userPrompt('PRE_TRADE', f).includes('"asset": "SPY"'));

  // ---------- 3. missing key ----------
  const none = await AI.analyze({ mode: 'PRE_TRADE', payload: { id: order.id } }, { settings: {} });
  check('no API key configured -> { ok: false, NO_KEY, "AI Analyst API key missing ..." } (never a throw)', !none.ok && none.code === 'NO_KEY' && /AI Analyst API key missing/.test(none.error));
  check('bad requests are refused', (await AI.analyze({ mode: 'X', payload: { id: 'a' } })).code === 'BAD_REQUEST' && (await AI.analyze({ mode: 'PRE_TRADE' })).code === 'BAD_REQUEST');

  // ---------- 4. OpenAI and Gemini (fake fetch) ----------
  process.env.OPENAI_API_KEY = 'sk-test-openai-0000';
  process.env.GEMINI_API_KEY = 'gm-test-gemini-0000';
  const seen = [];
  const reply = (provider, text) => async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200,
    json: async () => (provider === 'openai' ? { choices: [{ message: { content: text } }] } : { candidates: [{ content: { parts: [{ text }] } }] }) }; };
  const md = '## 1. Setup Thesis Assessment\nValid breakout.\n## 2. Catalyst & News Conflict Check\nCPI inside the hold.\n## 3. Risk/Reward & Spread Quality Check\nOK.\n## 4. Final Recommendation\nSize down.\n\nRecommendation: CAUTION';
  const o1 = await AI.analyze({ mode: 'PRE_TRADE', payload: { id: order.id } }, { settings: { aiProvider: 'auto' }, fetchImpl: reply('openai', md), now: NOW });
  const r1 = seen[0];
  check('OpenAI (auto, first key): POST /chat/completions, model gpt-4o-mini, system + user messages, key in the Authorization header only; verdict CAUTION parsed',
    o1.ok && o1.provider === 'openai' && o1.model === 'gpt-4o-mini' && /\/chat\/completions$/.test(r1.url) && r1.init.headers.Authorization === 'Bearer sk-test-openai-0000' && !r1.url.includes('sk-test')
    && r1.body.model === 'gpt-4o-mini' && r1.body.messages[0].role === 'system' && r1.body.messages[1].role === 'user' && o1.verdict === 'CAUTION' && o1.markdown.includes('CPI inside'), o1.error);
  const o2 = await AI.analyze({ mode: 'PRE_TRADE', payload: { id: order.id } }, { settings: { aiProvider: 'auto' }, fetchImpl: reply('openai', md), now: NOW + 5000 });
  check('the same setup within a minute is answered from the cache (no second paid call)', o2.ok && o2.cached && seen.length === 1);
  const md2 = '## 1. Current State vs Original Thesis\nIntact.\n## 2. Market Noise vs Structural Invalidation\nNoise.\n## 3. Time Horizon & Greeks\nOK.\n## 4. Action Plan\nHold to stop / target.\nAction: HOLD';
  const g1 = await AI.analyze({ mode: 'IN_TRADE', payload: { id: eth.id } }, { settings: { aiProvider: 'gemini' }, fetchImpl: reply('gemini', md2), now: NOW });
  const r2 = seen[1];
  check('Gemini (chosen in Settings): POST models/gemini-flash-latest:generateContent, systemInstruction + contents, key in x-goog-api-key (never the URL); verdict HOLD',
    g1.ok && g1.provider === 'gemini' && /\/models\/gemini-flash-latest:generateContent$/.test(r2.url) && r2.init.headers['x-goog-api-key'] === 'gm-test-gemini-0000' && !r2.url.includes('gm-test')
    && /Trading Desk Coach/.test(r2.body.systemInstruction.parts[0].text) && /"mode": "IN_TRADE"/.test(r2.body.contents[0].parts[0].text) && g1.verdict === 'HOLD', g1.error);

  // ---------- 5. timeout / errors / guardrail / rate limit ----------
  AI.reset();
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now();
  const to = await AI.analyze({ mode: 'IN_TRADE', payload: { id: eth.id } }, { settings: { aiProvider: 'openai' }, fetchImpl: hang, timeoutMs: 200, now: NOW });
  check('a provider that never answers is aborted (15 s in the app) -> a clean "provider unreachable" error, not a crash', AI.TIMEOUT_MS === 15000 && !to.ok && to.code === 'PROVIDER'
    && /did not answer within 0\.2 s/.test(to.error) && Date.now() - t0 < 3000, to.error);
  const e401 = await AI.analyze({ mode: 'PRE_TRADE', payload: { id: order.id } }, { settings: { aiProvider: 'openai' }, now: NOW,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided' } }) }) });
  const dead = await AI.analyze({ mode: 'IN_TRADE', payload: { id: 'opt:SPY:open' } }, { settings: { aiProvider: 'openai' }, now: NOW }); // the real fetch at a dead port
  check('a refused key (HTTP 401) and an unreachable host -> readable errors', !e401.ok && /HTTP 401: Incorrect API key/.test(e401.error) && !dead.ok && /unreachable/.test(dead.error), `${e401.error} | ${dead.error}`);
  AI.reset();
  const claim = await AI.analyze({ mode: 'PRE_TRADE', payload: { id: order.id } }, { settings: { aiProvider: 'openai' }, now: NOW,
    fetchImpl: reply('openai', `${md}\nSPY will hit 506 within 3 hours.`) });
  check('guardrail: a timing prediction in the reply is flagged for the user', claim.ok && claim.warnings.length === 1 && AI.timingClaim('it will reach the target in the next session') && !AI.timingClaim(md));
  AI.reset();
  let n = 0;
  for (let i = 0; i < AI.MAX_PER_HOUR + 1; i += 1) { const r = await AI.analyze({ mode: 'PRE_TRADE', payload: { id: order.id } }, { settings: { aiProvider: 'openai' }, fetchImpl: reply('openai', md), now: NOW + i * 61000 }); if (r.ok) n += 1; else check('the hourly cap answers RATE_LIMIT', r.code === 'RATE_LIMIT', r.error); }
  check(`at most ${AI.MAX_PER_HOUR} provider calls an hour`, n === AI.MAX_PER_HOUR);

  // ---------- 6. the HTTP route is guarded ----------
  const express = require(path.join(__dirname, '..', 'node_modules', 'express'));
  const app = express(); app.use(express.json());
  require(S + 'http-routes').installAi(app, 0);
  const srv = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/ai/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"mode":"PRE_TRADE","payload":{"id":"x"}}' });
  srv.close();
  check('POST /api/ai/analyze refuses a request without a session / from a foreign origin (403)', res.status === 403);

  // ---------- 7. client: safe Markdown, modal, buttons, settings ----------
  const MM = require(C + 'lib/mini-markdown.js');
  const el = (tag, p = {}, kids = []) => ({ tag, ...p, children: [].concat(kids) });
  const nodes = MM.render('## 1. Thesis\nA **valid** breakout with `T1`.\n- one\n- two\n\n<script>alert(1)</script>', el);
  const flat = (x) => (typeof x === 'string' ? x : `${x.textContent || ''}${(x.children || []).map(flat).join('')}`);
  check('Markdown: ## -> heading, **bold** / `code` inline, bullets -> a list; <script> stays plain TEXT (text nodes only, never HTML)',
    nodes[0].tag === 'h3' && nodes[1].tag === 'p' && nodes[1].children.some((c) => c.tag === 'strong' && c.textContent === 'valid') && nodes[2].tag === 'ul' && nodes[2].children.length === 2
    && nodes[3].tag === 'p' && flat(nodes[3]) === '<script>alert(1)</script>' && !/\.innerHTML\s*=|insertAdjacentHTML/.test(fs.readFileSync(C + 'lib/mini-markdown.js', 'utf8') + fs.readFileSync(C + 'components/ai-analyst.js', 'utf8')));
  const src = (f) => fs.readFileSync(C + f, 'utf8');
  check('buttons: [AI Breakdown] on Approvals cards (PRE_TRADE), [AI Briefing] next to Manual Exit / Close Now on the position panel (IN_TRADE)',
    /SD\.aiAnalyst\.button\('PRE_TRADE', o\.id/.test(src('views/opportunities-approvals.js')) && /exitButton\(p, m, ctx\),\n\s*SD\.aiAnalyst\.button\('IN_TRADE', p\.id/.test(src('views/position-detail.js'))
    && /fetch\('\/api\/ai\/analyze'/.test(src('components/ai-analyst.js')) && /payload: \{ id \}/.test(src('components/ai-analyst.js')));
  const vault = require(S + 'security/vault');
  const L = require(S + 'execution/paper-ledger');
  let refused = false; try { L.updateSettings({ aiProvider: 'claude' }); } catch { refused = true; }
  check('settings + keys: aiProvider auto | openai | gemini (default auto); OpenAI / Gemini keys are encrypted vault accounts with a test, entered masked',
    L.getSettings().aiProvider === 'auto' && refused && vault.PROVIDERS.openai.fields.apiKey === 'OPENAI_API_KEY' && vault.PROVIDERS.gemini.fields.apiKey === 'GEMINI_API_KEY'
    && typeof require(S + 'security/accounts').TESTS.openai === 'function' && /'apiKey'/.test(src('views/settings-accounts.js').match(/const SECRET = new Set\([^)]*\)/)[0]));

  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exitCode = fails ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300).unref();
})().catch((e) => { console.error(e); process.exit(1); });
