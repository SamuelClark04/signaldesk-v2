# Phase 93: Decision Review (design + specification + implementation plan)

Status: APPROVED 2026-10-05, with the clarifications marked **[C1]-[C5]** folded in below. Built directly in this session. Deployment
needs separate approval. Trading rules, safeguards, approvals and automation are unchanged by every task: the live server only gains a
**record-only** hook, and all analysis runs on this PC.

Clarifications (2026-10-05):
- **[C1]** Keep the original setup and decision snapshot, plus EVERY later lifecycle event (approval, rejection, expiry, execution).
  Keep ALL inputs the strategy actually used, even past 60 bars.
- **[C2]** Direction and timing are judged on the UNDERLYING chart. Contract performance is judged on actual OPTION prices. The two
  conclusions are kept separate: an option losing money does not by itself show the stock moved against the call.
- **[C3]** Option trade-print results are ESTIMATES. Bid / ask quotes and realistic fill rules are used wherever they exist. If an
  opposite option trade cannot be priced reliably, it shows the underlying outcome only, and contract P&L is "unavailable".
- **[C4]** "Direction correct but the trade lost" is not the same as an explanation of the loss. Contract choice, execution, volatility
  or time decay is named only where the recorded evidence supports it.
- **[C5]** Recording stays bounded and non-blocking, INCLUDING snapshot creation and serialization. Missing or dropped records are
  surfaced. Recorded decision-time data is the primary evidence; fetched historical reconstructions are labelled separately.
- Failed backtests are not taken to mean most direction calls were wrong: that is measured directly.

## 1. Purpose and agreed scope

Show where SignalDesk repeatedly reads **direction** or **timing** wrong, and which information available *at the decision* could have
helped. It covers every setup the app generates, whether it was accepted or rejected.

- **Option 3, agreed:**
  - Now: a local, private HTML report built on this PC from the VM's audit archive.
  - Later (a separate phase): an in-app view that only *displays* results computed here.
  - The VM never runs the analysis.
- **The report is never published.** It is written to a git-ignored folder. No Artifact, no upload.
- **Not in scope:**
  - any change to strategy rules, gates, shields, sizing, exits, approvals, the paper-only lock or automation;
  - proposing rule changes before a frozen forward test (section 9);
  - crypto scanners (manual-only; any record of one is reported, but nothing is expected).

## 2. Architecture

```
VM (live server)                                 PC (this machine)
 strategies ─► pipeline ─► order-router           scripts/vm-audit.sh archive (.tgz)
     │            │             │  expiry-sweeper        │
     └──── decision-recorder.record(event) ────┐         ▼
           (sync, in memory, never throws)     │   tools/decision-review/
           queue ─► async append every 5 s ────┴─► decisions-YYYY-MM-DD.jsonl ──► load ─► bars ─► measure ─► classify
           status() ─► /api/version, Settings, log, vm-audit            ─► simulate ─► safeguards ─► patterns ─► render
                                                                          reports/decision-review-<date>.html + report.json
```

## 3. Live recording (VM): `server/research/decision-recorder.js`

### 3.1 Capture points (every decision path)

| Path | Where it is hooked | Event `path` |
|---|---|---|
| Strategy-level block (Earnings Shield, target over resistance, Quick Flips gates, Swing guard, ...) | pipeline, where `runner.takeBlocks()` is handled | `STRATEGY_BLOCK` |
| Pipeline rejection (no price / market closed, spread / volume, sizing capital, risk engine, top of book, stacking, portfolio risk, entry shields) | `pipeline.recordRejection` (the single choke point) | `PIPELINE_REJECT` |
| Staged into Approvals | pipeline, after `ledger.stageOrder` | `STAGED` |
| Approval-time check: refused but kept pending (book limits / shields), or refused and retired (validateApproval) | `order-router.approveWithGuard` | `APPROVAL_HOLD` / `APPROVAL_REJECT` |
| Approved and routed (paper) | `approveWithGuard` success | `APPROVED` |
| Rejected by the user | `QUEUE_ACTIONS.REJECT` | `USER_REJECT` |
| Expired / price escaped before approval | `expiry-sweeper` | `EXPIRED` |
| Post-detection strategy skips (a signal fired but a filter dropped it: ORB too extended / low volume / under VWAP / weak tape / negative news / ATR cap; Quick Flips signal skips) | inside the strategy, through `research/decision-context.js` | `STRATEGY_BLOCK` (INCOMPLETE: direction + trigger, no levels) |
| Position opened (fill price, time, size) | `paper-ledger.openPosition` | `OPENED` |
| Position closed / partially closed (exit price, reason, net) | `paper-ledger.closePosition` | `CLOSED` |

