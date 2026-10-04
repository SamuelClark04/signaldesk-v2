# Radar Mode (Phase 91) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SignalDesk never opens a trade on its own and never sends a live entry: scanners stage setups into Approvals as labelled alerts, the user clicks to execute on paper, exits stay automatic, and Quick Flips shows a self-contained radar card.

**Architecture:** A code-constant paper lock (`server/risk/paper-lock.js`) enforced at the three entry choke points (settings validation, order router, Manual Trade Ticket); auto-paper deleted and `approveWithGuard` gated on `actor: 'user'` set only by `message-handler`; a one-time radar migration in `strategy-toggles` / `ledger-store` (stock / options scanners on, crypto manual-only); one evidence record per strategy copied onto each staged setup; two client components (`evidence-badge.js`, `quickflip-card.js`).

**Tech Stack:** Node 20 (CommonJS), Express + ws server, vanilla JS client (IIFE components on `window.SignalDesk`), standalone `node tests/phNNunit.js` suites.

**Spec:** `docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md` (approved 2026-10-04, decisions 1-4 approved as written).

## Global Constraints

- <= 300 lines per `.js` / `.css` file (`server/server.js` < 200); run `npm run check:limits` before every commit.
- Never touch the user's live server (`node server\server.js`); stop only processes you started, matched by script name.
- Tests set `LEDGER_STATE_PATH`, `WATCHLIST_PATH`, `EXTERNAL_HOLDINGS_PATH`, `CREDENTIALS_PATH`, `RADAR_CACHE_PATH`, `CATALYSTS_PATH`, `PAPER_RUNS_PATH` to scratch files and every broker / AI / SMTP URL to dead or local values BEFORE requiring any server module; never the real ledger or `.env` keys.
- `PAPER_ONLY = true` is a code constant: no setting, UI, `.env` or file may lift it. Only code inside the process (tests of LIVE paths on mocks) may set `require('.../risk/paper-lock').PAPER_ONLY = false` before requiring other server modules.
- Exits are never gated by the lock: reconcile, stops / targets / ratchet / time exits, [Close], [Close at Coinbase], [Mark closed externally].
- Error codes (exact): `PAPER_ONLY_LOCK`, `APPROVAL_REQUIRES_USER`.
- Evidence labels (exact): `PF 0.86 · Failed`, `PF 1.11 · Failed`, `PF 0.75 · Failed`, `PF 1.41 dev · Failed`, `PF 0.82-0.96 · Failed`, `PF 0.81 · Failed`, `PF 0.58 · Failed`, `Pilot · not backtested`, `Untested`.
- Radar ids: `equity-day`, `equity-swing`, `options-system`, `options-quickflips`. Crypto manual-only ids: `crypto-swing`, `crypto-intraday`, `speculative-crypto`. `RADAR.version` = 1 (`settings.radarVersion`).
- Multi-line edits: use the Edit tool (or a scratch `.js` script), never `sed` / heredoc quoting on source files (it has broken edits before). Files are CRLF / LF mixed: match exactly.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push to `origin main` only in Task 7.

## Review Focus

1. A Trade Amount change on an Approvals card (resizeOrder) must keep the setup paper and keep its evidence label (Task 4 test).
2. A Quick Flips PUT (short) card must read "below" / "put", not the call wording (Task 6 test).
3. Quick Flips setups staged BEFORE the deploy lack `orHigh` / `relVol` / `signalAt`: the card still renders from `trigger`; one with no `optionsData.quickFlip` falls back to the generic block (Task 6 test).
4. Manual-ticket and adopted positions have no strategy to judge: no badge at all, never "Untested" (Task 4 test).
5. A radar scanner the user switches OFF must stay off after a restart (the migration must not re-run) (Task 3 test, child-process re-read).

---

### Task 1: Paper-only lock

**Files:**
- Create: `server/risk/paper-lock.js`
- Modify: `server/execution/ledger-store.js` (choice validation, `getSettings`)
- Modify: `server/execution/order-router.js:70-76` (`routeApproved`)
- Modify: `server/execution/manual-trade.js` (requires, `toCandidate`, the `liveAllowed` field near line 115)
- Test: `tests/ph91unit.js` (create)

**Interfaces:**
- Produces: `paperLock = require('server/risk/paper-lock')` with `PAPER_ONLY` (boolean, read at call time), `MESSAGE` (string starting `PAPER_ONLY_LOCK:`), `checkMode(key, value)` (throws for `stockMode`/`cryptoMode` = `'live'` while locked), `assertPaperEntry(what)` (throws while locked). `getSettings().paperOnly` (boolean). `manual-trade` defaults reply gains `paperOnly`.

- [ ] **Step 1: Write the failing test** — create `tests/ph91unit.js`:

```js
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

  // ---- end of sections ----
  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/ph91unit.js`
Expected: crash `Cannot find module '.../server/risk/paper-lock'`.

- [ ] **Step 3: Create `server/risk/paper-lock.js`**

```js
// Paper-only lock (Phase 91, spec docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md): every NEW entry is paper, in
// every market, whatever a setting says, until a strategy passes a pre-registered test. A code constant on purpose: no setting, UI,
// .env or file can lift it; unlocking is a code change + deploy. Read at call time (lock.PAPER_ONLY), so a test that exercises the
// LIVE paths on mocks lifts it in-process before requiring any other server module. Used ONLY by the entry choke points
// (ledger-store mode validation, order-router, manual-trade): exits, reconcile and closes of existing LIVE positions are never gated.
const MESSAGE = 'PAPER_ONLY_LOCK: SignalDesk is locked to paper trading in every market; nothing was sent to a live broker';
const lock = {
  PAPER_ONLY: true,
  MESSAGE,
  // Settings: stockMode / cryptoMode 'live' is refused while locked (a saved live mode therefore loads as paper).
  checkMode(key, value) {
    if (lock.PAPER_ONLY && (key === 'stockMode' || key === 'cryptoMode') && value === 'live') throw new Error(`${MESSAGE} (${key} stays paper)`);
  },
  // Order router / Manual Trade Ticket: an ENTRY that would execute LIVE.
  assertPaperEntry(what) {
    if (lock.PAPER_ONLY) throw new Error(`${MESSAGE} (${what})`);
  },
};
module.exports = lock;
```

- [ ] **Step 4: Wire `ledger-store.js`**

Add after the line `const toggles = require('../strategies/strategy-toggles');`:
```js
const paperLock = require('../risk/paper-lock'); // Phase 91: stockMode / cryptoMode can never be 'live' while locked
```
In `cleanValue`, replace:
```js
  if (rule.type === 'choice') {
    if (!rule.values.includes(value)) throw new Error(`${key} must be one of: ${rule.values.join(', ')}`);
    return value;
  }
```
with:
```js
  if (rule.type === 'choice') {
    if (!rule.values.includes(value)) throw new Error(`${key} must be one of: ${rule.values.join(', ')}`);
    paperLock.checkMode(key, value); // Phase 91: refused while locked; restoreSettings then keeps the default 'paper' (logged)
    return value;
  }
```
In `getSettings`, change `({ ...settings, strategiesEnabled:` to `({ ...settings, paperOnly: paperLock.PAPER_ONLY, strategiesEnabled:` (the rest of the line unchanged).

- [ ] **Step 5: Wire `order-router.js`**

Add after `const coinbaseSocket = require('../connectors/coinbase-socket');`:
```js
const paperLock = require('../risk/paper-lock'); // Phase 91: no LIVE entry while locked
```
In `routeApproved`, after the line that starts `const paper = settings[venue.modeKey] === 'paper' || order.forcePaper;` add:
```js
  if (!paper) paperLock.assertPaperEntry(`${order.market} ${order.asset} at ${venue.broker}`); // Phase 91: refused before any broker call (stays pending)
```

- [ ] **Step 6: Wire `manual-trade.js`**

