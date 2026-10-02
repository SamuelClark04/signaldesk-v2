// Per-strategy on / off switches (Phase 78; Settings > Strategies, settings.strategiesEnabled). A strategy that is
// off is not run at all (strategy-runner.js: no scan, no setups, no CPU), its "heating up" rows are hidden and
// the Scanner log says it is off. Its OPEN positions are untouched (their stops / targets still work) and setups
// already waiting in Approvals stay (the user can still approve or reject them). The Portfolio Pilot is driven by
// the user's deposits and holdings, not a scanner, so it has no switch here.
// Crypto Swing is OFF by default: the Phase 77/78 replays lost money on every variant (details: REASONS). Options Spreads too since
// Phase 87 (2-year replay of its signals: no directional information). A saved map (existing ledgers) keeps the user's choice.
// REASONS: the replay result behind each strategy's rules, shown under its switch (on or off).
const LABELS = Object.freeze({
  'crypto-swing': 'Crypto Swing (4h flush + reclaim)',
  'crypto-intraday': 'Crypto Intraday (15m / 1h)',
  'speculative-crypto': 'Moonshots',
  'equity-day': 'Equity Day (ORB)',
  'equity-swing': 'Equity Swing',
  'options-system': 'Options Spreads',
});
const IDS = Object.freeze(Object.keys(LABELS));
const DEFAULTS = Object.freeze({ ...Object.fromEntries(IDS.map((id) => [id, true])), 'crypto-swing': false, 'options-system': false });
const REASONS = Object.freeze({
  'crypto-swing': 'Off by default (Phase 78): replayed on real Coinbase 4h candles it lost money in both the last 90 days and the 90 before '
    + '(profit factor 0.82-0.96), and neither a BTC trend filter nor a confirmed reversal candle fixed it (worse, or almost no trades). '
    + 'Turn it on only after a backtest shows an edge.',
  'options-system': 'Off by default (Phase 87): its signals replayed on 2 years of real 1h / daily bars (25 symbols, ~3,400-4,100 trades judged '
    + 'on the underlying) lost in both halves of the window: profit factor 0.75 (0.79 / 0.70); with the 200-day history fixed 0.75, an SPY trend '
    + 'filter 0.79, retest entries 0.76. The signals carry no direction: price moved -0.03 ATR their way over 1-5 days (48-49% right), '
    + 'and the same trades reversed lose as much. Paper wins came from closing early by hand. On only to test the mechanics on paper.',
  'speculative-crypto': 'Phase 79 replay (90 days of 5m candles, 62 Coinbase gems): the old entry (buy the breakout bar) lost money: '
    + '194 trades, profit factor 0.86, -24R. Now it skips coins already up > 18% over 24h or with a 15m RSI > 70 and buys only a '
    + 'pullback within 1 hour of the trigger (no pullback, no trade): 65 trades, 46% wins, profit factor 1.40, +17.7R at Coinbase fees '
    + '(1.21 at Kraken, 1.34 at OKX; profitable in both halves of the window). A thin sample, and buzz / spreads are not in the replay: '
    + 'size small, and switch it off if live results disagree.',
});

// settings.strategiesEnabled may be missing (older ledger) or partial: DEFAULTS fill the gaps.
const isEnabled = (id, settings) => {
  const map = settings && settings.strategiesEnabled;
  return map && typeof map[id] === 'boolean' ? map[id] : DEFAULTS[id] !== false;
};

module.exports = { isEnabled, IDS, LABELS, DEFAULTS, REASONS };
