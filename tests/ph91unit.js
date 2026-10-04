// Phase 91: radar mode. Paper-only lock, manual-approval guarantee, radar migration + crypto manual-only, evidence labels,
// Quick Flips radar card facts. Run: node tests/ph91unit.js. Scratch ledger in the OS temp dir, fake keys, dead URLs.
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph91-'));
const DEAD = 'http://127.0.0.1:9';
const ENV = { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), PAPER_RUNS_PATH: path.join(DIR, 'runs.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', KRAKEN_API_BASE_URL: DEAD, OKX_API_KEY: '', OKX_API_SECRET: '',
  OKX_PASSPHRASE: '', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKTEST', ALPACA_PAPER_API_SECRET: 'test', ALPACA_PAPER_BASE_URL: DEAD,
  ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD };
Object.assign(process.env, ENV);
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
// A ledger saved by older code: both books LIVE, the Phase 89b-era switch map (crypto on), no radarVersion, the old auto-paper key.
fs.writeFileSync(ENV.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 10000, cryptoBankroll: 3000, stockMode: 'live', cryptoMode: 'live',
  paperStockBroker: 'internal', strategyPauseVersion: 90, quickFlipsAutoPaper: true,
  strategiesEnabled: { 'crypto-swing': false, 'crypto-intraday': true, 'speculative-crypto': true, 'equity-day': false, 'equity-swing': false, 'options-system': false, 'options-quickflips': false } },
  pendingOrders: [], activePositions: [], tradeJournal: [], discardedOrders: [], savedSetups: [], pilotActions: [] }));
const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name)))
  : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const serverFiles = walk(path.join(ROOT, 'server'));
const refs = (re) => serverFiles.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(path.join(ROOT, 'server'), f).split(path.sep).join('/')).sort();

