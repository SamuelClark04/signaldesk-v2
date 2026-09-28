// Per-strategy on / off switches (Phase 78; Settings > Strategies, settings.strategiesEnabled). A strategy that is
// off is not run at all (strategy-runner.js: no scan, no setups, no CPU), its "heating up" rows are hidden and
// the Scanner log says it is off. Its OPEN positions are untouched (their stops / targets still work) and setups
// already waiting in Approvals stay (the user can still approve or reject them). The Portfolio Pilot is driven by
// the user's deposits and holdings, not a scanner, so it has no switch here.
// Crypto Swing is OFF by default: the Phase 77/78 replays lost money on every variant (details: REASONS).
const LABELS = Object.freeze({
  'crypto-swing': 'Crypto Swing (4h flush + reclaim)',
  'crypto-intraday': 'Crypto Intraday (15m / 1h)',
  'speculative-crypto': 'Moonshots',
  'equity-day': 'Equity Day (ORB)',
  'equity-swing': 'Equity Swing',
  'options-system': 'Options Spreads',
});
const IDS = Object.freeze(Object.keys(LABELS));
const DEFAULTS = Object.freeze({ ...Object.fromEntries(IDS.map((id) => [id, true])), 'crypto-swing': false });
const REASONS = Object.freeze({
  'crypto-swing': 'Off by default (Phase 78): replayed on real Coinbase 4h candles it lost money in both the last 90 days and the 90 before '
    + '(profit factor 0.82-0.96), and neither a BTC trend filter nor a confirmed reversal candle fixed it (worse, or almost no trades). '
    + 'Turn it on only after a backtest shows an edge.',
});

// settings.strategiesEnabled may be missing (older ledger) or partial: DEFAULTS fill the gaps.
const isEnabled = (id, settings) => {
  const map = settings && settings.strategiesEnabled;
  return map && typeof map[id] === 'boolean' ? map[id] : DEFAULTS[id] !== false;
};

module.exports = { isEnabled, IDS, LABELS, DEFAULTS, REASONS };
