# Phase 94: PR #1 tested with the completed Stage 0-1 implementation (correction C5)

Date: 2026-10-06. Nothing was merged into `main`, nothing was deployed, and no existing work was reset, stashed or rebased.

## Exact commits tested

| What | Branch | Commit |
|---|---|---|
| PR #1 (venue fees) | `phase92-venue-fees` | `74c77a2` |
| PR #2 + Stage 0 (accuracy fixes) | `phase93-decision-review` | `c8a8e32` |
| Stage 1 (record-only capture), contains Stage 0 | `phase94-capture` | `fc940f2` |
| Temporary integration: Stage 1 + PR #1 | `scratch/pr1-pr2-integration` (local, never pushed, deleted after the test) | `97844c2` |
| `main` (not involved) | `main` | `b959849` |

## Merge

- `fc940f2` + `origin/phase92-venue-fees` conflicted in three files. Each conflict was two independent additions at the same place,
  so the resolution kept both:
  - `CLAUDE.md`: both phases' bullets;
  - `client/styles/settings.css`: the recorder footer styles + the fee-source styles;
  - `server/execution/pipeline.js`: `decisions.start()` + `venue-fees.start()`, adjacent lines in startPipeline.
- `package.json` / `package-lock.json` are identical on both sides (no `npm ci` needed).
- `check:limits` passed on the merged tree (pipeline.js 266 lines).

## Suites per branch (only the suites that exist on that branch)

| Run | Commit | Suites | Result |
|---|---|---|---|
| PR #1 alone | `74c77a2` | 52 (ph51-ph92; no ph93 / ph94) | 51 clean; `ph75unit` 1 FAIL (timing, see below) |
| Stage 0 | `c8a8e32` | 55 (+ ph93unit, ph93review, ph94unit, ph94review; no ph92, no ph94capture / ph94universe) | 54 clean; `ph75unit` 1 FAIL (timing) |
| Stage 1 | `fc940f2` | 57 (+ ph94capture, ph94universe; no ph92) | 57 clean |
| Integration | `97844c2` | 58 (all, incl. ph92unit) | **58 clean** |

**The one FAIL, investigated (not caused by these branches):**
- The failing check is `ph75unit`'s spread-builder check, `newCpu < oldCpu / 10`, which compares process CPU times.
- On Windows the CPU time moves in ~15.6 ms ticks. The new path measured 0, 16, 31 or 32 ms across runs, against a threshold of
  ~26-28 ms.
- Re-running it 4 times at each of `74c77a2` and `c8a8e32` gave 3 PASS / 1 FAIL and 2 PASS / 2 FAIL.
- No branch here changes the spread builder.
- It is an existing timing-sensitive check in an older kit suite, flaky on this PC.

**Crashes:** none in any run. An earlier baseline at `86eb04a` showed 6 CRASHes from fixture files missing in a copied test kit. Once
the fixtures were copied they passed; they were not code failures.

## Browser harness on the integration commit (`97844c2`)

The harness ran isolated: a scratch ledger and credentials, Coinbase / Kraken / OKX keys blank and their URLs dead, Alpaca trading URLs
dead, AI URLs dead, SMTP at the local sink, and Finnhub dead. It ran on port 3999 with the harness token.

- **Settings > Strategies footers:** "Decision recorder: 0 today · 0 dropped · 0 write errors · last write none yet" and "Event capture: 12
  today · 0 dropped · 0 write errors · last write 03:05 PM".
- **PR #1's venue fee sources** render with their time for OKX US, Kraken and Coinbase. They read "Fees UNVERIFIED ... last lookup failed
  ... no API keys configured", as expected with no broker keys in the harness.

The earlier Stage 1 budget run (15 min, `7284967`) is in `docs/deploy/phase94-stage1-capture.md`.

## Not done (separate decisions)

- Merge order of PR #1 / PR #2 / Stage 1, any merge into `main`, and any deploy.
- The integration branch was deleted after the test.
