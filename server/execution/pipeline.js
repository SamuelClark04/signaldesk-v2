// Master execution loop: Connectors -> Strategies -> Risk Engine -> Ledger -> Notifier,
// every PIPELINE_INTERVAL_MS, plus exit management for open positions.
// Strategies only propose; the risk engine decides; only the ledger holds state.
// server.js injects broadcast() so this module never touches sockets directly.
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const alpacaNews = require('../connectors/alpaca-news-socket');
const cryptoIntraday = require('../strategies/2-crypto-intraday'); // 15m / 1h day trades (startup backfill)
const runner = require('./strategy-runner'); // Phase 75: crypto first, a time budget per strategy (a slow options scan never blocks Moonshots)
const { processCandidate } = require('../risk/risk-engine');
const strictness = require('../risk/strictness');
const { sizingBankroll } = require('../risk/venue-capital');
const { computeProximity } = require('../intelligence/trigger-proximity');
const { computeTriggers } = require('../intelligence/watch-triggers');
const ledger = require('./paper-ledger');
const { sendApprovalAlert } = require('./notifier');
const { stackingConflict } = require('./order-guard');
const portfolioRisk = require('../risk/portfolio-risk'); // Phase 77: open-risk ceiling + equity direction limit
const entryShields = require('../risk/entry-shields'); // Phase 81: daily loss kill switch, macro blackout, sector cap (entries only)
const exitPass = require('./exit-pass');
const cryptoRouter = require('./crypto-router'); // Phase 69A: OKX -> Kraken -> Coinbase waterfall // broker reconciliation (first in every pass) + paper exits (Phase 67)
const { recordRejection: recordStat } = require('./rejection-stats');
const scanLog = require('./scan-log');
const watchlist = require('./watchlist');
const { publishIntelligence } = require('../intelligence/dashboard-intel');
const prices = require('../market/latest-prices');
const macro = require('../connectors/macro-events');
const { reviewHoldings } = require('./pilot-handler');
const expirySweeper = require('./expiry-sweeper'); // expired setups leave the queue within 30 s
const moonshotRadar = require('../intelligence/moonshot-radar'); // MOONSHOT_RADAR: 100-point score, every watchlist gem
const discovery = require('../connectors/coinbase-discovery'); // Coinbase gem catalog (System 6)
const afterHours = require('./after-hours-plans'); // options plans priced on the last close (OPTIONS_PLANS)
const session = require('../market/market-session'); // is the US session open (Alpaca clock, else ET hours)
const loop = require('./loop-pace'); // Phase 72: yield between symbols / stages (low-vCPU VM)
const { spreadGate, volumeGate, depthGate, MAX_CRYPTO_SPREAD, MAX_MOONSHOT_SPREAD } = require('../risk/break-even'); // crypto liquidity gates (65 / 65B / 66)

const PIPELINE_INTERVAL_MS = 60000;
const STARTUP_PASS_MS = 8000; // first pass soon after boot: Watching, the Pilot matrix and the radar never wait a minute

let broadcast = () => {}; // set by startPipeline()
let pipelineTimer = null;
let lastPricesKey = null;
let proximityState = { items: [], thresholdPct: 0.015, at: null };
const getProximity = () => proximityState;

// Every dropped setup goes to the day's tally ("Why we passed", counted once)
// and to the live scanner log (every pass, collapsed while it repeats).
function recordRejection(id, reason, candidate) {
  recordStat(id, reason, candidate);
  scanLog.rejected(id, reason, candidate || {});
}

// One pass: strategies propose, the risk engine decides, the ledger holds state; one candidate failing never
// stops the others. SCAN_STATUS ("Complete · 3 seconds") when a pass starts / ends; priceTimes: each price's age.
let pipelineRunning = false;
const scanStatus = { running: false, trigger: null, startedAt: null, finishedAt: null, durationMs: null, counts: null, priceTimes: {}, intervalMs: PIPELINE_INTERVAL_MS };
const getScanStatus = () => ({ ...scanStatus, counts: scanStatus.counts && { ...scanStatus.counts }, priceTimes: { ...scanStatus.priceTimes }, session: session.status() });