**[C1] Lifecycle events are never deduplicated.** STAGED, APPROVAL_HOLD, APPROVAL_REJECT, APPROVED, USER_REJECT, EXPIRED, OPENED and
CLOSED are written every time they happen. Only *repeated observations* are deduplicated: the same STRATEGY_BLOCK / PIPELINE_REJECT
(same id, path and reason bucket) re-proposed every 60 s. The first observation carries the full snapshot. Repeats are summarized in a
`REPEATS` line (count, first / last seen, last price): at most every 15 min per id, whenever that id has a lifecycle event, and at the
US/Eastern day rollover.

### 3.2 One record

```
{ v: 1, at, path, id, strategyId, symbol, market, direction, setupType, timeframe, expectedDuration,
  reason, reasonBucket,                                  // the raw string + rejection-stats bucket
  levels: { entry, entryZone, stop, targets[], positionSize, dollarRisk } | null,
  option: { contract/legs, bid, ask, debit, quoteAgeMs, dte } | null,
  price: { last, bid, ask, at },                         // prices.getLatestPrice / quote cache (sync reads only)
  context: { thesis, signals: {...}, bars: { tf, t0, o[], h[], l[], c[], v[] } | null },   // section 3.3
  guard: { dayPnl, dailyLimit, openRiskPct, maxOpenRiskPct, sectorOpen, macroWindow } | null,  // inputs the rejecting rule used, when in scope
  code: <commit from server/version.js>, seq }
```

**Dedupe** applies to repeated observations only, as in 3.1. A path or reason that *changes*, for example rejected and then staged, is a
new record.

### 3.3 Decision context (the chart and signals the app actually used)

- **The four radar strategies hand their decision inputs to `research/decision-context.js`** (equity-day, equity-swing, options-system,
  options-quickflips), for every candidate and every strategy-level block. **[C1] All inputs actually used:**

  | Strategy | Inputs kept |
  |---|---|
  | ORB | today's session 1-minute bars, SPY's session bars, the daily bars behind the ATR cap, the catalyst headline |
  | Swing | the full daily-bar history it read (SMA50, the 10-day high, the 5-day low, resistance), the live price, the earnings status, the news label |
  | Options Spreads | the 260 long daily bars, the hourly bars, the session 1-minute bars, SPY's change, the signal context, the chosen contract quotes, IV / HV |
  | Quick Flips | today's minute slots, the prior 30 sessions of 5-minute bars, the signal (trigger, VWAP, RelVol, OR), the contract quote |

  The numeric signal values behind the thesis are kept too.
- **Kept beside the candidate, never on it.** The context goes into a bounded in-memory store keyed by setup id (at most 500 ids, oldest
  evicted). Staged orders are saved in the ledger and broadcast to the browser, so chart data never enters the ledger or the browser.
- **Each distinct bar series is written once** to the day's file, keyed by symbol, timeframe, first / last bar time, count and last
  close / volume. Decision records reference series by key, so 50 rejections sharing SPY's bars cost one copy. A series is capped at
  3,000 bars; past that the newest 3,000 are kept and `truncated: true` is set and counted.
- Capture is an array `slice()` of data the strategy already holds. No extra fetch, no change to any computed value.
- **A tests-enforced invariant:** the strategies' signals and candidates are identical with and without the context. The existing
  live-signal == replay suites must stay green, and a new check compares candidates field by field.
- **Fallback:** a path with no context (an older setup, or a block raised before bars exist) records `context: null`. The report marks it
  **"decision chart not recorded: reconstructed from history"**.

### 3.4 Lightweight and non-blocking

- **[C5] Nothing heavy runs in the trading path.**
  - `record()` and `capture()` are synchronous, wrapped in try/catch, and never throw or await.
  - In the trading path they only take shallow references and `slice()` copies, plus a few scalar fields. They do no JSON
    serialization, hashing or formatting.
  - Events go to an in-memory queue capped at 5,000 entries; overflow drops the oldest and counts it.
