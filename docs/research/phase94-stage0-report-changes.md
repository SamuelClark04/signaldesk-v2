# Phase 94 Stage 0: the regenerated Decision Review and what changed

**Inputs (the same as the Phase 93 report):**
- the VM audit archive `sd-audit-20261004T043045Z` (ACCOUNT data);
- the browser-harness recorder file, now passed with `--harness` (16 test records).

**Code:**
- Phase 93 analyzer at `86eb04a`;
- Stage 0 analyzer at the commit that adds this file (S0-1 `4db5d58` + `a67dfed`, S0-3 `441e541` + `4af63cc` + `dc09bba`, S0-2 / C1 `819f7ef`,
  S0-4 `cda61a2`, S0-5 `903c2d9`).

**Reports:** `reports/decision-review-2026-10-05.json` (Phase 93) and `reports/decision-review-2026-10-06.json` (Stage 0). Both are local
and git-ignored. Money values below are R multiples only.

## How the changes were attributed (not guessed)

Two runs separated by a day differ for two reasons: the code, and the market data, because setups still inside their holding
period are marked to the latest bar. To separate the two:
1. **Phase 93 report (Oct 5) vs Stage 0 report (Oct 6):** every difference, whatever its cause.
2. **The Phase 93 code re-run on Oct 6** (a detached worktree at `86eb04a`; the same archive; the market-data cache copied), then the
   **Stage 0 code** on a copy of that same cache: what the code changes do on the same data.
   - Both runs refetch today's bars: `bars.js` caches only finished days, so the last minutes of an unfinished day can differ
     between two runs minutes apart.

## Class counts

Before = every setup in the Phase 93 report, harness included. After = ACCOUNT setups only.

| Class | Before (Phase 93, all) | After (Stage 0, account only) | Why |
|---|---|---|---|
| CORRECT_DIRECTION | 8 | 8 | |
| WRONG_DIRECTION | 6 | 6 | |
| REVERSAL_AFTER_ENTRY | 3 | 3 | |
| UNCLEAR | 39 | 38 | `adopt:ETH-USD:1790346495832` moved to NOT_MEASURABLE (C1, below) |
| PENDING | 36 | 35 | 1 harness record moved out (S0-5) |
| INCOMPLETE | 15 | 0 | the 15 incomplete setups were all harness strategy blocks: moved out (S0-5) |
| NOT_MEASURABLE | 0 | 1 | the adopted ETH position (C1) |

The 16 harness examples now appear only in their own report section, outside every count, statistic and pattern (S0-5).

## Changes caused by the Stage 0 code (the same data, run 2)

1. **One class change (C1: a later event is never the decision).**
   - `adopt:ETH-USD:1790346495832` is an adopted position with no stored decision time. Phase 93 used a later time in its place.
   - Its decision time is now MISSING, so the setup is NOT_MEASURABLE instead of UNCLEAR.
2. **Interim checkpoint labels on 19 setups (S0-2 / C1).** This count comes from the same-data re-run (run 2). A raw Oct 5 vs Oct 6 diff
   (`compare.js`, which now also diffs the interim labels) finds 20, because one extra change there is data drift.
   - The 5 / 15 / 30 / 60-minute and session-close labels changed: 11 Moonshots, 1 manual crypto, 2 Equity Swing (PFE, COIN) and 5
     Options Spreads (on the underlying).
   - P0 (when no live price was recorded) and every checkpoint price now come from the last bar that FINISHED by that time. Phase
     93 read the bar still forming, which holds prices from up to a minute later.
   - Examples: `MOON:KARRAT` 5 min FLAT -> CORRECT; `MOON:IMX` 15 / 30 min CORRECT -> FLAT; `PFE 2026-10-02` 5 / 15 min FLAT -> CORRECT.
   - No completed outcome class and no planned-end label changed because of this (the only planned-end change is the ETH setup in
     point 1).
3. **The opposite side (S0-4).**
   - It now enters by the mirrored rule on the same entry opportunity, with the original's T1 / T2 split, and unfilled sides are
     counted.
   - The Phase 93 JSON did not store the opposite trade's result, so there is no before / after number. The new JSON stores it
     (`oppTrade`).
4. **Rule checks (S0-3).** No verdict changed. The archive predates the recorder, so all its rejections were already NOT_VERIFIABLE.
   Recorded data from now on is checked against the rejecting event's own guard snapshot.