async function runPipeline({ trigger = 'timer' } = {}) {
  if (pipelineRunning) return console.warn('[pipeline] previous pass still running; skipping this tick');
  pipelineRunning = true;
  const startedAt = Date.now();
  Object.assign(scanStatus, { running: true, trigger, startedAt });
  broadcast('SCAN_STATUS', getScanStatus());
  let counts = null;
  try {
    // Phase 73: a pass gets PASS_WATCHDOG_MS (45 s); past it the lock is released and the stalled pass abandoned.
    const r = await loop.watchdog(loop.inPass(() => pipelinePass()));
    counts = r && r.timedOut ? null : r;
    return counts;
  } finally {
    pipelineRunning = false;
    let priceTimes = {};
    try { priceTimes = prices.getPriceTimes(); } catch { /* keep empty */ }
    Object.assign(scanStatus, { running: false, finishedAt: Date.now(), durationMs: Date.now() - startedAt, counts, priceTimes });
    broadcast('SCAN_STATUS', getScanStatus());
  }
}

// Fire-and-forget alert for a freshly staged order. Not awaited, so a slow
// notifier can never stall the loop; sync throws and rejections are both caught.
function notify(order) {
  Promise.resolve()
    .then(() => sendApprovalAlert(order))
    .catch((err) => console.error(`[notifier] alert for ${order.id} failed: ${err.message}`));
}