(async () => {
  const lock = require(S + 'risk/paper-lock');
  const L = require(S + 'execution/paper-ledger');
  const router = require(S + 'execution/order-router');

  // ---------- 1. Paper-only lock ----------
  const s0 = L.getSettings();
  check('lock: a ledger saved with both books LIVE loads PAPER (stockMode / cryptoMode), paperOnly reported', s0.stockMode === 'paper' && s0.cryptoMode === 'paper' && s0.paperOnly === true, `${s0.stockMode}/${s0.cryptoMode}/${s0.paperOnly}`);
  const e1 = await throws(() => L.updateSettings({ cryptoMode: 'live' }));
  check('lock: saving a LIVE mode is refused with PAPER_ONLY_LOCK and changes nothing', /^PAPER_ONLY_LOCK/.test(e1 || '') && L.getSettings().cryptoMode === 'paper', e1);
  const e2 = await throws(() => L.updateSettings({ stockMode: 'live', bankroll: 12345 }));
  check('...a save mixing a live mode with other fields applies none of them', /^PAPER_ONLY_LOCK/.test(e2 || '') && L.getSettings().bankroll === 10000);
  L.updateSettings({ bankroll: 11000 });
  check('...other settings still save', L.getSettings().bankroll === 11000);
  // The router's own wall: a mode that reads live (set up with the lock lifted in-process) is still refused before any broker call.
  const cb = require(S + 'connectors/coinbase-api'); const sent = []; const origSubmit = cb.submitOrder;
  cb.submitOrder = async (...a) => { sent.push(a); return { ok: false, error: 'stub' }; };
  lock.PAPER_ONLY = false; L.updateSettings({ cryptoMode: 'live' }); lock.PAPER_ONLY = true;
  const e3 = await throws(() => router.routeApproved({ id: 'ph91-live', market: 'crypto', asset: 'ETH-USD', direction: 'long', positionSize: 0.01 }, 2000));
  check('lock: the order router refuses a LIVE entry route with PAPER_ONLY_LOCK; no broker call', /^PAPER_ONLY_LOCK/.test(e3 || '') && sent.length === 0, e3);
  L.updateSettings({ cryptoMode: 'paper' }); cb.submitOrder = origSubmit;
  const e4 = await throws(() => require(S + 'execution/manual-trade').toCandidate({ mode: 'crypto', asset: 'ETH-USD', venue: 'live', amount: 50 }, Date.now()));
  check('lock: the Manual Trade Ticket refuses venue live with PAPER_ONLY_LOCK', /^PAPER_ONLY_LOCK/.test(e4 || ''), e4);
  const users = refs(/require\([^)]*paper-lock/);
  check('lock: only the three ENTRY choke points use it (exits are never gated)', JSON.stringify(users) === JSON.stringify(['execution/ledger-store.js', 'execution/manual-trade.js', 'execution/order-router.js']), users.join(', '));

  // ---------- 2. Manual-approval guarantee ----------
  check('guarantee: execution/auto-paper.js is gone and the pipeline no longer references it',
    !fs.existsSync(S + 'execution/auto-paper.js') && !/auto-paper/.test(fs.readFileSync(S + 'execution/pipeline.js', 'utf8')));
  const callers = refs(/approveWithGuard|routeApproved|QUEUE_ACTIONS/).filter((f) => f !== 'execution/order-router.js');
  check('guarantee: outside order-router only message-handler references approveWithGuard / routeApproved / QUEUE_ACTIONS',
    JSON.stringify(callers) === JSON.stringify(['execution/message-handler.js']), callers.join(', '));
  const e5 = await throws(() => router.approveWithGuard('ph91-none'));
  const e6 = await throws(() => router.approveWithGuard('ph91-none', { actor: 'system' }));
  const e7 = await throws(() => router.approveWithGuard('ph91-none', { actor: 'user' }));
  check('guarantee: approveWithGuard without actor "user" -> APPROVAL_REQUIRES_USER; with it the approval proceeds (here: no such order)',
    /^APPROVAL_REQUIRES_USER/.test(e5 || '') && /^APPROVAL_REQUIRES_USER/.test(e6 || '') && /^no pending order/.test(e7 || ''), `${e5} | ${e6} | ${e7}`);
  let seen = null; const origApprove = router.QUEUE_ACTIONS.APPROVE;
  router.QUEUE_ACTIONS.APPROVE = async (id, msg) => { seen = msg; return { status: 'pending' }; };
  const handle = require(S + 'execution/message-handler').createMessageHandler({ send: () => {}, broadcast: () => {} });
  await handle({}, JSON.stringify({ type: 'APPROVE', id: 'ph91-x', actor: 'system' }));
  router.QUEUE_ACTIONS.APPROVE = origApprove;
  check('guarantee: a client APPROVE is passed on as the signed-in user\'s (an "actor" in the message is overwritten)', !!seen && seen.actor === 'user', JSON.stringify(seen));
  check('guarantee: the quickFlipsAutoPaper setting is gone (an old saved value is dropped silently)', !('quickFlipsAutoPaper' in L.getSettings()));

  // ---------- 3. Radar migration, crypto manual-only ----------
  const tg = require(S + 'strategies/strategy-toggles'); const s3 = L.getSettings();
  const RADAR_IDS = ['equity-day', 'equity-swing', 'options-system', 'options-quickflips']; const CRYPTO = ['crypto-swing', 'crypto-intraday', 'speculative-crypto'];
  check('radar: the migration switched the four stock / options scanners ON once and crypto OFF (radarVersion 1)',
    RADAR_IDS.every((id) => s3.strategiesEnabled[id] === true) && CRYPTO.every((id) => s3.strategiesEnabled[id] === false) && s3.radarVersion === 1, JSON.stringify(s3.strategiesEnabled));
  L.updateSettings({ strategiesEnabled: { ...s3.strategiesEnabled, 'equity-swing': false, 'crypto-intraday': true } });
  const s3b = L.getSettings();
  check('radar: a radar scanner switched off stays off; a crypto switch sent ON is saved OFF (manual-only)', s3b.strategiesEnabled['equity-swing'] === false && s3b.strategiesEnabled['crypto-intraday'] === false);
  const reread = JSON.parse(execFileSync(process.execPath, ['-e', `const L = require(${JSON.stringify(S + 'execution/paper-ledger')}); console.log(JSON.stringify(L.getSettings().strategiesEnabled))`],
    { env: { ...process.env, ...ENV }, encoding: 'utf8' }).trim().split('\n').pop());
  check('radar: after a restart the user\'s OFF stays off (the migration does not re-run)', reread['equity-swing'] === false && reread['equity-day'] === true, JSON.stringify(reread));
  check('radar: crypto scanners never run, even with a map that says on', !tg.isEnabled('crypto-intraday', { strategiesEnabled: { 'crypto-intraday': true } }) && !tg.isEnabled('speculative-crypto', {}) && tg.isEnabled('equity-day', {}));
  check('radar: applyRadar runs once (null at version 1) and fresh-install defaults are the radar set', tg.applyRadar(1, { 'equity-swing': false }) === null && !!tg.applyRadar(undefined, {})
    && RADAR_IDS.every((id) => tg.DEFAULTS[id] === true) && CRYPTO.every((id) => tg.DEFAULTS[id] === false));
  check('radar: Settings data lists the crypto scanners as manual-only', JSON.stringify(s3.strategyManualOnly) === JSON.stringify(CRYPTO));
  L.updateSettings({ strategiesEnabled: { ...s3b.strategiesEnabled, 'equity-swing': true } });

  // ---- end of sections ----
  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