Add after `const { feeHurdle, liveQuote } = require('../risk/break-even'); // Phase 63: round-trip fee hurdle, shown before open`:
```js
const paperLock = require('../risk/paper-lock'); // Phase 91: the ticket is paper-only while locked
```
In `toCandidate`, directly after `const venue = mode === 'crypto' && t.venue === 'live' ? 'live' : 'paper';` add:
```js
  if (venue === 'live') paperLock.assertPaperEntry('Manual Trade Ticket, live crypto');
```
Near line 115 replace `liveAllowed: settings.cryptoMode === 'live',` with `liveAllowed: settings.cryptoMode === 'live' && !paperLock.PAPER_ONLY, paperOnly: paperLock.PAPER_ONLY,`.

- [ ] **Step 7: Run the test**

Run: `node tests/ph91unit.js`
Expected: 7 PASS lines, `ALL PASS`. The log shows `[ledger] ignoring saved setting: PAPER_ONLY_LOCK: ... (stockMode stays paper); keeping paper` for both modes.

- [ ] **Step 8: Check limits and commit**

```bash
npm run check:limits
git add server/risk/paper-lock.js server/execution/ledger-store.js server/execution/order-router.js server/execution/manual-trade.js tests/ph91unit.js
git commit -m "Phase 91: paper-only lock at the three entry choke points (settings, router, manual ticket)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Manual-approval guarantee

**Files:**
- Delete: `server/execution/auto-paper.js`
- Modify: `server/execution/pipeline.js:167` (the auto-paper call)
- Modify: `server/execution/order-router.js` (`approveWithGuard`)
- Modify: `server/execution/message-handler.js:41` and `:127` (actor)
- Modify: `server/execution/ledger-store.js` (remove `quickFlipsAutoPaper`; drop a saved value silently)
- Modify: `server/version.js:15` (drop the field)
- Modify: `client/views/settings-portfolio-risk.js:73-76` (remove the toggle)
- Modify: `server/strategies/7-options-quickflips.js:12-13` (header comment)
- Modify: `tests/ph81unit.js:138`, `tests/ph89bunit.js:52-60`
- Test: `tests/ph91unit.js`

**Interfaces:**
- Consumes: `router` (Task 1 test), `refs()` helper.
- Produces: `approveWithGuard(id, { amount, confirmed, actor })` throws `APPROVAL_REQUIRES_USER: ...` unless `actor === 'user'`.

- [ ] **Step 1: Add the failing tests** — insert before `// ---- end of sections ----` in `tests/ph91unit.js`:

```js
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
```

Spec test 5.2 ("a real pipeline pass stages a Quick Flip; it stays pending") is proven structurally here instead: with auto-paper deleted and the static caller check, no server code other than message-handler can approve, and approveWithGuard refuses without the user's actor. A full pipeline pass needs live session bars and option quotes the suite cannot provide deterministically. Likewise spec test 5.5 (exits under the lock) is the Task 1 check that only the three entry choke points require paper-lock.

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/ph91unit.js`
Expected: section 1 PASS; FAIL on auto-paper still present, callers include `execution/auto-paper.js`, `e5` is `no pending order ...`, `seen.actor` undefined, `quickFlipsAutoPaper` present.

- [ ] **Step 3: Remove auto-paper**

Delete the file: `git rm server/execution/auto-paper.js`.
In `pipeline.js` delete the line:
```js
      require('./auto-paper').consider(staged, { settings, broadcast }); // Phase 89: qualified Quick Flips execute on paper at once (not awaited)
```
In `ledger-store.js` delete the line:
```js
  quickFlipsAutoPaper: { type: 'choice', values: [true, false], default: true }, // Phase 89: qualified Quick Flips execute on paper without a click
```
and in `restoreSettings` replace `const { dailyLossLimit, ...rest } = saved; // eslint-disable-line no-unused-vars` with:
```js
  const { dailyLossLimit, quickFlipsAutoPaper, ...rest } = saved; // eslint-disable-line no-unused-vars -- Phase 91: auto-paper removed (dropped silently)
```
In `server/version.js` remove ` quickFlipsAutoPaper: settings.quickFlipsAutoPaper,` from the `report` object (keep the other fields).
In `client/views/settings-portfolio-risk.js` delete these four lines:
```js
      // Phase 89b: qualified Quick Flips execute automatically on paper (the forward test's timing); never real money.
      toggle('Quick Flips: execute automatically on paper', saved.quickFlipsAutoPaper !== false, 'When Options Quick Flips is on (Settings > Strategies), a setup that passed every '
        + 'check is sent to the paper broker at once instead of waiting in Approvals (the replay entered 1-2 minutes after the signal). Paper only: never real money.',
      (v) => SD.settings.request({ quickFlipsAutoPaper: v })),
```
In `server/strategies/7-options-quickflips.js`, replace the two header-comment lines
```js
//   Order      debit = the natural ask; 1 contract (maxContracts); EXECUTED AUTOMATICALLY on paper when settings.quickFlipsAutoPaper
//              (execution/auto-paper.js); the entry must fill by D + 3 min (entryDeadlineAt, as in the replay) or it is canceled
```
with
```js
//   Order      debit = the natural ask; 1 contract (maxContracts); waits in Approvals for the user's click (Phase 91 radar mode: auto-paper
//              removed); the entry must fill by D + 3 min (entryDeadlineAt, as in the replay) or it is canceled
```

- [ ] **Step 4: Gate `approveWithGuard`**

In `order-router.js` replace:
```js
async function approveWithGuard(id, { amount, confirmed } = {}) {
  const order = ledger.getPendingOrders().find((o) => o.id === id);
```
with:
```js
// actor: 'user' only (Phase 91 radar mode): message-handler sets it for a signed-in APPROVE click or Manual Trade Ticket submit;
// nothing else may open a position.
async function approveWithGuard(id, { amount, confirmed, actor } = {}) {
  if (actor !== 'user') throw new Error('APPROVAL_REQUIRES_USER: an entry needs your click (Approve or the Manual Trade Ticket); nothing was sent');
  const order = ledger.getPendingOrders().find((o) => o.id === id);
```

- [ ] **Step 5: Set the actor in `message-handler.js`**

Replace `const result = await QUEUE_ACTIONS[type](id, msg);` with:
```js
      const result = await QUEUE_ACTIONS[type](id, { ...msg, actor: 'user' }); // Phase 91: a signed-in click; a client "actor" is overwritten
```
Replace `const handleManual = require('./manual-trade').createHandler({ send, broadcast, approve: approveWithGuard,` with:
```js
  const handleManual = require('./manual-trade').createHandler({ send, broadcast, approve: (id, o) => approveWithGuard(id, { ...o, actor: 'user' }),
```

- [ ] **Step 6: Update the two suites that called the old behaviour**

`tests/ph81unit.js:138`: replace `approveWithGuard(jpm.id); }` with `approveWithGuard(jpm.id, { actor: 'user' }); }`.
`tests/ph89bunit.js`: replace the block from `// 3. Automatic paper execution (the user's choice), paper only, once, via the normal approval path.` through the `check('...never when the options book is LIVE, ...` statement (its two lines) with:
```js
  // 3. Phase 91: automatic paper execution is gone (radar mode: every entry waits for the user's click).
  check('auto paper removed (Phase 91): execution/auto-paper.js no longer exists', !fs.existsSync(S + 'execution/auto-paper.js'));
```
(`fs` and `S` are defined at the top of ph89bunit.js; confirm with `grep -n "^const fs\|^const S" tests/ph89bunit.js`.)

- [ ] **Step 7: Run the tests**

Run: `node tests/ph91unit.js && node tests/ph81unit.js && node tests/ph89bunit.js`
Expected: ph91 `ALL PASS` (12 checks so far); ph81 `ALL PASS`; ph89b may still FAIL only on assertions about LIVE mode (fixed in Task 7 with the lock lift) — note which; no failure about auto-paper.

- [ ] **Step 8: Check limits and commit**

