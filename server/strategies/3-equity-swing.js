// Strategy 3: Equity Swing, pullback to the 20-day average in an uptrend (long only).
// PROPOSER ONLY: returns Canonical Candidates; never sizes, stages or executes.
//
// Earnings Shield: a swing trade held into an earnings report takes on a binary
// gap the stop cannot protect against. If the next report is fewer than
// MIN_DAYS_TO_EARNINGS days away, the setup is not proposed at all.
//
// Trigger (daily bars + live price):
//   uptrend      SMA20 > SMA50
//   pullback     live price at least PULLBACK_PCT below the 10-day high
//   at support   live price within NEAR_SMA_PCT of SMA20, and above SMA50
const { getDaysToEarnings } = require('../connectors/corporate-calendar');
const { getDailyBars } = require('../connectors/daily-bars');

const STRATEGY_ID = 'equity-swing';
const MIN_DAYS_TO_EARNINGS = 3;

const CONFIG = {
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

const shieldLogged = new Set(); // "SYMBOL:date": log each shield block once per day

async function evaluate(symbol, livePrice, now) {
  const date = etDate.format(now);

  // Earnings Shield first: no point analysing a setup we will not propose.
  const daysToEarnings = await getDaysToEarnings(symbol);
  if (daysToEarnings < MIN_DAYS_TO_EARNINGS) {
    const key = `${symbol}:${date}`;
    if (!shieldLogged.has(key)) {
      shieldLogged.add(key);
      console.log(`[equity-swing] Earnings Shield: ${symbol} reports in ${daysToEarnings} day(s); no swing proposals today`);
    }
    return null;
  }

  const bars = await getDailyBars(symbol);
  if (bars.length < CONFIG.slow) return null;
  const fast = sma(bars, CONFIG.fast);
  const slow = sma(bars, CONFIG.slow);
  const recentHigh = Math.max(...bars.slice(-CONFIG.highLookback).map((b) => b.high));

  const uptrend = fast > slow;
  const pulledBack = livePrice <= recentHigh * (1 - CONFIG.pullbackPct);
  const atSupport = Math.abs(livePrice - fast) / fast <= CONFIG.nearSmaPct && livePrice > slow;
  if (!uptrend || !pulledBack || !atSupport) return null;

  const entryMax = cents(livePrice * (1 + CONFIG.entryBufferPct));
  const swingLow = Math.min(...bars.slice(-CONFIG.stopLookback).map((b) => b.low));
  const structuralStop = swingLow * (1 - CONFIG.stopBufferPct);
  const invalidation = Math.floor(Math.min(structuralStop, entryMax * (1 - CONFIG.minStopPct)) * 100) / 100;
  const risk = entryMax - invalidation;
  const t1 = cents(Math.max(recentHigh, entryMax + risk)); // prior high, but at least 1R
  const t2 = cents(entryMax + 2 * risk);

  return {
    id: `${STRATEGY_ID}:PULLBACK:${symbol}:${date}`,
    asset: symbol,
    market: 'stocks',
    strategyId: STRATEGY_ID,
    setupType: 'SMA20 Pullback',
    direction: 'long',
    timeframe: '1D',
    entryZone: { min: cents(livePrice), max: entryMax },
    invalidation,
    targets: [
      { level: 1, price: t1, allocation: 0.5 },
      { level: 2, price: t2, allocation: 0.5 },
    ],
    catalyst: { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} is in an uptrend (SMA${CONFIG.fast} ${cents(fast)} > SMA${CONFIG.slow} ${cents(slow)}) and has `
      + `pulled back ${(((recentHigh - livePrice) / recentHigh) * 100).toFixed(1)}% from its ${CONFIG.highLookback}-day high `
      + `${cents(recentHigh)} to the ${CONFIG.fast}-day average. Long for a retest of the high; `
      + `invalid below ${invalidation} (under the ${CONFIG.stopLookback}-day low).`,
    confirmationCriteria: [
      `SMA${CONFIG.fast} above SMA${CONFIG.slow}`,
      `Price within ${(CONFIG.nearSmaPct * 100).toFixed(1)}% of SMA${CONFIG.fast} and above SMA${CONFIG.slow}`,
      `Earnings in ${daysToEarnings} days (shield requires ≥ ${MIN_DAYS_TO_EARNINGS})`,
      'Daily bars are simulated until the historical feed is wired',
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function generateCandidates(latestPricesMap, { symbols = CONFIG.symbols, now = Date.now() } = {}) {
  const candidates = [];
  for (const symbol of symbols) {
    const livePrice = lookup(latestPricesMap, symbol);
    if (!(livePrice > 0)) continue;
    try {
      const candidate = await evaluate(symbol, livePrice, now);
      if (candidate) candidates.push(candidate);
    } catch (err) {
      console.error(`[equity-swing] ${symbol} failed: ${err.message}`);
    }
  }
  return candidates;
}

module.exports = { generateCandidates, STRATEGY_ID, MIN_DAYS_TO_EARNINGS, CONFIG };