- **Serialization runs off the trading path.** A 5-second timer (`unref`) converts queued entries to compact JSON lines in slices of at
  most 10 ms, yielding with `setImmediate` between slices, and then appends with one `fs.promises.appendFile`.
  - Bars become `[t,o,h,l,c,v]` rows, and series are deduplicated here.
  - One write is in flight at a time, and a failed write puts the batch back on the queue (dropping overflow).
  - A single serialized record over 512 KB is cut to its last 500 bars per series and flagged `truncated`.
- **Files:** `decisions-YYYY-MM-DD.jsonl`, next to the ledger (`DECISIONS_DIR`, default `server/data`, git-ignored).
- **CPU cost:** a few slices per NEW observation. Repeats only bump a counter.
- Files older than 180 days are deleted at startup.
- Tests set `DECISIONS_DIR` to a scratch folder.

### 3.5 Visible recording failures

`status()` returns `{ enabled, recordedToday, byPath, queued, dropped, serializeErrors, writeErrors, truncated, missingContext,
lastError, lastWriteAt, file }`. `missingContext` counts decision records from a radar strategy that arrived with no captured inputs.
In the report, the analyzer also flags **missing records**: journal trades, positions or discarded setups dated after the recorder
started that have no recorder event. It is shown in four places:
- `/api/version` (signed in);
- a one-line **Settings > Strategies** footer: "Decision recorder: 214 today · 0 dropped · last write 14:05", amber when there are drops or errors;
- the log, `[decision-recorder] ... write failed (...)`, at most once per 5 min;
- `scripts/vm-audit.sh`, which prints the status and copies the last 35 days of `decisions-*.jsonl` into the archive.

## 4. Offline analyzer (PC): `tools/decision-review/`

Run: `node tools/decision-review/run.js <extracted archive folder> [--out reports/]`. It is read-only towards the archive, and it never
requires a `server/` module that touches the ledger. Market data comes from Alpaca's data API, using the data keys in this PC's `.env`
in headers only and never printing them, and is cached under `reports/.cache/` (git-ignored).

| Module | Job |
|---|---|
| `load.js` | Read `decisions-*.jsonl`, `ledger-snapshot.json`, `paper-runs.json` and `pm2-logs.txt`. Merge them into one decision list keyed by setup id, and attach realized outcomes from the journal. **Historical reconstruction (section 7)** also runs here. |
| `bars.js` | Fetch and cache bars. Stocks: 1-minute **IEX** (what the app saw: chart reconstruction and check against the recorded bars) and 1-minute **SIP** (what the market did: the outcome paths). Option contracts: Alpaca option 1-minute **trade** bars (Feb 2024+). |
| `measure.js` | Movement at 5 / 15 / 30 / 60 min, at the session close and at the end of the planned holding period; MFE / MAE; interim vs completed. |
| `classify.js` | The fixed definitions in section 5. |
| `simulate.js` | Realistic trade (section 6.2) and the opposite direction (section 6.3). |
| `safeguards.js` | Whether a rejection followed its intended rule (section 6.4). |
| `patterns.js` | Conditions present before the decision that preceded wrong calls (section 8). |
| `render.js` | One self-contained HTML file (inline SVG charts, no external scripts or fonts) plus `report.json`, the input for the later in-app view. |

Every `.js` stays at or under 300 lines.

## 5. Fixed definitions (frozen with this proposal; never re-defined after data is seen)

### 5.1 Inputs

- **Decision time t0** is the record's `at`. **Decision price P0** is the last trade at t0, from the record, else the 1-minute SIP close of
  the t0 minute.