```bash
npm run check:limits
git add -A server/execution/auto-paper.js server/execution/pipeline.js server/execution/order-router.js server/execution/message-handler.js server/execution/ledger-store.js server/version.js server/strategies/7-options-quickflips.js client/views/settings-portfolio-risk.js tests/ph81unit.js tests/ph89bunit.js tests/ph91unit.js
git commit -m "Phase 91: manual-approval guarantee (auto-paper removed, approveWithGuard needs the user's click)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Radar migration and crypto manual-only

**Files:**
- Modify: `server/strategies/strategy-toggles.js` (constants, DEFAULTS, `isEnabled`, `applyRadar`, exports, header comment)
- Modify: `server/execution/ledger-store.js` (`radarVersion` rule, toggles coercion, migration in `restoreSettings`, `getSettings`)
- Modify: `tests/ph87unit.js:43-44`, `tests/ph89unit.js:22` and its first check
- Test: `tests/ph91unit.js`

**Interfaces:**
- Produces: `toggles.CRYPTO_MANUAL_ONLY` (frozen array of the 3 crypto ids), `toggles.RADAR` (`{ version: 1, on: [4 ids] }`), `toggles.applyRadar(savedVersion, map)` -> new map | null, `toggles.isEnabled(id, settings)` always false for crypto ids, `getSettings().radarVersion` (1), `getSettings().strategyManualOnly` (array).

- [ ] **Step 1: Add the failing tests** — insert before `// ---- end of sections ----`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/ph91unit.js`
Expected: sections 1-2 PASS; section 3 FAILs (radar ids off, `radarVersion` undefined, `applyRadar is not a function`).

- [ ] **Step 3: Edit `strategy-toggles.js`**

Replace the two lines that define `DEFAULTS`:
```js
const DEFAULTS = Object.freeze({ ...Object.fromEntries(IDS.map((id) => [id, true])), 'crypto-swing': false, 'options-system': false, 'options-quickflips': false,
  ...Object.fromEntries(PAUSE.ids.map((id) => [id, false])) });
```
with:
```js
// Phase 91 RADAR MODE (spec docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md): SignalDesk never trades on its own;
// scanners stage setups into Approvals for a click (paper only: risk/paper-lock.js), each labelled with its failed test record
// (strategy-evidence.js). The stock / options scanners are switched ON once (RADAR.version, settings.radarVersion; the user may switch
// them off and it sticks); crypto is MANUAL-ONLY: its scanners never run, whatever a saved switch says.
const CRYPTO_MANUAL_ONLY = Object.freeze(['crypto-swing', 'crypto-intraday', 'speculative-crypto']);
const RADAR = Object.freeze({ version: 1, on: Object.freeze(['equity-day', 'equity-swing', 'options-system', 'options-quickflips']) });
const DEFAULTS = Object.freeze({ ...Object.fromEntries(IDS.map((id) => [id, false])), ...Object.fromEntries(RADAR.on.map((id) => [id, true])) });
```
Replace `isEnabled`:
```js
const isEnabled = (id, settings) => {
  const map = settings && settings.strategiesEnabled;
```
with:
```js
const isEnabled = (id, settings) => {
  if (CRYPTO_MANUAL_ONLY.includes(id)) return false; // Phase 91: crypto is manual-only
  const map = settings && settings.strategiesEnabled;
```
Add after `applyPause` (before `module.exports`):
```js
// Phase 91: radar mode for a ledger saved before it -> the new map (radar ids ON, crypto OFF), or null when already applied.
function applyRadar(savedVersion, map) {
  if (Number(savedVersion) >= RADAR.version) return null;
  return { ...DEFAULTS, ...(map || {}), ...Object.fromEntries(RADAR.on.map((id) => [id, true])), ...Object.fromEntries(CRYPTO_MANUAL_ONLY.map((id) => [id, false])) };
}
```
Replace the exports line with:
```js
module.exports = { isEnabled, applyPause, applyRadar, IDS, LABELS, DEFAULTS, REASONS, PAUSE, PAUSES, RADAR, CRYPTO_MANUAL_ONLY };
```

- [ ] **Step 4: Edit `ledger-store.js`**

After the `strategyPauseVersion:` rule line add:
```js
  radarVersion: { type: 'number', default: toggles.RADAR.version, min: 0, max: 1000, integer: true }, // Phase 91: the radar migration applied
```
In `cleanValue`'s toggles branch replace `return { ...rule.default, ...value };` with:
```js
    return { ...rule.default, ...value, ...Object.fromEntries(toggles.CRYPTO_MANUAL_ONLY.map((id) => [id, false])) }; // Phase 91: crypto manual-only
```
In `restoreSettings`, after `settings.strategyPauseVersion = toggles.PAUSE.version;` add:
```js
  // Phase 91: radar mode, once per ledger (strategy-toggles.RADAR): stock / options scanners ON (alerts only, paper), crypto OFF.
  const radar = toggles.applyRadar(saved.radarVersion, settings.strategiesEnabled);
  if (radar) {
    settings.strategiesEnabled = radar;
    console.warn(`[ledger] Phase 91 radar mode: ${toggles.RADAR.on.join(', ')} switched on (setups wait in Approvals, paper only); crypto scanners manual-only`);
  }
  settings.radarVersion = toggles.RADAR.version;
```
In `getSettings`, after `strategyNotes: { ...toggles.REASONS },` insert ` strategyManualOnly: [...toggles.CRYPTO_MANUAL_ONLY],`.

- [ ] **Step 5: Update the suites that asserted the old defaults**

`tests/ph87unit.js:43-44` — replace the condition `tg.DEFAULTS['options-system'] === false && !tg.isEnabled('options-system', {})` with `tg.DEFAULTS['options-system'] === true && tg.isEnabled('options-system', {})` and the check text `'Options Spreads is OFF by default (new installs), with the replay result under its switch'` with `'Options Spreads is ON by default since Phase 91 (radar mode: alerts only), with the replay result under its switch'`.
`tests/ph89unit.js:22` — in the saved settings object add `radarVersion: 1, ` before `strategiesEnabled: OLD_MAP` (this suite tests the Phase 89 pause, not the radar migration); in its first check replace `map['options-quickflips'] === false` with `map['options-quickflips'] === true` and append to that check's text ` (Quick Flips ON by the Phase 91 radar default)`.

- [ ] **Step 6: Run the tests**

Run: `node tests/ph91unit.js && node tests/ph87unit.js && node tests/ph89unit.js && node tests/ph89bunit.js`
Expected: ph91 `ALL PASS`; ph87 `ALL PASS`; ph89 / ph89b: any remaining FAIL must be a LIVE-mode assertion (Task 7), not a switch default. Inspect each FAIL line.

- [ ] **Step 7: Check limits and commit**

```bash
npm run check:limits
git add server/strategies/strategy-toggles.js server/execution/ledger-store.js tests/ph87unit.js tests/ph89unit.js tests/ph91unit.js
git commit -m "Phase 91: radar migration (stock / options scanners on as alerts) and crypto manual-only" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Evidence records on every staged setup and the alert email

**Files:**
- Create: `server/strategies/strategy-evidence.js`
- Modify: `server/execution/paper-ledger.js:42-53` (`stageOrder`) + requires
- Modify: `server/execution/ledger-store.js` (`getSettings().strategyEvidence`)
- Modify: `server/execution/notifier.js` (`buildAlert` subject, `detailRows`)
- Test: `tests/ph91unit.js`

**Interfaces:**
- Produces: `evidence.of(strategyId)` -> `{ verdict, label, detail, source }` copy | `null` (for `manual`, `adopted-hold`, empty); `evidence.RECORDS`; every staged order has `evidence`; `getSettings().strategyEvidence`.

- [ ] **Step 1: Add the failing tests** — insert before `// ---- end of sections ----`:

