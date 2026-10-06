# Equity Swing target order (PFE, 2026-10-01 / 10-02): investigation note

Status: OPEN, separate from Phase 94. No trading rule is changed by Phase 94.

## What was seen
PFE Equity Swing setups showed T1 28.95 and T2 28.05: T2 BELOW T1 for a long.

## Where the levels come from
- `server/strategies/3-equity-swing.js:102`: `t1 = cents(Math.max(recentHigh, entryMax + risk))` (the prior high, at least 1R).
- `server/strategies/3-equity-swing.js:103`: `t2 = cents(entryMax + 2 * risk)`.
- When the prior high is more than 2R above the entry, T1 (the high) > T2 (entry + 2R).

## What the app does with it today
exit-monitor arms T2 only after T1 fills, so a runner never exits at a T2 below T1; but the card shows an inconsistent plan, and the
50 / 50 allocation assumes T2 is beyond T1.

## Questions for a separate trading-rule phase (not decided here)
1. Should T2 be max(entry + 2R, T1 + 1R), or should the runner have no fixed T2 when the high is beyond 2R?
2. How many past Swing setups had T2 <= T1? The Decision Review now flags each one (`TARGET_ORDER`).
3. Does any replay (Phase 88 / 90) depend on the current T2? The rule ports (backtest/rules-stocks.js) must change together.
