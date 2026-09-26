// Master execution loop: Connectors -> Strategies -> Risk Engine -> Ledger -> Notifier,
// every PIPELINE_INTERVAL_MS, plus exit management for open positions.
// Strategies only propose; the risk engine decides; only the ledger holds state.
// server.js injects broadcast() so this module never touches sockets directly.
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const alpacaNews = require('../connectors/alpaca-news-socket');
const equityDay = require('../strategies/1-equity-day');
const cryptoSwing = require('../strategies/2-crypto-swing');
const cryptoIntraday = require('../strategies/2-crypto-intraday'); // 15m / 1h day trades
const equitySwing = require('../strategies/3-equity-swing');
const optionsSystem = require('../strategies/5-options-system');
const speculativeCrypto = require('../strategies/6-speculative-crypto'); // System 6, additive
const { processCandidate } = require('../risk/risk-engine');
const strictness = require('../risk/strictness');
const { sizingBankroll } = require('../risk/venue-capital');
const { computeProximity } = require('../intelligence/trigger-proximity');
const { computeTriggers } = require('../intelligence/watch-triggers');
const ledger = require('./paper-ledger');
const { sendApprovalAlert } = require('./notifier');
const { stackingConflict } = require('./order-guard');
const exitPass = require('./exit-pass'); // broker reconciliation (first in every pass) + paper exits (Phase 67)
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

// Each strategy runs isolated: one failing never blocks the others' candidates.
const STRATEGIES = [
  ['equity-day', () => equityDay.generateCandidates(alpacaStocks.getLatestBars(), alpacaNews.getNewsContext())],
  ['crypto-swing', () => cryptoSwing.generateCandidates(prices.getLatestPrices())],
  ['crypto-intraday', () => cryptoIntraday.generateCandidates(prices.getLatestPrices())],
  // Marks: live, else the last session close (after hours / weekends the scan still runs; see the staging loop).
  ['equity-swing', () => equitySwing.generateCandidates(prices.getMarkPrices())],
  // Options plan on marks too (after hours: last close + the chain's last quotes); they stage only on live prices.
  ['options-system', () => optionsSystem.generateCandidates(prices.getMarkPrices(), { live: prices.getLatestPrices() })],
  ['speculative-crypto', () => speculativeCrypto.generateCandidates(prices.getLatestPrices())],
];

async function collectCandidates() {
  const all = [];
  for (const [name, generate] of STRATEGIES) {
    try {
      all.push(...(await generate()));
    } catch (err) {
      console.error(`[pipeline] strategy ${name} failed:`, err.message);
    }
  }
  return all;
}

// One pipeline pass. Strategies only propose; the risk engine decides; only
// the ledger holds state. A failure on one candidate never stops the others.
// Scan status for the Scanner ("Complete · 3 seconds"), broadcast as SCAN_STATUS
// when a pass starts and ends. priceTimes gives each fresh price's real age.
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
    counts = await pipelinePass();
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
  await exitPass.reconcile(broadcast);
  // Macro/FDA calendar (re-read every few hours): every setup is tagged with the
  // scheduled events inside its expected hold (candidate.catalysts).
  try { if (await macro.refresh()) broadcast('MACRO_EVENTS', macro.upcoming()); } catch (err) { console.error('[pipeline] macro calendar failed:', err.message); }
  // Open / staged trades on Coinbase gems keep streaming (exits and approvals need live prices).
  discovery.stream([...ledger.getActivePositions(), ...ledger.getPendingOrders()].filter((p) => p.market === 'crypto').map((p) => p.asset));
  const candidates = await collectCandidates();
  // Strategy-level blocks (Earnings Shield, resistance over the target) are rejections too.
  for (const b of [...equitySwing.takeBlocks(), ...cryptoSwing.takeBlocks(), ...cryptoIntraday.takeBlocks(), ...optionsSystem.takeBlocks(), ...speculativeCrypto.takeBlocks()]) recordRejection(b.id, b.reason, b.candidate);
  // Scanner log: what each strategy concluded per symbol on this pass.
  for (const [id, mod] of [['equity-day', equityDay], ['crypto-swing', cryptoSwing], ['crypto-intraday', cryptoIntraday], ['equity-swing', equitySwing], ['options-system', optionsSystem], ['speculative-crypto', speculativeCrypto]]) {
    scanLog.scanned(id, mod.takeScan());
  }
  // Read once per pass: every candidate is sized with the same risk profile
  // (Settings: 0.5% / 1% / 2%) and Max Capital Per Trade (5-25%) against the
  // capital of the venue it would execute on: the paper bankroll, or the LIVE
  // broker account (cached ~60 s).
  const settings = ledger.getSettings();
  const { riskPct, maxCapitalPct } = settings;
  counts.generated = candidates.length;

  afterHours.begin();
  for (const candidate of candidates) {
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
    const capital = await sizingBankroll(candidate.market, settings);
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
    const stack = stackingConflict(result, ledger.getActivePositions()); // Phase 68: never a second automated position on a held coin
    if (stack) { recordRejection(result.id, stack, candidate); continue; }
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
    } catch (err) {
      // Expected when the same setup is re-proposed on the next tick (duplicate id).
      console.log(`[pipeline] not staged ${result.id}: ${err.message}`);
    }
  }

  // After staging (Phase 62): each radar row's gate verdict reflects this pass's risk-engine outcome.
  try { await moonshotRadar.publish(broadcast, prices.getLatestPrices()); } catch (err) { console.error('[pipeline] moonshot radar failed:', err.message); }

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
    watchlist.setTriggers(await computeTriggers(watchlist.getWatchlist(), prices.getMarkPrices(), alpacaStocks.getLatestBars()));
  } catch (err) {
    console.error('[pipeline] watch triggers failed:', err.message);
  }

  await exitPass.run(broadcast); // held option quotes, PAPER exits, POSITIONS_UPDATED / JOURNAL_UPDATED (exit-pass.js)
  // Portfolio Pilot defense: SELL under the 200-day SMA, TRIM when far extended (Approvals queue).
  try { await reviewHoldings(broadcast); } catch (err) { console.error('[pipeline] pilot review failed:', err.message); }

  // "Heating up": distance to each strategy's trigger (Market Watch filter).
  try {
    const next = computeProximity(alpacaStocks.getLatestBars(), prices.getLatestPrices());
    if (JSON.stringify(next.items) !== JSON.stringify(proximityState.items)) broadcast('TRIGGER_PROXIMITY', next);
    proximityState = next;
  } catch (err) {
    console.error('[pipeline] trigger proximity failed:', err.message);
  }

  // Dashboard intelligence (attention alerts + market context), after exits settle.
  try {
    publishIntelligence(broadcast);
  } catch (err) {
    console.error('[pipeline] dashboard intelligence failed:', err.message);
  }

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