```js
  // ---------- 4. Evidence records ----------
  const ev = require(S + 'strategies/strategy-evidence');
  check('evidence: exact labels per strategy', ev.of('equity-swing').label === 'PF 0.86 · Failed' && ev.of('equity-day').label === 'PF 1.11 · Failed' && ev.of('options-system').label === 'PF 0.75 · Failed'
    && ev.of('options-quickflips').label === 'PF 1.41 dev · Failed' && ev.of('crypto-swing').label === 'PF 0.82-0.96 · Failed' && ev.of('crypto-intraday').label === 'PF 0.81 · Failed'
    && ev.of('speculative-crypto').label === 'PF 0.58 · Failed' && ev.of('portfolio-pilot').label === 'Pilot · not backtested' && ev.of('portfolio-pilot').verdict === 'NOT_A_STRATEGY');
  check('evidence: an unknown strategy reads "Untested"; manual / adopted trades get no label at all', ev.of('future-x').label === 'Untested' && ev.of('future-x').verdict === 'UNTESTED'
    && ev.of('manual') === null && ev.of('adopted-hold') === null && ev.of(undefined) === null);
  const qf = require(S + 'strategies/7-options-quickflips'); const { processCandidate, resizeOrder } = require(S + 'risk/risk-engine');
  const now4 = Date.now();
  const pick = (ask) => ({ contract: { symbol: 'SPY261013C00770000', expiration: '2026-10-13', strike: 770, dte: 6, iv: 0.15, delta: 0.52 }, quote: { bid: ask - 0.1, ask, quoteTime: now4 - 2000, delta: 0.52 }, mid: ask - 0.05 });
  const sized = processCandidate(qf.candidate('SPY', { setup: 'S1', dir: 'long', endMin: 590, trigger: 769.5, vwap: 768, spot: 770.2, relVol: 2 }, pick(5.1), now4, 'indicative'), 10000, { riskPct: 0.02 });
  const staged = L.stageOrder(sized); // the exact object processCandidate returned (the risk engine tracks its approvals by identity)
  check('evidence: a staged setup carries its strategy\'s record (as it was at staging)', staged.evidence && staged.evidence.label === 'PF 1.41 dev · Failed' && L.getPendingOrders().some((o) => o.id === sized.id && o.evidence && o.evidence.verdict === 'FAILED'));
  const pend = L.getPendingOrders().find((o) => o.id === sized.id);
  const same = resizeOrder(pend, pend.notional, { confirmed: true });
  check('evidence: a Trade Amount change (resizeOrder) keeps the label', same.approved === true && same.evidence && same.evidence.label === 'PF 1.41 dev · Failed', same.reason || '');
  check('evidence: Settings data carries every record', L.getSettings().strategyEvidence['equity-swing'].label === 'PF 0.86 · Failed');
  const mail = require(S + 'execution/notifier').buildAlert(pend);
  check('evidence: the approval email leads with the label (subject and first detail row)', /\[PF 1\.41 dev · Failed\]/.test(mail.subject) && /Test record\s+PF 1\.41 dev · Failed/.test(mail.text), mail.subject);
  L.discardOrder(sized.id);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/ph91unit.js`
Expected: crash `Cannot find module '.../strategies/strategy-evidence'`.

- [ ] **Step 3: Create `server/strategies/strategy-evidence.js`**

```js
// Each strategy's test record (Phase 91 radar mode): every alert, card, position and email says how its strategy fared on a
// pre-registered test, so a failed strategy never reads as a recommendation. One source for the pipeline (copied onto each staged
// setup by paper-ledger.stageOrder), the email and the UI (getSettings().strategyEvidence). Update a record only from a committed
// results doc in docs/research/. verdict: FAILED | NOT_A_STRATEGY | UNTESTED.
const RECORDS = Object.freeze({
  'equity-swing': Object.freeze({ verdict: 'FAILED', label: 'PF 0.86 · Failed', detail: 'Unseen 2022-10..2024-10: 93 trades, -0.13R a trade; loses in both halves; below its random-entry control', source: 'Phase 90 (docs/research/phase90-results.md)' }),
  'equity-day': Object.freeze({ verdict: 'FAILED', label: 'PF 1.11 · Failed', detail: 'Unseen 2022-10..2024-10: 298 trades; PF 0.94 at stress costs; second half below its random-entry control', source: 'Phase 90 (docs/research/phase90-results.md)' }),
  'options-system': Object.freeze({ verdict: 'FAILED', label: 'PF 0.75 · Failed', detail: '2-year replay: both halves lose; the signals carry no directional information', source: 'Phase 87' }),
  'options-quickflips': Object.freeze({ verdict: 'FAILED', label: 'PF 1.41 dev · Failed', detail: 'Protocol 1: not significant (bootstrap lower bound below 0); on IEX bars PF 1.10 (0.90 stress)', source: 'Phase 89 / 89b (docs/research/phase89-results.md)' }),
  'crypto-swing': Object.freeze({ verdict: 'FAILED', label: 'PF 0.82-0.96 · Failed', detail: 'Every replayed variant lost over 2 x 90 days', source: 'Phase 78' }),
  'crypto-intraday': Object.freeze({ verdict: 'FAILED', label: 'PF 0.81 · Failed', detail: '15-coin list over 2 years: 15m PF 0.81, 1h PF 0.57; revised rules failed on unseen 2022-23', source: 'Phase 89 / 89b' }),
  'speculative-crypto': Object.freeze({ verdict: 'FAILED', label: 'PF 0.58 · Failed', detail: 'Out-of-sample 90 days: PF 0.58 at Coinbase fees (0.74 Kraken, 0.82 OKX)', source: 'Phase 89b' }),
  'portfolio-pilot': Object.freeze({ verdict: 'NOT_A_STRATEGY', label: 'Pilot · not backtested', detail: 'Rebalancing proposals from your deposits and holdings; not a tested entry signal', source: 'Phase 89 results section 10' }),
});
const UNTESTED = Object.freeze({ verdict: 'UNTESTED', label: 'Untested', detail: 'No pre-registered test of this strategy yet', source: null });
const NO_LABEL = new Set(['manual', 'adopted-hold']); // the user's own trades: no strategy to judge
// -> a copy of the record, or null for a manual / adopted trade
function of(strategyId) {
  if (!strategyId || NO_LABEL.has(strategyId)) return null;
  return { ...(RECORDS[strategyId] || UNTESTED) };
}
module.exports = { of, RECORDS, UNTESTED };
```

- [ ] **Step 4: Attach in `paper-ledger.stageOrder`**

Add after `const store = require('./ledger-store');`:
```js
const evidence = require('../strategies/strategy-evidence'); // Phase 91: each setup carries its strategy's test record
```
In `stageOrder` replace `const order = { ...sizedCandidate, status: 'pending', stagedAt: Date.now() };` with:
```js
  const order = { ...sizedCandidate, evidence: sizedCandidate.evidence || evidence.of(sizedCandidate.strategyId), status: 'pending', stagedAt: Date.now() };
```
Then check `resizeOrder` keeps unknown fields: run `grep -n "function resizeOrder" -A 25 server/risk/risk-engine.js` and confirm it builds its result from `{ ...order, ... }`. If it builds a fresh object instead, add `evidence: order.evidence,` to that object.

- [ ] **Step 5: Expose in settings and the email**

`ledger-store.js`: add `const evidence = require('../strategies/strategy-evidence'); // Phase 91` after the paper-lock require, and in `getSettings` insert ` strategyEvidence: { ...evidence.RECORDS },` after ` strategyManualOnly: [...toggles.CRYPTO_MANUAL_ONLY],`.
`notifier.js` `buildAlert`: replace the subject line with:
```js
  const subject = `[ACTION REQUIRED]${o.speculative ? ' [SPECULATIVE MOONSHOT]' : ''}${o.evidence ? ` [${o.evidence.label}]` : ''} SignalDesk: ${o.direction} ${o.asset} (${o.strategyId})`;
```
In `detailRows`, make the evidence the first row: replace `const rows = [` (the first line inside `detailRows`) with:
```js
  const rows = [
    ...(o.evidence ? [['Test record', `${o.evidence.label}: ${o.evidence.detail}`]] : []), // Phase 91: the strategy's record first
```

- [ ] **Step 6: Run the tests**

Run: `node tests/ph91unit.js`
Expected: `ALL PASS`.

- [ ] **Step 7: Check limits and commit**