async function pipelinePass() {
  const counts = { generated: 0, approved: 0, staged: 0 };
  // Broker truth FIRST (Phase 67): fills, exits and voids that happened at the broker (also while
  // SignalDesk was offline) are booked before any strategy runs or any setup is sized / staged.
  await loop.during('broker-reconcile', () => exitPass.reconcile(broadcast)); // named: a stall here is reported as such
  await loop.during('exit-pass', () => exitPass.run(broadcast)); // Phase 73: exits first, never behind the scan (held option quotes, PAPER exits)
  // Macro/FDA calendar (re-read every few hours): every setup is tagged with the
  // scheduled events inside its expected hold (candidate.catalysts).
  try { if (await macro.refresh()) broadcast('MACRO_EVENTS', macro.upcoming()); } catch (err) { console.error('[pipeline] macro calendar failed:', err.message); }
  // Open / staged trades on Coinbase gems keep streaming (exits and approvals need live prices).
  discovery.stream([...ledger.getActivePositions(), ...ledger.getPendingOrders()].filter((p) => p.market === 'crypto').map((p) => p.asset));
  const candidates = await runner.collect();
  // Strategy-level blocks (Earnings Shield, resistance over the target) are rejections too.
  for (const b of runner.takeBlocks()) recordRejection(b.id, b.reason, b.candidate);
  // Scanner log: what each strategy concluded per symbol on this pass.
  for (const [id, scan] of runner.scans()) scanLog.scanned(id, scan);
  // Read once per pass: every candidate is sized with the same risk profile
  // (Settings: 0.5% / 1% / 2%) and Max Capital Per Trade (5-25%) against the
  // capital of the venue it would execute on: the paper bankroll, or the LIVE
  // broker account (cached ~60 s).
  const settings = ledger.getSettings();
  const shieldState = entryShields.refresh(ledger, settings); // today's P/L (may trip the kill switch) + the macro blackout
  const { riskPct, maxCapitalPct } = settings;
  counts.generated = candidates.length;

  afterHours.begin();
  const cryptoLive = settings.cryptoMode === 'live';
  if (candidates.some((c) => c.market === 'crypto')) await cryptoRouter.prepare({ live: cryptoLive }).catch(() => {}); // pair lists (+ live cash) before routing
  for (const candidate of candidates) {
    await loop.pace();
    candidate.catalysts = macro.catalystsFor(candidate);
    // No live price, or an option with the US session closed (market-session.js: the
    // clock, never a missing price, Phase 59B): never staged. With the market closed an
    // options setup goes through the risk engine and is shown as a reviewable plan;
    // in the session a missing price is just "not yet" (the REST poller fills it).
    const open = session.isEquityMarketOpen();
    if (!(prices.getLatestPrice(candidate.asset) > 0) || (candidate.market === 'options' && !open)) {
      const plan = candidate.market === 'options' && !open ? await afterHours.review(candidate, settings) : null;
      recordRejection(candidate.id, plan ? plan.reason : candidate.market !== 'crypto' && open ? 'NO_LIVE_PRICE: market open, no fresh price yet; re-checked next pass'
        : 'MARKET_CLOSED: setup on the last session close; re-checked on live prices at the open', candidate);
      continue;
    }
    // Phase 65B: never stage a crypto setup into a wide or thin book. Standard crypto: <= 0.45% spread and
    // >= $1.5M of 24h volume; Moonshots: <= 0.80% (their own volume floors are System 6's).
    const book = candidate.market === 'crypto' ? spreadGate(candidate.asset, candidate.speculative ? MAX_MOONSHOT_SPREAD : MAX_CRYPTO_SPREAD) : null;
    const depth = candidate.market === 'crypto' && !candidate.speculative ? volumeGate(candidate.asset) : null;
    const thin = [book, depth].find((g) => g && !g.ok);
    if (thin) { recordRejection(candidate.id, thin.reason, candidate); continue; }
    if (candidate.market === 'crypto') Object.assign(candidate, cryptoRouter.fields(cryptoRouter.preRoute(candidate.asset, { live: cryptoLive }))); // cheapest venue listing it (live: and funded)
    const capital = await sizingBankroll(candidate.market, settings, candidate.venue);
    if (!capital.ok) {
      // Fail closed: a LIVE setup is never sized from the paper bankroll.
      console.warn(`[pipeline] rejected ${candidate.id}: ${capital.reason}`);
      recordRejection(candidate.id, capital.reason, candidate);
      continue;
    }
    const result = processCandidate(candidate, capital.bankroll, { riskPct, maxCapitalPct, sizingBasis: capital.basis, cashCap: capital.cash });
    if (!result.approved) {
      console.log(`[pipeline] rejected ${result.candidateId}: ${result.reason}`);
      recordRejection(result.candidateId, result.reason, candidate); // counted once per setup per reason
      continue;
    }
    const top = result.market === 'crypto' ? depthGate(result.asset, result.notional) : null; // Phase 66: can the best ask take the order?
    if (top && !top.ok) { recordRejection(result.id, top.reason, candidate); continue; }
    const stack = stackingConflict(result, ledger.getActivePositions(), ledger.getPendingOrders()); // Phase 68 / 76: one automated trade per symbol
    if (stack) { recordRejection(result.id, stack, candidate); continue; }
    const bookRisk = portfolioRisk.check(result, { positions: ledger.getActivePositions(), pending: ledger.getPendingOrders(), bankroll: capital.bankroll, settings });
    if (bookRisk) { recordRejection(result.id, bookRisk, candidate); continue; }
    const shield = entryShields.check(result, { positions: ledger.getActivePositions(), pending: ledger.getPendingOrders(), journal: ledger.getTradeJournal(), settings });
    if (shield) { recordRejection(result.id, shield, candidate); continue; }
    counts.approved += 1;
    try {
      const staged = ledger.stageOrder(result);
      counts.staged += 1;
      scanLog.staged(result);
      broadcast('order:staged', staged);
      console.log(`[pipeline] staged ${result.id}: ${result.positionSize} @ ${result.entryPrice}, stop ${result.invalidation}`);
      if (result.capitalCapped) console.warn(`[pipeline] ${result.id}: CAPITAL CAP ${result.capitalCapPct * 100}% of bankroll bound the size; `
        + `risking ${(result.actualRiskPct * 100).toFixed(2)}% instead of ${(result.riskPct * 100).toFixed(2)}% (stop is tight relative to price)`);
      notify(staged);
      require('./auto-paper').consider(staged, { settings, broadcast }); // Phase 89: qualified Quick Flips execute on paper at once (not awaited)
    } catch (err) {
      // Expected when the same setup is re-proposed on the next tick (duplicate id).
      console.log(`[pipeline] not staged ${result.id}: ${err.message}`);
    }
  }

  // Phase 70B: staged crypto setups move to the cheapest funded venue (a deposit, cash spent).
  try {
    const moved = await require('./route-refresh').refreshRoutes(ledger, settings, { live: cryptoLive, isBusy: require('./order-router').isBusy });
    if (moved.length) broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
  } catch (err) { console.error('[pipeline] route refresh failed:', err.message); }

  // After staging (Phase 62): each radar row's gate verdict reflects this pass's risk-engine outcome.
  try { await loop.during('moonshot-radar', () => moonshotRadar.publish(broadcast, prices.getLatestPrices())); } catch (err) { console.error('[pipeline] moonshot radar failed:', err.message); }

  // Exit management (LIVE positions were reconciled at the top of the pass).
  // Live prices: watchlist last prices, and PRICES_UPDATED for the Setups view
  // (each broadcast only when a price actually moved).
  try {
    const latest = prices.getLatestPrices();
    watchlist.syncPrices(latest);
    const key = JSON.stringify([...latest]);
    if (key !== lastPricesKey) {
      lastPricesKey = key;
      broadcast('PRICES_UPDATED', Object.fromEntries(latest));
    }
  } catch (err) {
    console.error('[pipeline] price sync failed:', err.message);
  }

  // "Watching": each symbol's nearest live trigger level, from real bars.
  try {
    // Marks: a closed-market stock is measured from its last session close (never "Waiting for a price").
    watchlist.setTriggers(await loop.during('watch-triggers', () => computeTriggers(watchlist.getWatchlist(), prices.getMarkPrices(), alpacaStocks.getLatestBars())));
  } catch (err) {
    console.error('[pipeline] watch triggers failed:', err.message);
  }

  // Portfolio Pilot defense: SELL under the 200-day SMA, TRIM when far extended (Approvals queue).
  try { await loop.during('portfolio-pilot', () => reviewHoldings(broadcast)); } catch (err) { console.error('[pipeline] pilot review failed:', err.message); }

  // "Heating up": distance to each strategy's trigger (Market Watch filter).
  try {
    const next = await loop.during('trigger-proximity', () => computeProximity(alpacaStocks.getLatestBars(), prices.getLatestPrices()));
    if (JSON.stringify(next.items) !== JSON.stringify(proximityState.items)) broadcast('TRIGGER_PROXIMITY', next);
    proximityState = next;
  } catch (err) {
    console.error('[pipeline] trigger proximity failed:', err.message);
  }

  // Dashboard intelligence (attention alerts + market context), after exits settle.
  try { await loop.pace(); publishIntelligence(broadcast); } catch (err) { console.error('[pipeline] dashboard intelligence failed:', err.message); }

  try { broadcast('PORTFOLIO_RISK', portfolioRisk.summary(ledger.getActivePositions(), settings, { stocks: settings.bankroll, crypto: settings.cryptoBankroll })); } catch (err) { console.error('[pipeline] portfolio risk failed:', err.message); }
  broadcast('ENTRY_SHIELDS', shieldState); // Phase 81: the Today / Opportunities banners
  afterHours.publish(broadcast); // OPTIONS_PLANS (after-hours options plans that cleared the risk engine)
  scanLog.publish(); // SCAN_LOG to every client (server.js)
  console.log(`[pipeline] candidates=${counts.generated} approved=${counts.approved} staged=${counts.staged}`);
  return counts;
}

