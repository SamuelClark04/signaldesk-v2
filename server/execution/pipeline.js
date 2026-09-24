// Master execution loop: Connectors -> Strategies -> Risk Engine -> Ledger -> Notifier,
// every PIPELINE_INTERVAL_MS, plus exit management for open positions.
// Strategies only propose; the risk engine decides; only the ledger holds state.
// server.js injects broadcast() so this module never touches sockets directly.
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const alpacaNews = require('../connectors/alpaca-news-socket');
const equityDay = require('../strategies/1-equity-day');
const cryptoSwing = require('../strategies/2-crypto-swing');
const equitySwing = require('../strategies/3-equity-swing');
const optionsSystem = require('../strategies/5-options-system');
const { processCandidate } = require('../risk/risk-engine');
const { sizingBankroll } = require('../risk/venue-capital');
const { computeProximity } = require('../intelligence/trigger-proximity');
const ledger = require('./paper-ledger');
const { sendApprovalAlert } = require('./notifier');
const { reconcileLivePositions } = require('./reconciler');
const { recordRejection } = require('./rejection-stats');
const watchlist = require('./watchlist');
const { publishIntelligence } = require('../intelligence/dashboard-intel');
const prices = require('../market/latest-prices');

const PIPELINE_INTERVAL_MS = 60000;

let broadcast = () => {}; // set by startPipeline()
let pipelineTimer = null;
let lastPricesKey = null;
let proximityState = { items: [], thresholdPct: 0.015, at: null };
const getProximity = () => proximityState;

// Each strategy runs isolated: one failing never blocks the others' candidates.
const STRATEGIES = [
  ['equity-day', () => equityDay.generateCandidates(alpacaStocks.getLatestBars(), alpacaNews.getNewsContext())],
  ['crypto-swing', () => cryptoSwing.generateCandidates(prices.getLatestPrices())],
  ['equity-swing', () => equitySwing.generateCandidates(prices.getLatestPrices())],
  ['options-system', () => optionsSystem.generateCandidates(prices.getLatestPrices())],
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
const getScanStatus = () => ({ ...scanStatus, counts: scanStatus.counts && { ...scanStatus.counts }, priceTimes: { ...scanStatus.priceTimes } });

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
  const candidates = await collectCandidates();
  // Earnings Shield blocks (equity-swing) are rejections too: record them.
  for (const b of equitySwing.takeBlocks()) recordRejection(b.id, b.reason, b.candidate);
  // Read once per pass: every candidate is sized with the same risk profile
  // (Settings: 0.5% / 1% / 2%) against the capital of the venue it would execute
  // on: the paper bankroll, or the LIVE broker account (cached ~60 s).
  const settings = ledger.getSettings();
  const { riskPct } = settings;
  counts.generated = candidates.length;

  for (const candidate of candidates) {
    const capital = await sizingBankroll(candidate.market, settings);
    if (!capital.ok) {
      // Fail closed: a LIVE setup is never sized from the paper bankroll.
      console.warn(`[pipeline] rejected ${candidate.id}: ${capital.reason}`);
      recordRejection(candidate.id, capital.reason, candidate);
      continue;
    }
    const result = processCandidate(candidate, capital.bankroll, { riskPct, sizingBasis: capital.basis });
    if (!result.approved) {
      console.log(`[pipeline] rejected ${result.candidateId}: ${result.reason}`);
      recordRejection(result.candidateId, result.reason, candidate); // counted once per setup per reason
      continue;
    }
    counts.approved += 1;
    try {
      const staged = ledger.stageOrder(result);
      counts.staged += 1;
      broadcast('order:staged', staged);
      console.log(`[pipeline] staged ${result.id}: ${result.positionSize} @ ${result.entryPrice}, stop ${result.invalidation}`);
      notify(staged);
    } catch (err) {
      // Expected when the same setup is re-proposed on the next tick (duplicate id).
      console.log(`[pipeline] not staged ${result.id}: ${err.message}`);
    }
  }

  // Exit management. LIVE positions first, from broker truth (real fills);
  // then PAPER positions from local prices (monitorPositions skips LIVE ones).
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

  let positionsChanged = false;
  let journalChanged = false;
  const logClose = (t) => console.log(`[ledger] closed ${t.id} ${t.exitReason} @ ${t.exitPrice}: `
    + `net ${t.netPnl.toFixed(2)} (${t.rMultiple.toFixed(2)}R)${t.exitLeg ? ` via ${t.exitLeg}` : ''}`);
  try {
    for (const r of await reconcileLivePositions(ledger.getActivePositions(), ledger)) {
      if (r.action === 'closed') { logClose(r.trade); journalChanged = true; }
      if (r.action === 'voided') console.warn(`[reconcile] voided ${r.id}: ${r.detail}`);
      if (r.action === 'synced') console.log(`[reconcile] ${r.id}: entry synced to broker fill`);
      if (['closed', 'voided', 'synced'].includes(r.action)) positionsChanged = true;
    }
  } catch (err) {
    console.error('[pipeline] broker reconciliation failed:', err.message);
  }
  try {
    const closed = ledger.monitorPositions(prices.getLatestPrices());
    closed.forEach(logClose);
    if (closed.length) { positionsChanged = true; journalChanged = true; }
  } catch (err) {
    console.error('[pipeline] position monitor failed:', err.message);
  }
  if (positionsChanged) broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
  if (journalChanged) broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());

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

  console.log(`[pipeline] candidates=${counts.generated} approved=${counts.approved} staged=${counts.staged}`);
  return counts;
}

// Starts the 60s loop. Returns handles for manual passes (tests) and shutdown.
function startPipeline(options = {}) {
  if (pipelineTimer) throw new Error("pipeline: already started");
  if (typeof options.broadcast === "function") broadcast = options.broadcast;
  pipelineTimer = setInterval(() => {
    runPipeline().catch((err) => console.error('[pipeline] pass failed:', err));
  }, PIPELINE_INTERVAL_MS);
  const { bankroll, riskProfile, riskPct, stockMode, cryptoMode } = ledger.getSettings();
  console.log(`[pipeline] running every ${PIPELINE_INTERVAL_MS / 1000}s, bankroll $${bankroll}, risk ${riskProfile} ${(riskPct * 100).toFixed(1)}%/trade, `
    + `stocks/options ${String(stockMode).toUpperCase()}, crypto ${String(cryptoMode).toUpperCase()} (editable in Settings)`);
  return { runPipeline, stop: stopPipeline };
}

function stopPipeline() {
  clearInterval(pipelineTimer);
  pipelineTimer = null;
}

module.exports = { startPipeline, stopPipeline, runPipeline, getScanStatus, getProximity, PIPELINE_INTERVAL_MS };
