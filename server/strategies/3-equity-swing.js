// Strategy 3: Equity Swing, pullback to the 20-day average in an uptrend (long only).
// PROPOSER ONLY: returns Canonical Candidates; never sizes, stages or executes.
//
// Earnings Shield: a swing trade held into an earnings report takes on a binary
// gap the stop cannot protect against. Real dates come from Finnhub
// (connectors/corporate-calendar.js). A setup is blocked when the next report is
// fewer than MIN_DAYS_TO_EARNINGS trading days away, AND when the date cannot be
// known (no key, API error, timeout): the shield fails CLOSED, never open.
// Blocked setups are reported through takeBlocks() so the pipeline can record
// them in "Why we passed" (this module stays a read-only proposer).
//
// Trigger (daily bars + live price):
//   uptrend      SMA20 > SMA50
//   pullback     live price at least PULLBACK_PCT below the 10-day high
//   at support   live price within NEAR_SMA_PCT of SMA20, and above SMA50
const { getEarningsStatus } = require('../connectors/corporate-calendar');
const { getDailyBars } = require('../connectors/daily-bars');
const { planTargets } = require('../risk/target-plan');
const sentiment = require('../connectors/news-sentiment');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'equity-swing';
const MIN_DAYS_TO_EARNINGS = 3;

const CONFIG = {
  tradeType: 'Swing Trade',
  expectedDuration: '3-10 days',
  symbols: ['NVDA'],
  fast: 20,
  slow: 50,
  highLookback: 10,
  pullbackPct: 0.02,
  nearSmaPct: 0.015,
  stopLookback: 5, // stop under the lowest low of the last N days...
  stopBufferPct: 0.005, // ...less a small buffer
  minStopPct: 0.0035, // and never tighter than the stock cost floor allows
  entryBufferPct: 0.003,
};

const cents = (x) => Math.round(x * 100) / 100;
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const sma = (bars, n) => bars.slice(-n).reduce((s, b) => s + b.close, 0) / n;
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

const shieldLogged = new Set(); // "SYMBOL:date:reason": log each shield block once per day
let blocks = []; // setups the shield blocked on the last pass: { id, reason, candidate }
const tally = createTally(); // why each symbol produced no setup (scanner log)

// Earnings Shield for a setup that has formed. Returns null (allowed) or the
// rejection reason. Unknown earnings = blocked.
async function shield(symbol, now) {
  const e = await getEarningsStatus(symbol, now);
  if (!e.ok) return { reason: `EARNINGS_UNKNOWN: ${e.error}`, text: 'earnings date unknown' };
  if (e.date && e.tradingDaysAway < MIN_DAYS_TO_EARNINGS) {
    return { reason: `EARNINGS_SOON: reports ${e.date}${e.hour ? ` (${e.hour})` : ''}, ${e.tradingDaysAway} trading day(s) away`, text: `reports ${e.date}` };
  }
  return { allowed: true, earnings: e };
}