```bash
npm run check:limits
git add server/strategies/strategy-evidence.js server/execution/paper-ledger.js server/execution/ledger-store.js server/execution/notifier.js server/risk/risk-engine.js tests/ph91unit.js
git commit -m "Phase 91: evidence records on every staged setup, in Settings data and the alert email" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Evidence badge and Settings UI (lock banner, live disabled, strategies panel, ticket note)

**Files:**
- Create: `client/components/evidence-badge.js`, `client/styles/radar.css`
- Modify: `client/index.html` (CSS link, script tags, lock note)
- Modify: `client/views/opportunities-approvals.js` (header badge), `client/views/opportunity-detail.js:66-68`, `client/views/position-detail.js:130`, `client/views/scan-log.js` (rows)
- Modify: `client/views/settings.js` (`renderModes`), `client/views/settings-strategies.js` (render), `client/components/manual-trade-ticket.js:114`
- Test: `tests/ph91unit.js`

**Interfaces:**
- Consumes: `o.evidence` / `p.evidence` (Task 4), `settings.paperOnly` (Task 1), `settings.strategyManualOnly` (Task 3), `settings.strategyEvidence` (Task 4).
- Produces: `window.SignalDesk.evidenceBadge = { text(ev) -> { label, title, kind } | null, badge(ev) -> HTMLElement | null }`.

- [ ] **Step 1: Add the failing test** — insert before `// ---- end of sections ----`:

```js
  // ---------- 5. Evidence badge (client, pure part) ----------
  global.window = { SignalDesk: { ui: { el: (tag, props) => ({ tag, ...props }) } } };
  require(path.join(ROOT, 'client', 'components', 'evidence-badge.js'));
  const EB = window.SignalDesk.evidenceBadge;
  const tb = EB.text(ev.of('equity-swing'));
  check('badge: a FAILED record -> amber "PF 0.86 · Failed" with its detail + source as the tooltip', tb && tb.label === 'PF 0.86 · Failed' && tb.kind === 'is-failed' && /93 trades/.test(tb.title) && /Phase 90/.test(tb.title));
  check('badge: Pilot / Untested are grey; a manual trade (null) renders nothing', EB.text(ev.of('portfolio-pilot')).kind === 'is-neutral' && EB.text(ev.of('x-new')).kind === 'is-neutral' && EB.text(null) === null && EB.badge(null) === null);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/ph91unit.js`
Expected: crash `Cannot find module '.../client/components/evidence-badge.js'`.

- [ ] **Step 3: Create `client/components/evidence-badge.js`**

```js
// Evidence badge (Phase 91 radar mode): a strategy's test record on every alert, card, Scanner row and position ("PF 0.86 · Failed").
// Data: the setup's own evidence (copied at staging from server/strategies/strategy-evidence.js) or settings.strategyEvidence[id].
// A manual / adopted trade has none and shows nothing. Exposes window.SignalDesk.evidenceBadge: text(ev) (pure), badge(ev).
(() => {
  const SD = window.SignalDesk;
  const KIND = { FAILED: 'is-failed', NOT_A_STRATEGY: 'is-neutral', UNTESTED: 'is-neutral' };
  function text(ev) {
    if (!ev || !ev.label) return null;
    return { label: ev.label, title: [ev.detail, ev.source].filter(Boolean).join(' · '), kind: KIND[ev.verdict] || 'is-neutral' };
  }
  function badge(ev) {
    const t = text(ev);
    return t ? SD.ui.el('span', { className: `ev-badge ${t.kind}`, textContent: t.label, title: t.title }) : null;
  }
  SD.evidenceBadge = { text, badge };
})();
```

- [ ] **Step 4: Create `client/styles/radar.css`**

```css
/* Phase 91 radar mode: evidence badges, the Quick Flips radar card, the paper-only lock note. */
.ev-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; border: 1px solid; }
.ev-badge.is-failed { color: var(--warn); border-color: var(--warn); background: rgba(251, 191, 36, 0.10); }
.ev-badge.is-neutral { color: var(--text-muted); border-color: var(--border-strong); background: var(--surface-2); }
.paper-lock-note { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid var(--accent); color: var(--text-muted); font-size: 12px; }
.settings-toggle.is-locked { opacity: 0.55; cursor: not-allowed; }
.qf-card { display: grid; gap: 8px; padding: 10px 0; }
.qf-contract { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.qf-muted { color: var(--text-faint); font-size: 12px; font-family: var(--font-mono); }
.qf-why, .qf-exits { margin: 0; font-size: 13px; }
.qf-exits { color: var(--text-muted); }
.qf-cost { display: grid; gap: 2px; font-size: 12px; }
.qf-row { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed var(--border); padding: 2px 0; }
.qf-k { color: var(--text-muted); }
.qf-countdown { margin: 0; font-weight: 600; color: var(--long); }
.qf-countdown.is-soon { color: var(--warn); }
.qf-countdown.is-expired { color: var(--short); }
@media (max-width: 600px) { .qf-row { flex-direction: column; gap: 0; } }
```

- [ ] **Step 5: Register in `client/index.html`**

After `<link rel="stylesheet" href="styles/paper-runs.css">` add `<link rel="stylesheet" href="styles/radar.css">`.
After `<script src="components/trade-context.js"></script>` add:
```html
  <script src="components/evidence-badge.js"></script>
  <script src="components/quickflip-card.js"></script>
```
After `<span class="live-warning" id="settings-live-warning" hidden></span>` add:
```html
            <p class="paper-lock-note" id="settings-paper-lock" hidden>Paper-only lock: every new entry is paper, in every market. No live broker orders are sent. Existing live positions are still monitored, exited and can be closed.</p>
```
(`quickflip-card.js` is created in Task 6; until then the browser logs a 404 for it, harmless, and nothing calls it.)

- [ ] **Step 6: Badges in the views**

`opportunities-approvals.js`, in `card()`'s header, replace `SD.scannerDetail.badge(o.asset),` with:
```js
        SD.scannerDetail.badge(o.asset),
        ...[SD.evidenceBadge.badge(o.evidence)].filter(Boolean), // Phase 91: the strategy's test record
```
`opportunity-detail.js:68`, replace `el('span', { className: 'opp-meta', textContent: \`${o.setupType || 'Setup'} · ${o.timeframe || '—'}\` })]),` with:
```js
          el('span', { className: 'opp-meta', textContent: `${o.setupType || 'Setup'} · ${o.timeframe || '—'}` }), ...[SD.evidenceBadge.badge(o.evidence)].filter(Boolean)]),
```
`position-detail.js:130`, after the `el('h3', { className: 'opp-section', ... }),` line add:
```js
      ...[SD.evidenceBadge.badge(p.evidence)].filter(Boolean), // Phase 91: opened from a strategy with this test record
```
`scan-log.js`: in `render(state, opts = {})`, change `log.map((e) => entry(e, opts))` to `log.map((e) => entry(e, { ...opts, ev: (state.settings && state.settings.strategyEvidence) || {} }))`; in `entry`, after the `el('strong', { className: 'slog-title', ... }),` line add:
```js
      ...[SD.evidenceBadge.badge(e.strategyId && opts.ev ? opts.ev[e.strategyId] : null)].filter(Boolean), // Phase 91
```

- [ ] **Step 7: Settings: lock and strategies**

