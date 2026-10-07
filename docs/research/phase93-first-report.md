# Phase 93: the first Decision Review report (example, 2026-10-05)

**Inputs:**
- The VM audit archive of 2026-10-04 04:30 UTC: 79 closed trades (journal + archived Run 1), 4 open positions, 10 discarded setups and
  the last 400 log lines. All of these are **LEDGER**: decided before the recorder existed, so their charts and inputs are FETCHED or
  missing, and are marked so.
- The browser harness's first recorder file (2026-10-05, after the close): 16 **RECORDED** strategy blocks with their full inputs.

The report is `reports/decision-review-2026-10-05.html` on this PC: local and private, git-ignored, not published.

**Data:** 206 requests fetched plus 849 from the cache, 0 errors.

## What it shows (measured, with small samples)

| | Accepted | Rejected |
|---|---|---|
| Completed classes | 8 correct direction, 6 wrong direction, 3 reversal after entry | none completed yet |
| Pending (planned holding period not over) | 34 | 2 |
| Unclear | 30 (28 of them crypto: see the coverage note below) | 9 |
| Incomplete (direction only) | 0 | 15 |

- **Options Spreads (accepted):** 15 completed on the underlying: 8 correct direction, 4 wrong, 3 reversed after entry.
  - The repeated mistakes are bear put spreads: 3 wrong direction and 3 reversals.
  - Most other options trades (28) are still inside their 5- or 15-session holding period.
- **Recorded money result, all accepted trades:** 77 closed, mean -0.03R, total -2.54R (LEDGER). The direction calls and the money results
  are kept apart.
- **Accepted, at the session close (interim):** 11 correct, 17 wrong, 41 flat, 12 no data.
- **Pre-decision patterns:** none yet. No feature bin has 20 setups, so the report lists the strongest bins as "not significant". That is
  expected for one week of reconstructed history.

## Findings to act on (not changed in Phase 93)

1. **The crypto coverage rule needs a decision (spec 5.2).** Coinbase publishes no 1-minute candle for a minute without trades. Thinly
   traded coins therefore fall under the frozen 90% coverage threshold: 28 crypto trades are UNCLEAR (coverage) rather than judged.
   - A possible amendment, to be approved and frozen BEFORE it is used: for crypto, treat a missing minute as "no trade: price unchanged"
     when the candles before and after it exist.
   - It is not applied here, because the definitions were frozen before the data was seen.
2. **Equity Swing can set T2 BELOW T1** (seen on PFE 2026-10-01 and 10-02). T1 = the 10-day high (28.95) and T2 = entry + 2R (28.05).
   - exit-monitor arms T2 only after T1 fills, so such a runner never exits at T2 below T1. But the plan the card shows is inconsistent.
   - That is a trading-rule fix and needs its own approved phase.
3. **Discarded setups never stored their reason** (expired / rejected by you / refused at approval). 10 historical discards are
   "reason not stored". The recorder now captures every one.

## Next

1. Deploy (separately approved).
2. Let the recorder run for at least 4 weeks.
3. Rerun the report from each audit archive.
4. The pattern section (spec 8) can only flag bins with 20+ recorded setups.
5. Any proposed rule goes through the frozen-proposal process (spec 9).