async function evaluate(symbol, livePrice, now) {
  const date = etDate.format(now);

  // Setup first (cached real bars), shield second: the calendar is only asked,
  // and a block only recorded, when there is an actual setup to protect.
  const bars = await getDailyBars(symbol);
  if (bars.length < CONFIG.slow) return tally.skip(symbol, 'Not enough daily history');
  const fast = sma(bars, CONFIG.fast);
  const slow = sma(bars, CONFIG.slow);
  const recentHigh = Math.max(...bars.slice(-CONFIG.highLookback).map((b) => b.high));

  const uptrend = fast > slow;
  const pulledBack = livePrice <= recentHigh * (1 - CONFIG.pullbackPct);
  const atSupport = Math.abs(livePrice - fast) / fast <= CONFIG.nearSmaPct && livePrice > slow;
  if (!uptrend) return tally.skip(symbol, `Not in an uptrend (SMA${CONFIG.fast} at or below SMA${CONFIG.slow})`);
  if (!pulledBack) return tally.skip(symbol, `No ${(CONFIG.pullbackPct * 100).toFixed(0)}% pullback from the ${CONFIG.highLookback}-day high`);
  if (!atSupport) return tally.skip(symbol, `Not at SMA${CONFIG.fast} support`);

  const guard = await shield(symbol, now);
  if (!guard.allowed) {
    const id = `${STRATEGY_ID}:PULLBACK:${symbol}:${date}`;
    blocks.push({ id, reason: guard.reason, candidate: { asset: symbol, market: 'stocks', strategyId: STRATEGY_ID, setupType: 'SMA pullback', direction: 'long', timeframe: '1D' } });
    const key = `${symbol}:${date}:${guard.text}`;
    if (!shieldLogged.has(key)) {
      shieldLogged.add(key);
      console.log(`[equity-swing] Earnings Shield blocked ${symbol}: ${guard.reason}`);
    }
    return tally.skip(symbol, 'Rejected: Earnings Shield');
  }
  const { earnings } = guard;

  const entryMax = cents(livePrice * (1 + CONFIG.entryBufferPct));
  const swingLow = Math.min(...bars.slice(-CONFIG.stopLookback).map((b) => b.low));
  const structuralStop = swingLow * (1 - CONFIG.stopBufferPct);
  const invalidation = Math.floor(Math.min(structuralStop, entryMax * (1 - CONFIG.minStopPct)) * 100) / 100;
  const risk = entryMax - invalidation;
  const t1 = cents(Math.max(recentHigh, entryMax + risk)); // prior high, but at least 1R
  const t2 = cents(entryMax + 2 * risk);
  // Overhead daily resistance under T2: snap T1 below it (risk/target-plan.js), or reject when too close.
  const tgt = planTargets({ bars, entry: entryMax, stop: invalidation, market: 'stocks', fmt: cents,
    targets: [{ level: 1, price: t1, allocation: 0.5 }, { level: 2, price: t2, allocation: 0.5 }] });
  if (!tgt.ok) {
    blocks.push({ id: `${STRATEGY_ID}:PULLBACK:${symbol}:${date}`, reason: tgt.reason,
      candidate: { asset: symbol, market: 'stocks', strategyId: STRATEGY_ID, setupType: 'SMA pullback', direction: 'long', timeframe: '1D' } });
    return tally.skip(symbol, 'Rejected: resistance too close to snap T1');
  }
  const news = await sentiment.getSentiment(symbol, now);

  return {
    id: `${STRATEGY_ID}:PULLBACK:${symbol}:${date}`,
    asset: symbol,
    market: 'stocks',
    strategyId: STRATEGY_ID,
    setupType: 'SMA20 Pullback',
    direction: 'long',
    timeframe: '1D',
    tradeType: CONFIG.tradeType,
    expectedDuration: CONFIG.expectedDuration,
    resistance: tgt.resistance,
    newsSentiment: news.ok ? { score: news.score, label: news.label, source: news.source } : null,
    entryZone: { min: cents(livePrice), max: entryMax },
    invalidation,
    targets: tgt.targets,
    catalyst: { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} is in an uptrend (SMA${CONFIG.fast} ${cents(fast)} > SMA${CONFIG.slow} ${cents(slow)}) and has `
      + `pulled back ${(((recentHigh - livePrice) / recentHigh) * 100).toFixed(1)}% from its ${CONFIG.highLookback}-day high `
      + `${cents(recentHigh)} to the ${CONFIG.fast}-day average. Long for a retest of the high; `
      + `invalid below ${invalidation} (under the ${CONFIG.stopLookback}-day low). ${tgt.text} `
      + `${sentiment.describe(news)} Expected hold: ${CONFIG.expectedDuration}.`,
    confirmationCriteria: [
      `SMA${CONFIG.fast} above SMA${CONFIG.slow}`,
      `Price within ${(CONFIG.nearSmaPct * 100).toFixed(1)}% of SMA${CONFIG.fast} and above SMA${CONFIG.slow}`,
      earnings.date ? `Next earnings ${earnings.date}: ${earnings.tradingDaysAway} trading days away (shield requires ≥ ${MIN_DAYS_TO_EARNINGS})`
        : 'No earnings reported in the next 60 days (Finnhub)',
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function generateCandidates(latestPricesMap, { symbols = CONFIG.symbols, now = Date.now() } = {}) {
  blocks = [];
  tally.start();
  const candidates = [];
  for (const symbol of symbols) {
    tally.checked();
    const livePrice = lookup(latestPricesMap, symbol);
    if (!(livePrice > 0)) { tally.skip(symbol, 'No live price'); continue; }
    try {
      const candidate = await evaluate(symbol, livePrice, now);
      if (candidate) { candidates.push(candidate); tally.setup(); }
    } catch (err) {
      console.error(`[equity-swing] ${symbol} failed: ${err.message}`);
    }
  }
  return candidates;
}

// The pipeline reads (and clears) the shield blocks after each pass.
function takeBlocks() { const b = blocks; blocks = []; return b; }

module.exports = { generateCandidates, takeBlocks, takeScan: tally.take, STRATEGY_ID, MIN_DAYS_TO_EARNINGS, CONFIG };