`settings.js` `renderModes()`: after the `for (const m of MODE_SELECTS) { ... }` loop (the one setting `.value` and `is-live`) add:
```js
    // Phase 91: the paper-only lock (server/risk/paper-lock.js): Live cannot be chosen; the server refuses it anyway.
    for (const m of MODE_SELECTS) { const opt = $(m.id).querySelector('option[value="live"]'); if (opt) { opt.disabled = !!saved.paperOnly; opt.title = saved.paperOnly ? 'Locked: paper only' : ''; } }
    $('settings-paper-lock').hidden = !saved.paperOnly;
```
`settings-strategies.js`: replace the body of `render` from `const map = saved.strategiesEnabled;` through the end of the `box.replaceChildren(...)` call with:
```js
    const map = saved.strategiesEnabled;
    const labels = saved.strategyLabels || {};
    const notes = saved.strategyNotes || {};
    const manual = new Set(saved.strategyManualOnly || []); // Phase 91: crypto scanners never run
    const records = saved.strategyEvidence || {};
    box.replaceChildren(...Object.keys(labels).map((id) => {
      const locked = manual.has(id);
      const on = !locked && map[id] !== false;
      const t = el('button', { type: 'button', className: `settings-toggle${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`, textContent: locked ? 'Manual-only' : on ? 'On' : 'Off', disabled: locked,
        title: locked ? 'Crypto is manual-only: charts + the Manual Trade Ticket (crypto research is a separate project)' : on ? 'Scanning: setups wait in Approvals for your click (paper only)' : 'Off: not scanned, no new setups (open trades keep their stops / targets)' });
      t.setAttribute('role', 'switch');
      t.setAttribute('aria-checked', String(on));
      t.setAttribute('aria-label', labels[id]);
      if (!locked) t.onclick = () => SD.settings.request({ strategiesEnabled: { ...map, [id]: !on } });
      return el('div', { className: `settings-strategy${on ? '' : ' is-off'}` }, [t, el('div', {}, [el('strong', { textContent: labels[id] }),
        ...[SD.evidenceBadge.badge(records[id])].filter(Boolean),
        ...(notes[id] ? [el('span', { className: 'settings-note', textContent: notes[id] })] : [])])]);
    }));
```
`manual-trade-ticket.js:114`: replace `textContent: 'Live crypto is off: Settings has crypto on PAPER.'` with `textContent: d.paperOnly ? 'Live crypto is locked: SignalDesk is paper-only in every market.' : 'Live crypto is off: Settings has crypto on PAPER.'`.

- [ ] **Step 8: Run the tests and syntax check**

Run: `node tests/ph91unit.js && npm run check:limits`
Expected: `ALL PASS`; limits OK (settings.js <= 300 lines).

- [ ] **Step 9: Commit**

```bash
git add client/components/evidence-badge.js client/styles/radar.css client/index.html client/views/opportunities-approvals.js client/views/opportunity-detail.js client/views/position-detail.js client/views/scan-log.js client/views/settings.js client/views/settings-strategies.js client/components/manual-trade-ticket.js tests/ph91unit.js
git commit -m "Phase 91: evidence badges, paper-only lock in Settings, crypto manual-only switches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Quick Flips radar card

**Files:**
- Modify: `server/strategies/7-options-quickflips.js` (the `candidate(...)` call and `optionsData.quickFlip`)
- Create: `client/components/quickflip-card.js`
- Modify: `client/views/opportunities-approvals.js` (`card()`)
- Test: `tests/ph91unit.js`

**Interfaces:**
- Consumes: `SD.ui.el`, `o.expiresAt` (server setup-ttl: a Quick Flip expires at its entry deadline), `o.optionsData` (bid, ask, debit, multiplier, label, contract, strike, expiration, dte, delta, iv, feed, quoteTime, refAt, exitRule, entryDeadlineAt, quickFlip).
- Produces: `optionsData.quickFlip` gains `relVol`, `orHigh`, `orLow`, `spotAtDecision`, `signalAt` (epoch ms, the signal bar's end). `window.SignalDesk.quickFlipCard = { facts(o, now) -> object | null, body(o, now) -> HTMLElement | null }`.

- [ ] **Step 1: Add the failing tests** — insert before `// ---- end of sections ----`:

```js
  // ---------- 6. Quick Flips radar card ----------
  const et = require(S + 'services/et-time'); const T6 = (h, m, s = 0) => et.toEpoch('2026-10-07', h, m) + s * 1000;
  const pick6 = (ask, type = 'call') => ({ contract: { symbol: `SPY261013${type === 'call' ? 'C' : 'P'}00770000`, expiration: '2026-10-13', strike: 770, dte: 6, iv: 0.15, delta: type === 'call' ? 0.52 : -0.48 },
    quote: { bid: ask - 0.1, ask, quoteTime: T6(9, 50, 50), delta: type === 'call' ? 0.52 : -0.48 }, mid: ask - 0.05 });
  const sig6 = { setup: 'S1', dir: 'long', endMin: 590, trigger: 769.5, vwap: 768, spot: 770.2, relVol: 2, or: { high: 769.5, low: 766.25 } };
  const c6 = qf.candidate('SPY', sig6, pick6(5.1), T6(9, 51), 'indicative');
  check('qf server: the setup carries RelVol, the opening range, the decision spot and the signal time', c6.optionsData.quickFlip.relVol === 2 && c6.optionsData.quickFlip.orHigh === 769.5
    && c6.optionsData.quickFlip.orLow === 766.25 && c6.optionsData.quickFlip.spotAtDecision === 770.2 && c6.optionsData.quickFlip.signalAt === T6(9, 50));
  require(path.join(ROOT, 'client', 'components', 'quickflip-card.js'));
  const QC = window.SignalDesk.quickFlipCard;
  const card6 = { ...c6, expiresAt: c6.optionsData.entryDeadlineAt };
  const f6 = QC.facts(card6, T6(9, 52, 30));
  const row = (k) => (f6.cost.find(([x]) => x === k) || [])[1];
  check('qf card: contract + why (opening range, VWAP, RelVol, signal time)', f6.contract === 'BUY 1 SPY 2026-10-13 770 call' && /opening range 766\.25-769\.5/.test(f6.why) && /VWAP 768/.test(f6.why) && /RelVol 2\.0x/.test(f6.why) && /9:50/.test(f6.why), f6.why);
  check('qf card: cost math per contract (ask $510, spread $10 = 2.0% of mid, $1.30 commission, $11.30 to sell at the bid at once, max loss $154.30 at the -30% stop)',
    /\$510\.00 per contract/.test(row('Ask (your entry limit)')) && /\$10\.00 \(2\.0% of mid\)/.test(row('Bid / ask spread')) && row('Commission') === '$0.65 x 2 = $1.30'
    && row('Cost if sold at the bid right away') === '$11.30' && /^\$154\.30/.test(row('Max loss at the -30% stop')) && /10 s old at the signal/.test(row('Quote')) && /not OPRA/.test(row('Quote')), JSON.stringify(f6.cost));
  check('qf card: the automatic exits are spelled out', /-30% \(\$3\.57\)/.test(f6.exits) && /\+45%/.test(f6.exits) && /VWAP/.test(f6.exits) && /60 min/.test(f6.exits) && /3:40 PM/.test(f6.exits));
  check('qf card: countdown to the entry deadline, closed at 0 (9:54 for a 9:50 signal)', f6.countdown === 'Approve within 1:30' && !f6.expired && QC.facts(card6, T6(9, 54, 1)).expired);
  const p6 = QC.facts({ ...qf.candidate('SPY', { ...sig6, dir: 'short', trigger: 766.25, spot: 765.9 }, pick6(4.2, 'put'), T6(9, 51), 'indicative') }, T6(9, 52));
  check('qf card: a PUT reads "below" and "put"', /put$/.test(p6.contract) && /below the opening range/.test(p6.why) && /still below/.test(p6.why), `${p6.contract} | ${p6.why}`);
  const old6 = JSON.parse(JSON.stringify(card6)); delete old6.optionsData.quickFlip.orHigh; delete old6.optionsData.quickFlip.orLow; delete old6.optionsData.quickFlip.relVol; delete old6.optionsData.quickFlip.signalAt;
  const fo = QC.facts(old6, T6(9, 52));
  check('qf card: a setup staged before the deploy (no new fields) still renders from its trigger; no quickFlip block -> generic card', /trigger 769\.5/.test(fo.why) && !/RelVol/.test(fo.why)
    && QC.facts({ ...card6, optionsData: { ...card6.optionsData, quickFlip: undefined } }) === null);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/ph91unit.js`
Expected: FAIL on the server fields (`relVol` undefined), then crash `Cannot find module '.../quickflip-card.js'`.

- [ ] **Step 3: Server fields in `7-options-quickflips.js`**

Replace `return candidate(symbol, live, pick, now, options.feed());` with:
```js
  return candidate(symbol, { ...live, or: s.or }, pick, now, options.feed()); // Phase 91: the opening range for the radar card
```
In `candidate()`, replace
```js
      quickFlip: { setup: s.setup, signalEndMin: s.endMin, trigger: cents(s.trigger), vwap: cents(s.vwap), maxHoldMin: CONFIG.maxHoldMin, deadlineMin: CONFIG.deadlineMin },
```
with:
```js
      quickFlip: { setup: s.setup, signalEndMin: s.endMin, trigger: cents(s.trigger), vwap: cents(s.vwap), maxHoldMin: CONFIG.maxHoldMin, deadlineMin: CONFIG.deadlineMin,
        relVol: s.relVol, orHigh: s.or ? cents(s.or.high) : null, orLow: s.or ? cents(s.or.low) : null, spotAtDecision: s.spot, // Phase 91: radar card
        signalAt: et.toEpoch(et.ymd(now), Math.floor(s.endMin / 60), s.endMin % 60) },
```

- [ ] **Step 4: Create `client/components/quickflip-card.js`**

```js
// Quick Flips radar card (Phase 91): what an Approvals card shows for an Options Quick Flip, so it can be judged from the card alone:
// the contract, why it fired, the full cost per contract, the exits that run automatically after approval, and the approval window
// (the setup expires at its entry deadline: signal bar end + 60 s + 3 min). facts(o, now) is pure (tested in Node); body(o) builds the
// DOM and ticks its countdown every second while on screen. Exposes window.SignalDesk.quickFlipCard.
(() => {
  const SD = window.SignalDesk;
  const FEE = 0.65; // per contract per fill (the app's options commission model)
  const usd = (x) => `$${Number(x).toFixed(2)}`;
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const countdownOf = (left) => (left > 0 ? `Approve within ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}` : 'Approval window closed: the quote is stale');
  function facts(o, now = Date.now()) {
    const od = o && o.optionsData; const q = od && od.quickFlip;
    if (!od || !q || !(od.ask > 0) || !(od.bid >= 0) || !od.exitRule) return null; // older / partial data: the generic options block
    const m = od.multiplier || 100; const mid = (od.ask + od.bid) / 2; const spread = od.ask - od.bid;
    const word = o.direction === 'short' ? 'below' : 'above';
    const range = q.orLow != null && q.orHigh != null ? `the opening range ${q.orLow}-${q.orHigh}` : `the trigger ${q.trigger}`;
    const base = q.setup === 'S2' ? `VWAP-trend pullback: 5-min close back ${word} the EMA20 ${q.trigger}, VWAP ${q.vwap}` : `5-min close ${word} ${range} and ${word} VWAP ${q.vwap}`;
    const left = Math.max(0, (o.expiresAt || od.entryDeadlineAt || 0) - now);
    return {
      contract: `BUY 1 ${od.label}`,
      occ: od.contract,
      terms: [`${od.dte} DTE`, `strike ${od.strike}`, `expires ${od.expiration}`, Number.isFinite(od.delta) ? `delta ${od.delta.toFixed(2)}` : null, Number.isFinite(od.iv) ? `IV ${(od.iv * 100).toFixed(0)}%` : null].filter(Boolean).join(' · '),
      why: `${base}${Number.isFinite(q.relVol) ? `, RelVol ${q.relVol.toFixed(1)}x` : ''}; still ${word} it at the decision minute${q.signalAt ? ` (signal ${clock(q.signalAt)} ET)` : ''}.`,
      cost: [
        ['Ask (your entry limit)', `${usd(od.ask)} · ${usd(od.ask * m)} per contract`],
        ['Bid', `${usd(od.bid)} · ${usd(od.bid * m)}`],
        ['Bid / ask spread', `${usd(spread * m)} (${((spread / mid) * 100).toFixed(1)}% of mid)`],
        ['Commission', `${usd(FEE)} x 2 = ${usd(2 * FEE)}`],
        ['Cost if sold at the bid right away', usd(spread * m + 2 * FEE)],
        ['Max loss at the -30% stop', `${usd((od.debit - od.exitRule.stopValue) * m + 2 * FEE)} before slippage (stop value ${usd(od.exitRule.stopValue)})`],
        ['Target +45%', `value ${usd(od.exitRule.targetValue)} · ${usd((od.exitRule.targetValue - od.debit) * m - 2 * FEE)} net`],
        ['Quote', `${od.quoteTime && od.refAt ? `${Math.round((od.refAt - od.quoteTime) / 1000)} s old at the signal` : 'age unknown'} · Alpaca ${od.feed || 'indicative'} (not OPRA)`],
      ],
      exits: `After approval these run automatically: -30% (${usd(od.exitRule.stopValue)}) / +45% (${usd(od.exitRule.targetValue)}), a 5-min close back through VWAP, ${q.maxHoldMin || 60} min max hold, closed by 3:40 PM ET.`,
      leftMs: left, expired: left <= 0, countdown: countdownOf(left),
    };
  }
  function body(o) {
    const f = facts(o); if (!f) return null;
    const { el } = SD.ui;
    const cd = el('p', { className: `qf-countdown${f.expired ? ' is-expired' : f.leftMs < 60000 ? ' is-soon' : ''}`, textContent: f.countdown });
    const deadline = o.expiresAt || o.optionsData.entryDeadlineAt || 0;
    const timer = setInterval(() => {
      if (!cd.isConnected) { clearInterval(timer); return; }
      const left = Math.max(0, deadline - Date.now());
      cd.textContent = countdownOf(left);
      cd.className = `qf-countdown${left <= 0 ? ' is-expired' : left < 60000 ? ' is-soon' : ''}`;
      if (left <= 0) clearInterval(timer);
    }, 1000);
    return el('div', { className: 'qf-card' }, [
      el('div', { className: 'qf-contract' }, [el('strong', { textContent: f.contract }), el('span', { className: 'qf-muted', textContent: `${f.occ} · ${f.terms}` })]),
      el('p', { className: 'qf-why', textContent: f.why }),
      el('div', { className: 'qf-cost' }, f.cost.map(([k, v]) => el('div', { className: 'qf-row' }, [el('span', { className: 'qf-k', textContent: k }), el('span', { textContent: v })]))),
      el('p', { className: 'qf-exits', textContent: f.exits }),
      cd,
    ]);
  }
  SD.quickFlipCard = { facts, body };
})();
```