// Starts the 60s loop. Returns handles for manual passes (tests) and shutdown.
function startPipeline(options = {}) {
  if (pipelineTimer) throw new Error("pipeline: already started");
  if (typeof options.broadcast === "function") broadcast = options.broadcast;
  expirySweeper.start(broadcast);
  exitPass.reconcile(broadcast); // Phase 67: book what the broker did while SignalDesk was down, right at boot (errors are logged inside)
  loop.watch(); // Phase 72: '[loop] event loop blocked N s (during X)' when the thread stalls
  exitPass.startFast(broadcast); // Phase 73: PAPER stops / targets every 5 s, independent of the pass
  require('../services/macro-calendar').start(); // Phase 81: high-impact USD releases (boot + daily 06:00 ET)
  require('./live-sync').start(ledger, broadcast); // Phase 79: a LIVE trade opened / closed -> broker holdings re-synced (Portfolio)
  require('./options-migration').run(ledger, broadcast); // Phase 58 stats + mid-hold targets on open option spreads
  require('./exit-quote').start(ledger, broadcast); // POSITION_MARKS every 5 s: "Net if closed now" (Phase 59)
  require('../market/stock-poller').start(); // REST prices for stocks past the 30-symbol stream (Phase 59B)
  require('../connectors/coinbase-fees').start(); // the account's real Coinbase fee tier (Phase 65)
  cryptoIntraday.backfill().catch((err) => console.error('[pipeline] intraday backfill failed:', err.message)); // 15m + 1h history for all pairs
  pipelineTimer = setInterval(() => {
    runPipeline().catch((err) => console.error('[pipeline] pass failed:', err));
  }, PIPELINE_INTERVAL_MS);
  setTimeout(() => runPipeline({ trigger: 'startup' }).catch((err) => console.error('[pipeline] startup pass failed:', err)), STARTUP_PASS_MS).unref();
  const { bankroll, riskProfile, riskPct, stockMode, cryptoMode } = ledger.getSettings();
  console.log(`[pipeline] running every ${PIPELINE_INTERVAL_MS / 1000}s, bankroll $${bankroll}, risk ${riskProfile} ${(riskPct * 100).toFixed(1)}%/trade, `
    + `stocks/options ${String(stockMode).toUpperCase()}, crypto ${String(cryptoMode).toUpperCase()} `
    + `strictness ${strictness.describe()} (all editable in Settings)`);
  return { runPipeline, stop: stopPipeline };
}

function stopPipeline() {
  clearInterval(pipelineTimer);
  pipelineTimer = null;
}

module.exports = { startPipeline, stopPipeline, runPipeline, getScanStatus, getProximity, PIPELINE_INTERVAL_MS };