5. **Evidence keys (S0-1).** No archive record used a legacy key. The 16 harness records are labelled where their keys are `b:`.

## Changes caused by the data, not the code

- **The simulated money result of 23 options setups (underlying proxy) changed by up to about 0.5R between the Oct 5 and Oct 6
  reports.** All are PENDING: their holding period has not ended, so the simulated trade is marked to the latest bar.
- `simulate.trade` / `realistic` are unchanged by Stage 0 (`git diff 86eb04a -- tools/decision-review/simulate.js` changes only
  `oppositeOf`).
- Re-running the Phase 93 code on Oct 6 reproduces the bulk of each change. The remaining few hundredths of an R come from today's
  unfinished-day bars, refetched minutes apart.
- These numbers are interim by definition: a PENDING setup has no completed result.

## Stage 0 review fixes (end-of-branch review)

- **C1:** ids repeat per symbol per day. A setup rejected earlier (e.g. MARKET_CLOSED before the open) and STAGED later now takes the
  STAGED record as its decision; a never-staged setup takes the rejection that ENDED it. No account setup in this archive had
  recorded events, so the counts above are unchanged; recorded data from now on is affected.
- **S0-5:** the report header and the JSON meta count the ACCOUNT recorder files only (harness files: `meta.harnessRecorder`).

## Pre-merge fix C1-B (2026-10-06): evidence bound to the selected decision

- **Defect:** the loader took the setup, levels, option and chart / signal context from the FIRST recorded event of an id. When a later
  STAGED record (or the ending rejection, or a recovered stagedAt) was chosen as the decision, the evidence could still be an earlier
  rejection's: the decision time from one record, the levels and chart from another.
- **Fix:** `tools/decision-review/load.js` `bind()`. Every event keeps its own context. The decision's direction, setup type, levels,
  option and context are taken from the selected decision record. Without one, they come from the order's own lifecycle record
  (setup only) or the LEDGER record, and the context is labelled MISSING. The JSON notes and the cards name the record
  (`evidenceFrom`).
- **Tests:** tests/ph94review.js "C1-B" (6 checks: STAGED after a rejection (2), STAGED without its own context, a lost STAGED line, a ledger
  recovery, the ending rejection). All 6 failed on `c8a8e32` and pass now.
- **Effect on this archive:** none on any count. The analyzer at `c8a8e32` and with the fix were run back to back on the same archive,
  harness file and bar cache:
  - account class counts are identical; no setup changed direction, symbol, strategy or decision time;
  - the 43 account setups have no recorded events (the archive predates the recorder), and each of the 16 harness setups has a single
    decision record (15 STRATEGY_BLOCK, 1 PIPELINE_REJECT), so the evidence was already the decision's own;
  - three money values moved by 0.01-0.07 R across the runs (AMZN put, XOM call, SPY call of 2026-10-02). All three are PENDING and
    marked to the latest bar of a session still trading: data drift between the runs, not the fix.
- **Review follow-up (same day):** a lost STAGED line followed by ANY later record of the order (EXPIRED, USER_REJECT,
  APPROVAL_REJECT, not only approval / fill / close) now recovers the decision from that record's stagedAt. A selected record without
  a setup clears every setup field (no earlier thesis or setup type survives), and an absent direction is MISSING, never defaulted to
  long. 3 more checks (9 C1-B checks in all), failing before and passing after; the same-archive comparison is unchanged.
- Recorded data from now on is affected: ids repeat per symbol per day, so a rejection before a later STAGED record is common.

## Not changed by Stage 0, as agreed

- The crypto 90% coverage rule. 28 crypto trades stay UNCLEAR (coverage), pending a separately specified amendment.
- The Swing target order is flagged on its cards (`TARGET_ORDER`) and investigated separately (`docs/research/phase94-pfe-target-order.md`).
  The report flags FIVE Equity Swing setups, not only PFE: PFE 10-01 and 10-02, COIN 09-30, DIS 10-01 and MU 10-01. The cause is general
  (the prior high more than 2R above the entry).
- Option trade-print estimates: 4 market-data requests answered HTTP 403 "OPRA agreement is not signed". Those contracts stay
  "unavailable" (no quote or print source), as in Phase 93.
- No trading rule, safeguard or automation change.