- [ ] **Step 5: Use it in `opportunities-approvals.js` `card()`**

Directly before the line that starts `const approve = el('button', { type: 'button', className: \`btn apv-approve` add:
```js
    const qf = o.strategyId === 'options-quickflips' ? SD.quickFlipCard.facts(o) : null; // Phase 91: the Quick Flips radar card
```
In that `approve` button: change `disabled: busy || !ctx.online ||` to `disabled: busy || !ctx.online || (qf && qf.expired) ||`, and change `textContent: busy ? 'Sending…' : failing.length ?` to `textContent: busy ? 'Sending…' : qf && qf.expired ? 'Expired: quote too old' : failing.length ?`, and change `: blocked ? 'Live options not wired'` to `: qf ? 'Approve (paper)' : blocked ? 'Live options not wired'`.
In the returned article: change the line `el('div', { className: 'apv-grid' }, [` (the first grid, with Size / Entry / Stop / T1 / Risk / Reward) to `...(qf ? [SD.quickFlipCard.body(o)] : [el('div', { className: 'apv-grid' }, [`, and that grid's closing `]),` (after the `kv('Reward : risk', rr),` line) to `])]),`. Prefix the Phase 58 options stats line `...(od && od.stats ? [` with `...(qf ? [] : od && od.stats ? [` (keep the rest of the line; its `: [])` ending stays). Change the thesis element's `textContent: o.thesis ?` to `textContent: qf ? '' : o.thesis ?`.

- [ ] **Step 6: Run the tests**

Run: `node tests/ph91unit.js && node tests/ph89unit.js && npm run check:limits`
Expected: ph91 `ALL PASS`; ph89 FAILs only LIVE-mode ones (Task 7); limits OK.

- [ ] **Step 7: Commit**

