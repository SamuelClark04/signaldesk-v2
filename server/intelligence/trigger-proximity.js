// Trigger proximity ("heating up"): how close each monitored symbol is to a
// strategy's trigger, from the strategies' own read-only proximity() reports.
//   equity-day      : price below today's opening-range high, before a breakout
//   crypto-swing    : flushed 3%+ below the 4h mean, not yet reclaimed
//   options-system  : in a daily squeeze, below its 10-day breakout level
//   crypto-intraday : in a tight 15m / 1h range, below its breakout level
// equity-swing does not report yet (one symbol, a pullback rather than a level).
// Output: { items: [{ symbol, strategyId, trigger, distancePct, label }], thresholdPct, at }
// (items within THRESHOLD_PCT only, nearest first; one per symbol).
const equityDay = require('../strategies/1-equity-day');
const cryptoSwing = require('../strategies/2-crypto-swing');
const cryptoIntraday = require('../strategies/2-crypto-intraday');
const optionsSystem = require('../strategies/5-options-system');

const THRESHOLD_PCT = 0.015; // 1.5%

function computeProximity(stockBars, latestPrices, now = Date.now()) {
  const all = [...equityDay.proximity(stockBars), ...cryptoSwing.proximity(latestPrices), ...cryptoIntraday.proximity(latestPrices), ...optionsSystem.proximity(latestPrices)]
    .filter((p) => Number.isFinite(p.distancePct) && p.distancePct >= 0 && p.distancePct <= THRESHOLD_PCT)
    .sort((a, b) => a.distancePct - b.distancePct);
  const nearest = new Map();
  for (const p of all) if (!nearest.has(p.symbol)) nearest.set(p.symbol, p);
  return { items: [...nearest.values()], thresholdPct: THRESHOLD_PCT, at: now };
}

module.exports = { computeProximity, THRESHOLD_PCT };