- **Direction d** is +1 for long / call setups and -1 for short / put setups. Options are judged on the **underlying**.
- **Unit u:**
  - with levels: u = |entry - stop| (the setup's own 1R in price);
  - without levels (incomplete): u = ATR(14) of the setup's timeframe at t0, from pre-t0 bars.
- **Signed move at a horizon h:** m(h) = d x (P(h) - P0) / u. P(h) is the 1-minute SIP close at t0 + h, or the regular-session close for
  "session close".
- **Horizons:**
  - 5, 15, 30 and 60 minutes;
  - the session close (regular 4:00 PM ET);
  - the planned end H. A horizon that falls outside regular hours uses the next regular-session minute. Each horizon is labelled
    **interim** except H.
- **Planned holding period H,** the upper bound of each strategy's own `expectedDuration`:

  | Strategy | H |
  |---|---|
  | Equity Day (ORB) | the end of the next regular session (it may carry overnight) |
  | Equity Swing | 10 sessions |
  | Options Spreads, swing | 15 sessions, or its 2-DTE auto-close if earlier |
  | Options Spreads, intraday | 5 sessions, or 2 DTE if earlier |
  | Quick Flips | 60 min, or 3:40 PM ET if earlier |
  | Crypto (any) | 24 h |

  A setup whose H has not passed by report time is **PENDING**: interim rows only, no final class.

### 5.2 Direction label at each horizon

- **CORRECT** if m(h) >= +0.25.
- **WRONG** if m(h) <= -0.25.
- **FLAT** if it is in between.
- **NO_DATA** if fewer than 90% of the 1-minute bars between t0 and h exist.

### 5.3 Completed-outcome class (setups with levels; the path from t0 to H on 1-minute SIP bars)

Terms:
- "T1 reached" = high >= T1 (long) / low <= T1 (short).
- "Stopped" = low <= stop (long) / high >= stop (short).
- "First" = the earlier minute. A same-minute tie counts as stopped.
- MFE / MAE = the maximum favourable / adverse excursion, in u.
- "Pre-move" = d x (P0 - P(t0 - L)) / u, with L = 60 minutes for intraday strategies and 5 sessions for Swing / Options swing.

Evaluated in this order, the first rule that matches wins:

1. **UNCLEAR**: path coverage under 90%, or the decision price is unknown.
2. **EARLY_ENTRY**: stopped first, and then T1 reached later within H (right direction, too early).
3. **REVERSAL_AFTER_ENTRY**: MFE >= +0.5 before the stop or H, then stopped or m(H) <= -0.25, and T1 never reached.
4. **LATE_ENTRY**: pre-move >= +1.0, and MFE < +0.5 within H, and stopped or m(H) <= -0.25 (the move had already happened).
5. **WRONG_DIRECTION**: stopped first with MFE < +0.5, or neither stop nor T1 reached and m(H) <= -0.25.
6. **CORRECT_DIRECTION**: T1 reached first, or neither reached and m(H) >= +0.25.
7. **UNCLEAR (no decisive move)**: neither reached and |m(H)| < 0.25.

**[C2] Every class above is computed on the UNDERLYING's 1-minute path only**, for options too: the stop / targets are underlying
levels. Contract performance is a separate column (section 6.2).

**Overlay, kept in a separate column:** **CORRECT_DIRECTION_TRADE_LOST** when the class is CORRECT_DIRECTION but the realistic trade
(section 6.2) has net R < 0. It states the fact only. **[C4]** The *explanation* goes in another column (section 6.5) and is
`UNATTRIBUTED` unless recorded evidence supports a cause. The direction counts and the trade counts are both kept, never merged.

### 5.4 Incomplete setups

A setup with a direction but no executable entry / stop / target is **INCOMPLETE**: strategy blocks raised before levels exist, and
reconstructions without levels. It gets the section 5.2 horizon labels only, with u = ATR. It never gets a section 5.3 class, a trade
simulation or an opposite-direction simulation, and it is counted in its own table.

## 6. Three separate measures (never combined into one score)

### 6.1 Direction accuracy

Per strategy, setup type, path (accepted / rejected by reason / expired / user-rejected) and horizon:
- counts of CORRECT / WRONG / FLAT / NO_DATA;
- the share CORRECT among the decisive ones, with a Wilson 95% interval;
- section 5.3 class counts.

### 6.2 Realistic trade profitability

The strategy's own fills, exits and costs, as if the setup had been approved at t0 + 60 s:
- **Stocks:**
  - the entry fills only if price trades through the entry or zone within the approval window (8 / 15 / 30 min per setup-ttl);
  - stop and targets as the strategy sets them, including the T1 50% partial and the runner;
  - 0.05% slippage per leg (cost-authority stocks);
  - no time exit (Phase 76B), with H as the evaluation cap.
- **Options, by price-source tier [C3]** (the best available tier is used, and the tier is printed beside every result):
  1. **QUOTED / RECORDED.** Accepted trades: the ledger's own fills and exits (paper fills at the natural ask / bid) and the recorded
     marks. Every setup: the bid / ask recorded at decision, which sets the entry (buy at the ask). This is the realistic result.
  2. **ESTIMATE (trade prints).** After the decision, with no recorded quotes:
     - Alpaca option 1-minute trade bars;
     - an exit fills at the print minus the half-spread recorded at decision (sells), and an entry at the recorded ask;
     - the app's own exit rules (Quick Flips -30% / +45% / VWAP-fail / 60 min / 3:40 PM; spreads: stop / T1 values, 2 DTE);
     - $0.65 per contract per fill.

     Always labelled "estimate: trade prints, not quotes".
  3. **UNAVAILABLE.** Too few prints (no print in a 15-minute stretch of the path, or under 5 prints in total), or no recorded contract.
     Contract P&L shows as "unavailable", never guessed.
- **Accepted trades** also show the **recorded** journal result next to the simulated one. A mismatch is reported, not hidden.

### 6.3 Opposite direction (fixed rules, realistic costs)

- Same t0 and fill timing.
- Entry at the same price rule on the opposite side.
- Stop at the same distance u beyond the entry; T1 at the same R multiple as the original's T1; the same H and costs.
- **[C3] Options:** the opposite contract (a put for a call, and vice versa) was never quoted. So its **contract P&L is "unavailable"**.
  Only the underlying directional outcome of the opposite side is shown (the section 5.2 / 5.3 labels with d reversed), plus a
  stock-like underlying trade labelled "underlying proxy, not an option result".
- Spot crypto is not simulated, since it can't be shorted.
- Reported as counts and net R, side by side with the original. **The opposite is never assumed to win because the original lost.**

### 6.4 Did a rejection follow its intended safeguard?

The **rule check** asks whether the recorded inputs show the rule's own condition was true when it fired:

| Reason | The check |
|---|---|
| DAILY_LOSS_LIMIT | dayPnl <= -limit |
| MACRO_SHIELD | an event from the macro list within -30 / +15 min |
| SECTOR_CAP | open + staged in the sector >= cap |
| Cost ceiling | fee drag from the recorded levels and fees > the cap |
| PORTFOLIO_RISK | open + new risk > maxOpenRiskPct |
| Stacking | an open record on the symbol |
| EXPIRED | age > TTL with no approval |
| USER_REJECT | the click is recorded |

The verdict is **CONSISTENT**, **INCONSISTENT** (a bug to fix) or **NOT_VERIFIABLE** (the inputs weren't recorded, as in historical
records). The **hypothetical outcome** of the blocked trade (6.1 / 6.2) is reported *next to* the verdict, as "avoided -1.0R" or
"missed +2.1R". It is not a judgement that the rule was wrong.

### 6.5 Why a correct call lost: evidence-backed causes only [C4]

A cause is assigned only when its evidence exists in the records. Otherwise it is `UNATTRIBUTED`, with a note on what was missing.
Several causes can apply.

| Cause | Required evidence |
|---|---|
| ENTRY_NOT_FILLED | the path never traded through the entry within the approval window (recorded window) |
| COSTS_EXCEEDED_EDGE | gross R >= 0 and net R < 0 (the recorded fees / slippage model) |
| STOPPED_BEFORE_MOVE | stopped first, T1 later (the 5.3 EARLY_ENTRY path): a timing cause, also counted under timing |
| EXIT_RULE_BEFORE_MOVE | the strategy's own non-price exit (VWAP-fail, 60 min, 3:40 PM, 2 DTE) closed it, and the move came after |
| ENTRY_SPREAD_COST | recorded decision bid / ask: the half-spread at entry + exit is greater than or equal to the trade's gross gain |
| CONTRACT_DELTA_TOO_LOW | recorded decision delta: delta x the underlying move < the entry half-spread + fees |
| TIME_DECAY | recorded decision theta and a QUOTED tier-1 exit: theta x hold days explains at least 50% of the loss, AND IV moved under 10% relative |
| VOLATILITY_CRUSH | a recorded IV at decision AND a recorded IV at exit (tier 1 only): IV fell at least 15% relative and explains at least 50% of the loss |

Trade prints (tier 2) never support TIME_DECAY or VOLATILITY_CRUSH: prints carry no IV and no reliable mid.

### 6.6 Evidence labels on every number [C5]

- **RECORDED:** captured live at the decision or the event.
- **LEDGER:** the app's own fills and journal.
- **FETCHED:** historical bars or prints downloaded afterwards.
- **RECONSTRUCTED:** rebuilt from ids or log lines, with fields missing.

The report shows the label with each chart, level and result. When RECORDED bars and FETCHED bars for the same pre-decision minutes
disagree (any close off by more than 0.1%), the card says so. The headline counts can be filtered to RECORDED-only.

## 7. Historical reconstruction (before the recorder existed)

Every record built from older sources gets `source: 'reconstructed'` and a `missing: [...]` list, and every missing field shows in the
report as **"not recorded"**.

| Source in the archive | What it yields | What is missing |
|---|---|---|
| journal (80 closed) + open positions | APPROVED / closed, with levels, thesis, timestamps and the realized result | the decision chart, signal values and guard inputs |
| `discardedOrders` (expired / rejected after staging) | EXPIRED / USER_REJECT / APPROVAL_REJECT, with levels | the same |
| paper-runs archive | Run 1 trades, as for the journal | the same |
| `pm2-logs.txt` (`[pipeline] rejected <id>: <reason>`) | PIPELINE_REJECT with strategy, symbol, date (+ minute for Quick Flips) parsed from the id | levels (so **INCOMPLETE**), exact time (only within the log line's minute), direction (where the id doesn't encode it: UNCLEAR) |

The decision chart for reconstructed records is rebuilt from IEX history up to t0 and labelled "reconstructed".

## 8. Repeated mistakes: evidence from pre-decision information only

- **Features**, all computed only from data at or before t0, and pre-declared here:
  - time of day (6 buckets), minutes since the open, weekday;
  - opening gap %;
  - the pre-move (section 5.3) in u;
  - distance from VWAP and from the signal's own MA in ATR;
  - RelVol;
  - ATR % of price;
  - SPY vs its VWAP and SPY's 5-day trend;
  - minutes to / from a high-impact macro event;
  - earnings within the hold;
  - for options: quote age, spread % of mid, DTE;
  - setup type.
- **Bins are fixed here,** not tuned to the data. Ranges are tertiles of each feature over the first 4 weeks of records, frozen when the
  4-week report is generated.
- **Method:**
  - for each feature bin, the WRONG_DIRECTION share (and, for rejections, the "missed opportunity" share, i.e. CORRECT among rejected)
    against the overall rate;
  - Wilson 95% intervals;
  - a minimum of 20 setups per bin;
  - Benjamini-Hochberg correction at a 10% false-discovery rate across all bins tested.
- **The report says "associated with", never "caused by",** and lists each flagged bin with its n, its rate, the base rate and example
  charts.

## 9. From patterns to proposals (no trading change in Phase 93)

1. A pattern that survives section 8 can be written up as a **candidate rule** in `docs/research/phase93-proposals.md`. It gives the exact
   pre-decision condition, the expected effect, and its pass criteria.
2. That file is **frozen by its commit** (the freeze record) **before** any later data is examined.
3. It is evaluated **only on setups recorded after the freeze commit**: new, untouched data. At least 30 affected setups are needed, and it
   passes only on its pre-stated criteria (for example a lower WRONG share with the interval excluding the old rate, with no drop in net R).
4. Only a passed proposal may become a separate, explicitly approved trading-rule phase. Phase 93 itself never changes the trading system.

## 10. The report (local, private)

- **The first screen answers four questions,** each a sorted list with links to the setup cards:
  1. **Accepted trades that chose the wrong side:** accepted, with a WRONG_DIRECTION / LATE_ENTRY class on the underlying.
  2. **Rejected setups that moved as predicted:** rejected or expired, with CORRECT_DIRECTION or EARLY_ENTRY, each with its rejection
     reason and the rule-check verdict.
  3. **Repeated mistakes:** the classes and setup types that recur, by strategy, with counts.
  4. **What was known before the decision:** the section 8 feature bins that separate wrong from right calls, or "not enough data".
- `reports/decision-review-<date>.html` is git-ignored and opened from disk. It contains:
  - a summary;
  - the measures 6.1, 6.2, 6.3 and 6.4 as separate sections;
  - an accepted vs rejected comparison;
  - the INCOMPLETE table;
  - the flagged patterns;
  - one card per setup, with a chart of the pre-t0 bars as the app saw them, then the path to H with entry / stop / targets / t0 marked,
    plus the horizon table, class, sim results, rule check and "not recorded" flags.
- `reports/decision-review-<date>.json` holds the same results for the later in-app view.
- Pending setups are shown and refreshed on the next run.

## 11. Testing

- `tests/ph93unit.js` (recorder):
  - `record()` never throws, even on malformed input or circular objects;
  - it is synchronous, and a stalled or failing append never delays a pipeline pass (a fake fs that hangs / throws);
  - dedupe and the `REPEATS` line;
  - the queue cap with its drop counter;
  - failure status in `/api/version` and the log rate limit;
  - a real pipeline pass and approval writing the expected paths (scratch ledger, stubs, the usual mocks);
  - **the strategy outputs are identical with and without `decisionContext`.**
- `tests/ph93review.js` (analyzer, synthetic bars):
  - every section 5 rule, including the precedence order and same-minute ties;
  - horizon edge cases (after hours, half-days, coverage under 90%);
  - INCOMPLETE handling;
  - opposite simulation symmetry;
  - each section 6.4 check (CONSISTENT / INCONSISTENT / NOT_VERIFIABLE);
  - pattern statistics on a known dataset;
  - reconstruction from a sample archive.
- All 52 existing suites plus `check:limits`. Browser harness (port 3999) for the Settings footer.
- A first real run on the 2026-10-05 archive (historical reconstruction only).

## 12. Implementation plan (each task: its tests, then `check:limits`, then a commit)

| # | Task | Files | Done when |
|---|---|---|---|
| 1 | Recorder core: queue, async append, dedupe, rotation, status | new `server/research/decision-recorder.js`; `tests/ph93unit.js` | the unit checks pass with a hanging / failing fs |
| 2 | Hook the capture points (section 3.1) | `execution/pipeline.js` (blocks, `recordRejection`, staged: ~3 lines), `execution/order-router.js` (hold / reject / approved / user reject), `execution/expiry-sweeper.js`, `execution/paper-ledger.js` (OPENED / CLOSED), `server/version.js` (status in `/api/version`) | a real pass and approval write every path; the 52 suites stay green |
| 3 | Decision context in the four radar strategies (no computed value changes) | `strategies/1-equity-day.js`, `3-equity-swing.js`, `5-options-system.js`, `7-options-quickflips.js` (+ `server/research/decision-context.js`: the bounded id-keyed input store) | the identical-output check passes; live == replay suites green; each file stays at or under 300 lines |
| 4 | Visibility: Settings footer + vm-audit copies the files and prints status | `client/views/settings-strategies.js`, `scripts/vm-audit.sh`, `docs/deploy/phase93-decision-recorder.md` | harness screenshot; a vm-audit run against a scratch folder |
| 5 | Analyzer: load + historical reconstruction | `tools/decision-review/load.js`, `run.js` | the sample archive reconstructs with `missing` flags |
| 6 | Bars + horizon measures | `tools/decision-review/bars.js`, `measure.js` | synthetic + cached-real checks |
| 7 | Classification, simulations, safeguard checks | `classify.js`, `simulate.js`, `safeguards.js`; `tests/ph93review.js` | every section 5 / 6 rule tested |
| 8 | Patterns + proposal scaffold | `patterns.js`, `docs/research/phase93-proposals.md` (empty template, frozen later) | statistics tests on a known dataset |
| 9 | Renderer + first report on the 2026-10-05 archive | `render.js`; `.gitignore` adds `reports/` | the report opens locally; every record links its chart and flags |
| 10 | Docs + final review | `CLAUDE.md` (Phase 93 note) | a whole-branch review; push to a review branch + PR; **no deploy** until you say so |

Tasks 1-4 touch the server, so they ship together and need a deploy before recording starts. Tasks 5-9 are PC-only. Task 9 can run on the
existing archive before the deploy.

## 13. Limits, stated now

- Recording starts only after the deploy. Everything earlier is reconstruction and mostly INCOMPLETE. Today's (2026-10-05) gate rejections
  survive only as the last 400 log lines.
- The app's live chart is the IEX feed and the outcome paths use SIP, so small differences are possible and are flagged when the recorded
  bars and the IEX reconstruction disagree.
- Options profitability rests on trade prints, not quotes, and some contracts will be NOT_ESTIMABLE.
- These strategies failed their profitability tests, but that does not show their direction calls were mostly wrong: costs, exits and
  timing can lose with a correct direction. The report measures direction separately, and makes no assumption either way.
- A few weeks of records are needed before section 8 has 20+ setups per bin. Until then the report lists the findings as "not enough data".