```bash
git add server/strategies/7-options-quickflips.js client/components/quickflip-card.js client/views/opportunities-approvals.js tests/ph91unit.js
git commit -m "Phase 91: Quick Flips radar card (contract, why, full cost, automatic exits, approval countdown)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Whole-suite verification, LIVE-path suites, browser check, docs, push

**Files:**
- Modify: suites that test LIVE paths on mocks: `tests/ph83unit.js`, `tests/ph88unit.js`, `tests/ph89unit.js`, `tests/ph89bunit.js`, and in the kit scratchpad (`C:\Users\sammy\AppData\Local\Temp\claude\C--SignalDesk-V2\4faa858b-edf7-4f86-bea7-848ec5e3aa74\scratchpad`): ph53, ph54, ph60, ph60b, ph68, ph69a, ph69b, ph70, ph70d, ph70e, ph70g, ph71, ph71b, ph71c, ph73b, ph78 unit suites
- Create (kit scratchpad): `ph91unit.js` wrapper
- Modify: `CLAUDE.md` (Phase 91 bullet), `docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md` (status line)

- [ ] **Step 1: Lift the lock in LIVE-path suites**

In each listed suite add, immediately after the line that defines `S` (the server path) and BEFORE any other `require(S + ...)`, the line:
```js
require(S + 'risk/paper-lock').PAPER_ONLY = false; // Phase 91: this suite tests the LIVE paths on mocks (the app itself is paper-only)
```
If a kit suite names the server path differently (e.g. `SRV`), use that name; if it requires server modules before defining it, put the line before the first server require using the absolute path `'C:/SignalDesk-V2/server/risk/paper-lock'`.

- [ ] **Step 2: Add the kit wrapper and run every suite**

Create `<kit>/ph91unit.js` containing `require('C:/SignalDesk-V2/tests/ph91unit.js');`.
Run: `bash "<kit>/runall.sh" all91.txt` then `cat "<kit>/all91.txt"`.
Expected: every suite `FAILs=0` and `finished`. For any failure read `<kit>/logs-<suite>.txt`. Classify each: (a) the lock blocking a LIVE-path test: add the Step 1 line; (b) an expectation of the old switch defaults, auto-paper or crypto scanners running: update that expectation to the Phase 91 rule (radar ids on by default, crypto never enabled, no auto-paper) and say so in the check text; (c) anything else is a real regression: stop and fix the code. Re-run until clean.

- [ ] **Step 3: Limits**

Run: `npm run check:limits`
Expected: OK.

- [ ] **Step 4: Browser harness check (port 3999, never the user's server)**

Back up the harness ledger (`copy <kit>/ph77h/ledger.json <kit>/ph77h/ledger.pre91.json`), then create `<kit>/ph91seed.js`:
```js
// Phase 91 harness seed: one pending Quick Flip in the HARNESS ledger (scratch copy), for the radar-card check. Never the real ledger.
process.chdir('C:/SignalDesk-V2');
const D = `${__dirname}/ph77h`; const fs = require('fs');
Object.assign(process.env, { LEDGER_STATE_PATH: `${D}/seed-scratch.json`, WATCHLIST_PATH: `${D}/watch.json`, EXTERNAL_HOLDINGS_PATH: `${D}/ext.json`, CREDENTIALS_PATH: `${D}/vault.json`,
  COINBASE_API_KEY: '', KRAKEN_API_KEY: '', OKX_API_KEY: '', ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_DATA_BASE_URL: 'http://127.0.0.1:9', OPENAI_API_KEY: '', GEMINI_API_KEY: '' });
const S = 'C:/SignalDesk-V2/server/';
const qf = require(S + 'strategies/7-options-quickflips'); const { processCandidate } = require(S + 'risk/risk-engine'); const et = require(S + 'services/et-time');
const evidence = require(S + 'strategies/strategy-evidence');
const now = Date.now(); const p = et.parts(now); const endMin = p.h * 60 + p.m - 1;
const pick = { contract: { symbol: 'SPY261013C00770000', expiration: '2026-10-13', strike: 770, dte: 6, iv: 0.15, delta: 0.52 }, quote: { bid: 5.0, ask: 5.1, quoteTime: now - 4000, delta: 0.52 }, mid: 5.05 };
const o = processCandidate(qf.candidate('SPY', { setup: 'S1', dir: 'long', endMin, trigger: 769.5, vwap: 768, spot: 770.2, relVol: 1.6, or: { high: 769.5, low: 766.25 } }, pick, now, 'indicative'), 10000, { riskPct: 0.02 });
if (!o.approved) throw new Error(`not sized: ${o.reason}`);
const L = JSON.parse(fs.readFileSync(`${D}/ledger.json`, 'utf8'));
L.pendingOrders.push({ ...o, evidence: evidence.of('options-quickflips'), status: 'pending', stagedAt: now, expiresAt: now + 170000 });
fs.writeFileSync(`${D}/ledger.json`, JSON.stringify(L, null, 2));
console.log('seeded', o.id);
```
Run `node "<kit>/ph91seed.js"`, then start the harness in the background: `node "<kit>/ph77srv.js"` (port 3999, harness token `harness-test-token-0123456789abcdef`). The card has under 3 minutes before it expires: check it first. Then open the harness in the built-in browser, sign in with the harness token, and verify:
1. Opportunities > Approvals: the Quick Flip card shows the contract line, the "why" line, eight cost rows, the exits line, a live countdown, the amber `PF 1.41 dev · Failed` badge, and the button `Approve (paper)`.
2. Settings: the paper-only lock note is visible; the Stocks / Crypto mode selects cannot choose Live; Strategies shows the four radar scanners On with amber badges and the three crypto scanners `Manual-only` (disabled).
3. Manual Trade Ticket (crypto): the live option is unavailable with "Live crypto is locked: SignalDesk is paper-only in every market."
Take one screenshot of each. Stop the harness by its script name (PowerShell: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ph77srv.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`) and restore the ledger backup.

- [ ] **Step 5: Docs**

`CLAUDE.md`: add a bullet after the Phase 90 bullet:
```
- **Phase 91 (radar mode: scanner + manual terminal)**: spec docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md. risk/paper-lock.js
  PAPER_ONLY = true (a code constant: no setting / UI / .env lifts it): stockMode / cryptoMode 'live' refused (a saved live mode loads paper),
  order-router refuses a LIVE entry route, the Manual Trade Ticket refuses live (PAPER_ONLY_LOCK); exits / closes of existing LIVE positions are never
  gated. auto-paper.js deleted; order-router.approveWithGuard needs actor 'user', set only by message-handler (APPROVE click, ticket submit);
  APPROVAL_REQUIRES_USER otherwise. Radar migration (settings.radarVersion 1): equity-day / equity-swing / options-system / options-quickflips ON once
  (alerts in Approvals, paper), crypto scanners manual-only (strategy-toggles.isEnabled false whatever is saved). strategies/strategy-evidence.js: each
  strategy's test record, copied onto every staged setup (paper-ledger.stageOrder), in the email subject and on every card (components/evidence-badge.js).
  Quick Flips radar card: components/quickflip-card.js (contract, why, cost per contract, automatic exits, countdown to the entry deadline). Suites that
  test LIVE paths on mocks set require(S + 'risk/paper-lock').PAPER_ONLY = false first. Test: tests/ph91unit.js.
```
In the spec, change `Status: DRAFT for review (2026-10-04).` to `Status: APPROVED 2026-10-04; implemented in Phase 91.`

- [ ] **Step 6: Commit and push**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md tests/ph83unit.js tests/ph88unit.js tests/ph89unit.js tests/ph89bunit.js
git commit -m "Phase 91: radar mode verified (all suites, browser harness); docs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin main
```
Report the final commit hash and the VM deploy command (the user runs it):
```bash
cd ~/signaldesk-v2 && git fetch -q origin && git show <hash>:scripts/deploy-vm.sh > /tmp/deploy-vm.sh && SIGNALDESK_ROOT="$PWD" TARGET=<hash> bash /tmp/deploy-vm.sh
```
