# Phase 95 discovery and forward-test protocol (version 1)

Frozen 2026-10-13, before the first discovery run and before any shadow outcome was examined (Task 7.0). It copies plan section 8
(docs/superpowers/plans/2026-10-07-shadow-research-system.md) and fixes the choices below. Implemented by
tools/research/shadow/protocol.js; every discovery run records this file's sha256. Any change is a new protocol version that applies
only to runs after its commit.

## Candidates (8.2)

- A candidate = one research book: opportunity family (trigger id, `CONTROL`, `NEWS_FIRST`, `EVENT_*`, `APP_<strategy>`) x exit rule
  (`exits@1`) x price label. Version 1 uses NO predictive-feature bins (the plan allows up to 2; none is frozen yet).
- `CONTROL` books are baselines, never candidates.
- The run's candidate list is every (family, rule, label) present in the pool, written and hashed BEFORE any outcome is read.

## Pool and cadence (8.1)

- Run k is due when 28 days have passed since run k-1 (or since the first recorded session for k = 1), or when the pool has grown by
  >= 200 symbol-days since run k-1.
- The pool = every session NOT inside an open forward window (from a proposal's freeze day until its verdict).

## Independence (8.3)

- `n_eff` = distinct trading days with a closed trade in the book (one day = one cluster; it also covers shared-event episodes).
- To be tested: `n_eff` >= 30 and >= 8 symbols (cross-stock) or >= 40 days (a single symbol). Below that: p = 1, counted in m_k.

## The p-value and the corrections (8.5, exact)

- One-sided H0: after-cost mean net $ per trade <= 0. Day-block bootstrap (all trades of a day resampled together), B = 10,000, seed =
  the first 8 bytes (as 4 + 4 for a 32-bit generator) of sha256(candidate id), centred: p = (1 + #{b : m*_b - m_hat >= m_hat}) / (B + 1).
- Run k: Benjamini-Hochberg at alpha_k = 0.10 x 6 / (pi^2 x k^2) over all m_k candidates; a Benjamini-Yekutieli column is reported as
  a sensitivity check (not the decision rule).

## Promising (8.4, all required)

BH rejection at alpha_k; the 95% day-block bootstrap interval of the mean (2.5th percentile) > 0; the stressed-cost mean > 0; both
chronological halves (by day) with a positive mean; the mean above the CONTROL book's mean on the same rule and label. For event
families the paired price-only comparison (P vs P+E) is not applicable in version 1 (no feature bins): recorded as `n/a`.

## Proposals and forward tests (8.5-8.7)

- A promising candidate is frozen as `research-data/discovery/proposals/<id>.json`, written once (exclusive create) with its sha256:
  family, rule, label, limits, costs, run k, family size |F_k|, freeze day. Its forward window starts at the next session.
- One look when the forward `n_eff` reaches 40 (forward trades = the book's closed trades with an entry day after the freeze day):
  PASS needs p_fwd <= beta_k / |F_k| with beta_k = 0.05 x 6 / (pi^2 x k^2), the stressed mean > 0 and both forward halves > 0.
- Verdicts: `PASSED-INDICATIVE` (INDICATIVE_ESTIMATE prices: NOT validated), `VALIDATED` (MARKET_QUOTE prices), `FAILED`,
  `INCONCLUSIVE` (n_eff < 40 after 12 months). Before the look, numbers are "interim, not a verdict".
- Every tested candidate and every proposal stays in the registry with its numbers and reason; a failed one is never re-proposed
  unchanged. A VALIDATED proposal is only reported as eligible for a separate trading-rule phase: changing the app needs the user's approval.
