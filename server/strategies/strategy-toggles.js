// Per-strategy on / off switches (Phase 78; Settings > Strategies, settings.strategiesEnabled). A strategy that is
// off is not run at all (strategy-runner.js: no scan, no setups, no CPU), its "heating up" rows are hidden and
// the Scanner log says it is off. Its OPEN positions are untouched (their stops / targets still work) and setups
// already waiting in Approvals stay (the user can still approve or reject them). The Portfolio Pilot is driven by
// the user's deposits and holdings, not a scanner, so it has no switch here.
// Crypto Swing is OFF by default: the Phase 77/78 replays lost money on every variant (details: REASONS). Options Spreads too since
// Phase 87 (2-year replay of its signals: no directional information). A saved map (existing ledgers) keeps the user's choice.
// Phase 89 RESEARCH PAUSE (the user's request: pause new automated entries from losing or unvalidated strategies while they
// are investigated; monitoring and exits keep working): Crypto Intraday, Equity Day (ORB), Equity Swing, and the two that lost
// in their replays but a user may have switched on (Options Spreads, Crypto Swing) are switched off ONCE in every existing ledger (ledger-store applies PAUSE when settings.strategyPauseVersion < PAUSE.version) and are off
// by default. The user may switch any of them back on; it is never re-paused. Options Quick Flips (Phase 89, intraday,
// paper only) is off by default: its replay did not pass (REASONS). Phase 89 review (PAUSES 90): Moonshots paused too (REASONS).
// REASONS: the replay result behind each strategy's rules, shown under its switch (on or off).
const LABELS = Object.freeze({
  'crypto-swing': 'Crypto Swing (4h flush + reclaim)',
  'crypto-intraday': 'Crypto Intraday (15m / 1h)',
  'speculative-crypto': 'Moonshots',
  'equity-day': 'Equity Day (ORB)',
  'equity-swing': 'Equity Swing',
  'options-system': 'Options Spreads',
  'options-quickflips': 'Options Quick Flips (intraday, paper only)',
});
const IDS = Object.freeze(Object.keys(LABELS));
// Versioned one-time pauses: a ledger saved before a version gets THAT version's ids switched off once (a strategy the user switched
// back on after an earlier pause is never re-paused by it). 90: Moonshots, held to the same evidence standard (below).
const PAUSES = Object.freeze([
  Object.freeze({ version: 89, ids: Object.freeze(['crypto-intraday', 'equity-day', 'equity-swing', 'options-system', 'crypto-swing']) }),
  Object.freeze({ version: 90, ids: Object.freeze(['speculative-crypto']) }),
]);
const PAUSE = Object.freeze({ version: PAUSES[PAUSES.length - 1].version, ids: Object.freeze(PAUSES.flatMap((p) => p.ids)) });
const DEFAULTS = Object.freeze({ ...Object.fromEntries(IDS.map((id) => [id, true])), 'crypto-swing': false, 'options-system': false, 'options-quickflips': false,
  ...Object.fromEntries(PAUSE.ids.map((id) => [id, false])) });
const REASONS = Object.freeze({
  'crypto-swing': 'Off by default (Phase 78): replayed on real Coinbase 4h candles it lost money in both the last 90 days and the 90 before '
    + '(profit factor 0.82-0.96), and neither a BTC trend filter nor a confirmed reversal candle fixed it (worse, or almost no trades). '
    + 'Turn it on only after a backtest shows an edge.',
  'crypto-intraday': 'Paused (Phase 89 research): never validated. A revised rule set (squeeze / sweep only, trend filter, fee-floor stops) also failed on '
    + 'unseen 2022-23 data (24 trades on 15m, none on 1h; without the trend filter 208 trades, profit factor 0.66). On BTC / ETH its 3.2% minimum chart stop rejects almost every 15m and 1h signal '
    + '(2 trades in a year of replay, both losses). On its whole 15-coin list over 2 years (OKX fees, post-only entries filled only when traded through) '
    + 'it lost: 15m 126 trades, 25% wins, profit factor 0.81; 1h 40 trades, profit factor 0.57 (worse at Kraken; nothing passes at Coinbase fees). '
    + 'Turn it back on only after a replay on unseen data passes.',
  'equity-day': 'Paused (Phase 89 research): the Phase 88 replay was not significant (167 trades, profit factor 1.08, 95% range -0.19R to +0.37R per trade).',
  'equity-swing': 'Paused (Phase 89 research): the Phase 88 replay lost money (106 trades, profit factor 0.81, -0.19R per trade).',
  'options-system': 'Off by default (Phase 87): its signals replayed on 2 years of real 1h / daily bars (25 symbols, ~3,400-4,100 trades judged '
    + 'on the underlying) lost in both halves of the window: profit factor 0.75 (0.79 / 0.70); with the 200-day history fixed 0.75, an SPY trend '
    + 'filter 0.79, retest entries 0.76. The signals carry no direction: price moved -0.03 ATR their way over 1-5 days (48-49% right), '
    + 'and the same trades reversed lose as much. Paper wins came from closing early by hand. On only to test the mechanics on paper.',
  'options-quickflips': 'Off by default (Phase 89): SPY / QQQ single calls / puts, 3-7 DTE, entries 9:50 AM-2:30 PM, each position closed by a 3:40 PM deadline (if the paper broker does not fill the close it is re-priced and you are alerted) '
    + '(60 min max, 3:40 PM deadline: the one exception to "nothing closes on time"). Its replay did not pass the pre-registered test: the selected '
    + 'rule (ORB, -30% / +45%) made profit factor 1.41 on consolidated (SIP) bars but not significantly, and on the IEX bars our data plan allows live '
    + 'it was 1.10 (0.90 with stress costs): about break-even. On = the frozen forward paper test (docs/research/phase89-protocol-2.md), executed '
    + 'automatically at Alpaca Paper. Paper only: it can never send a real-money order.',
  'speculative-crypto': 'Paused (Phase 89 evidence review): its Phase 79 "validation" (65 trades, profit factor 1.40) ran on the SAME 90 days '
    + 'whose losing results (194 trades, PF 0.86) inspired the new entry rules, so it was never tested on unseen data; the 62 coins were picked '
    + 'when they were already "hot"; buzz and spreads are not in the replay; and its live strategy exits lost (8 trades, PF 0.82). The frozen '
    + 'out-of-sample test (the 90 days before that window, rules unchanged) FAILED: 63 trades, profit factor 0.58 at Coinbase fees (0.74 Kraken, '
    + '0.82 OKX). Keep it off unless a new rule passes its own frozen test on unseen data.',
});

// settings.strategiesEnabled may be missing (older ledger) or partial: DEFAULTS fill the gaps.
const isEnabled = (id, settings) => {
  const map = settings && settings.strategiesEnabled;
  return map && typeof map[id] === 'boolean' ? map[id] : DEFAULTS[id] !== false;
};

// Phase 89: the one-time research pause for a ledger saved before it. -> the new map, or null when nothing changes.
function applyPause(savedVersion, map) {
  const due = PAUSES.filter((p) => !(Number(savedVersion) >= p.version));
  if (!due.length) return null;
  return { ...DEFAULTS, ...(map || {}), ...Object.fromEntries(due.flatMap((p) => p.ids).map((id) => [id, false])) };
}

module.exports = { isEnabled, applyPause, IDS, LABELS, DEFAULTS, REASONS, PAUSE, PAUSES };
