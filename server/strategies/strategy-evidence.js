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
