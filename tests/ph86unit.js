// Phase 86: the AI Analyst survives an overloaded Gemini model ("HTTP 503: This model is currently experiencing high demand"):
// the key's other Flash models (from its own model list), then the other provider, within one time budget.
// Run: node tests/ph86unit.js. Scratch fixtures (OS temp dir), blank keys + dead URLs; a fake fetch plays Google / OpenAI.
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph86-'));
const DEAD = 'http://127.0.0.1:9';
Object.assign(process.env, { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: '', ALPACA_PAPER_API_SECRET: '', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GEMINI_MODEL: '', OPENAI_MODEL: '',
  OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD });
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 50)})`); };
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

// A fake Google + OpenAI: status per model; the model list of this key; every request recorded.
const MODEL_LIST = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash-tts', 'gemini-3.1-pro-preview', 'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-embedding-001'];
function fake(status, { list = MODEL_LIST, hang = new Set() } = {}) {
  const log = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    log.push(u);
    const reply = (code, body) => ({ ok: code === 200, status: code, json: async () => body });
    if (/\/models\?pageSize=/.test(u)) return reply(200, { models: list.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: /embedding/.test(n) ? ['embedContent'] : ['generateContent'] })) });
    if (u.includes('/chat/completions')) return status.openai === 200 ? reply(200, { choices: [{ message: { content: 'OPENAI REPLY\nAction: HOLD' } }] }) : reply(status.openai || 500, { error: { message: 'down' } });
    const model = decodeURIComponent(/\/models\/([^:]+):generateContent/.exec(u)[1]);
    if (hang.has(model)) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const code = status[model] || 503;
    if (code === 200) return reply(200, { candidates: [{ content: { parts: [{ text: `REPLY FROM ${model}\nAction: HOLD` }] } }] });
    return reply(code, { error: { code, message: code === 503 ? 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' : 'nope' } });
  };
  return { impl, log, gen: () => log.filter((u) => u.includes(':generateContent')).map((u) => decodeURIComponent(/\/models\/([^:]+):/.exec(u)[1])) };
}

(async () => {
  const AI = require(S + 'services/ai-analyst');
  const GM = require(S + 'services/gemini-models');
  const G = { provider: 'gemini', key: 'gm-test-key', model: 'gemini-flash-latest' };

  check('fallback order from the key\'s own list: full Flash newest first, then Flash-Lite; no previews / TTS / aliases / embeddings / the primary',
    JSON.stringify(GM.rank(MODEL_LIST, 'gemini-flash-latest')) === JSON.stringify(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']), JSON.stringify(GM.rank(MODEL_LIST, 'gemini-flash-latest')));

  // 1. the user's case: the default model is overloaded; another Flash model answers.
  let f = fake({ 'gemini-3.7-flash': 200 });
  let r = await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl });
  check('gemini-flash-latest 503 "high demand" -> the key\'s model list is read (free) -> gemini-3.8-flash 503 -> gemini-3.7-flash ANSWERS',
    r.ok && r.model === 'gemini-3.7-flash' && r.provider === 'gemini' && /REPLY FROM gemini-3\.7-flash/.test(r.text) && JSON.stringify(f.gen()) === JSON.stringify(['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash']), JSON.stringify(f.gen()));
  check('...the busy models are reported with their status (shown under the reply)', r.tried.length === 2 && r.tried.every((t) => t.status === 503));
  check('...every Gemini request carries the key in a header, never the URL', f.log.every((u) => !u.includes('gm-test-key')));
  const listCalls = f.log.filter((u) => /\/models\?pageSize=/.test(u)).length;
  f = fake({ 'gemini-3.6-flash': 200 });
  await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl });
  check('the model list is cached (6 h): the next analysis does not read it again', listCalls === 1 && f.log.filter((u) => /\/models\?pageSize=/.test(u)).length === 0);

  // 2. every Gemini model busy, an OpenAI key set -> OpenAI answers.
  process.env.OPENAI_API_KEY = 'sk-test-openai-0000';
  f = fake({ openai: 200 });
  r = await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl });
  check('all Gemini models 503 and an OpenAI key is set -> gpt-4o-mini answers (5 fallbacks max, then the other provider)',
    r.ok && r.provider === 'openai' && r.model === 'gpt-4o-mini' && f.gen().length === 5 && r.tried.length === 5, `${f.gen().length} gemini tries`);
  process.env.OPENAI_API_KEY = '';

  // 3. everything busy, no OpenAI key: a clear message, quickly.
  f = fake({});
  let t = Date.now();
  r = await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl });
  check(`all busy, no OpenAI key: a clear "overloaded, try again in a few minutes / add an OpenAI key" error in ${Date.now() - t} ms (503s are answered at once)`,
    !r.ok && r.busy && /all 5 models tried are overloaded or rate-limited right now/.test(r.error) && /try again in a few minutes, or add an OpenAI key/.test(r.error) && Date.now() - t < 1000, r.error.slice(0, 160));

  // 4. a request error is not a capacity problem: no model hopping.
  f = fake({ 'gemini-flash-latest': 400 });
  r = await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl });
  check('HTTP 400 / 401 / 403 never hands over (another model would refuse the same request / key)', !r.ok && !r.busy && f.gen().length === 1);

  // 5. a model that never answers: the next one gets the time that is left.
  f = fake({ 'gemini-3.8-flash': 200 }, { hang: new Set(['gemini-flash-latest']) });
  t = Date.now();
  r = await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl, timeoutMs: 300, totalMs: 5000 });
  check(`a model that hangs is aborted at its per-call limit, then the next model answers (${Date.now() - t} ms)`, r.ok && r.model === 'gemini-3.8-flash' && r.tried[0].status === 'timeout');
  f = fake({}, { hang: new Set(['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']) });
  t = Date.now();
  r = await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl, timeoutMs: 1500, totalMs: 3000 });
  check(`...and the whole analysis stays inside its budget (3 s here, ${AI.TOTAL_MS / 1000} s live): ${Date.now() - t} ms`, !r.ok && Date.now() - t < 3400 && AI.TOTAL_MS === 30000);

  // 6. Google's list unavailable: a fixed fallback list; a 404 (model closed to this key) hands over too.
  GM.reset();
  f = fake({ 'gemini-2.5-flash': 404, 'gemini-2.5-flash-lite': 200 }, { list: [] });
  r = await AI.answer(G, 'sys', 'user', { fetchImpl: f.impl });
  check('no model list -> the fixed fallbacks; 404 (closed to new keys) moves on; gemini-2.5-flash-lite answers', r.ok && r.model === 'gemini-2.5-flash-lite'
    && JSON.stringify(f.gen()) === JSON.stringify(['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']), JSON.stringify(f.gen()));

  // 7. the route + modal: BUSY is a 424 with a [Try again] button.
  const src = fs.readFileSync(S + 'services/ai-analyst.js', 'utf8');
  check('analyze() goes through answer(), reports BUSY separately and names the model that answered', /await answer\(p, systemPrompt\(mode\)/.test(src) && /code: r\.busy \? 'BUSY'/.test(src) && /provider: r\.provider, model: r\.model/.test(src));
  check('BUSY -> HTTP 424 (never a 5xx through the tunnel); the modal offers [Try again]', /BUSY: 424/.test(fs.readFileSync(S + 'http-routes.js', 'utf8'))
    && /r\.code === 'BUSY'[\s\S]{0,200}Try again/.test(fs.readFileSync(path.join(__dirname, '..', 'client', 'components', 'ai-analyst.js'), 'utf8')));

  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
