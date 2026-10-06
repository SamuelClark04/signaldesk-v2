# Phase 94: Market Observation and Event Research Layer (design draft, revision 2, for review)

Status: **DRAFT revision 2, 2026-10-05, not approved.** Nothing here is implemented. No deploy. No change to trading rules,
safeguards, approvals or automation.
- **Revision 1** designed the event layer: news and events, availability times, variables, option life cycle, splits.
- **Revision 2** adds:
  - a full-day observation layer across the fixed universe: every up move, down move, rebound, quiet period and false signal;
  - a documented related-company / exposure map;
  - hindsight vs real-time opportunities;
  - call and put evaluation with realistic contracts, fills and exits;
  - a CONTINUOUS research process that accumulates history, runs periodic discovery, and freezes proposals before testing them on
    data collected afterwards.
- It builds on Phase 93 (PR #2: the decision recorder + Decision Review). The PR #2 accuracy fixes you asked for stay in scope and
  land first (Stage 0).

## 0. Understanding

**You said (both rounds):**
- The goal includes opportunities the existing strategies NEVER generated. So observe the whole market day across a fixed universe,
  not only the app's decisions.
- Record:
  - upward and downward moves, rebounds, quiet periods and false signals;
  - news, scheduled events, related-company developments, sector moves and market conditions, aligned in time.
- The related-company map is documented in advance, never assembled from headlines after seeing the move.
- Separate what EXPLAINS a move (association) from what PREDICTS one (evidence of predictive value).
- **Real-time honesty:**
  - an entry is tested only once its trigger was available (a rebound bottoming at 10:14 with a trigger available at 10:17 is
    entered after 10:17);
  - hindsight-best entries, exits and contracts are BENCHMARKS, never strategy results.
- Calls AND puts, with contracts chosen from entry-time information and realistic quotes, fills, costs and exits.
- **A continuous process:**
  - data accumulates over days and weeks, never reset;
  - daily reports are progress views; periodic broader analyses look for relationships repeating across days and stocks, including
    the cases where the same conditions failed;
  - each candidate shows its sample size, consistency, uncertainty, entry conditions, holding period and after-cost profitability;
  - proposals become mechanical rules, frozen, then tested on data collected AFTER the freeze before they may influence trading.
- The observation period is not the holding period. Each holding horizon is evaluated on its own.
- Time-of-day patterns are learned statistically; a stock is never assumed to repeat yesterday's turning times.
- Calendar time is not evidence. A candidate needs enough INDEPENDENT examples.

**Assumptions (please correct):**
- A1. "Elsewhere" = this PC. The VM only does light capture.
- A2. **Your Amazon example = AMZN on Friday 2026-10-02.** It isn't in any earlier session, so I matched it from the data:
  - the morning decline runs from 09:32 to 11:53;
  - the rebound inside it runs from 09:56 to 10:20.

  If you meant another day, section 12.3 is re-run on it unchanged.
- A3. **I still could not find the PR #2 accuracy fixes list:** the PR has no comments or reviews, and no session mentions one.
  Stage 0 waits for it.
- A4. Realistic option quotes need a paid history source (section 4). Until it is bought, option results are "unavailable", never
  modelled and presented as real.

## 1. Approaches considered

| | Approach | Verdict |
|---|---|---|
| A | **Thin live capture on the VM; observation, warehouse and research on the PC** | **Recommended.** The VM records only what cannot be fetched later. Bars, quotes, filings and calendars are reproducible and are fetched on the PC. |
| B | Run the observation layer on the VM in real time | Rejected: 0.25 vCPU, Alpaca's free stream symbol limit, and research code inside the trading process. |
| C | Vendor history only | Rejected as the only source. It never yields our receipt times or article versions. It is still used for backfill, labelled. |

## 2. Architecture

```
VM (record-only, unchanged trading)                 PC (research; append-only warehouse; never touches the VM)
 news stream tap + 5-min poll ─┐                     daily job (after the close, idempotent, catches up missed days)
 macro / earnings snapshots ───┼─► events-*.jsonl     ├─ fetch: IEX + SIP 1-min bars, SIP quotes (sampled), Alpaca news,
 open-option marks ────────────┘   (Phase 93 sink)    │         EDGAR, calendars, option NBBO per opportunity (paid)
 decision recorder (Phase 93) ───► decisions-*.jsonl  ├─ observe: moves (multi-scale), quiet, triggers, false signals
            │                                         ├─ align: events, exposure map, sector ex-self, market
            └── vm-audit archive (weekly, by you) ──► ├─ evaluate: real-time opportunities (stock / call / put) + benchmarks
                                                      ├─ store: research-data/ (DuckDB + Parquet, git-ignored)
                                                      ├─ reports/daily-<date>.html          (progress view)
                                                      └─ periodic discovery run ─► candidates ─► proposals (frozen by commit)
                                                                                        └─► forward evaluation on later data
```

- **Hard boundary:**
  - `server/` never requires `tools/`, and a test enforces it;
  - research writes files on the PC only, never settings, strategies, the ledger or the VM;
  - a rule reaches the app only through its own trading-rule phase, which you approve (section 14).
- **VM data reaches the PC only through your weekly `vm-audit` archive** (this PC cannot reach the VM).
  - Daily reports are therefore provisional for news timing: `PROVIDER_TIMESTAMPED` until the archive arrives, then upgraded to
    `LIVE_VERIFIED` where the VM recorded the receipt.
  - The report states which days are still provisional.

## 3. Universe and the documented exposure map

### 3.1 Universe (requirement: no outcome selection)

- **universe-v1** is frozen by commit before any data is fetched. It is a rule:
  - the S&P 100 on the freeze date;
  - the 11 SPDR sector ETFs, plus SMH, KRE, XBI, XRT and IYT;
  - SPY, QQQ, IWM, and VIX (daily; intraday VIXY proxy, labelled);
  - the app's watchlist on the freeze date.
- **No symbol enters or leaves because it moved.** Removed constituents stay through their last day.
- Changes create a new version, and every row carries its universe version.

### 3.2 Exposure map (`exposure-map@N`, frozen BEFORE outcomes are examined)

For each universe company, a reviewed file lists its relationships. Each entry carries:
- a relation type;
- the related symbols / ETFs / macro series;
- a weight where one is documented;
- a SOURCE citation;
- the date it was added.

| Relation | Built from | Example for AMZN (illustrative: weights and lists are filled from the latest 10-K when built) |
|---|---|---|
| SECTOR_ETF (ex-self) | the ETF's holdings; the stock's own weight is removed (section 9.1) | XLY (AMZN is one of its largest holdings), QQQ |
| SEGMENT exposures | 10-K segment note (XBRL `companyfacts`), revenue / operating income share | North America and International retail, AWS, advertising |
| SEGMENT peers | per segment, the named competitors in the 10-K "Competition" section + SIC peers in the universe | retail: WMT COST TGT EBAY SHOP; cloud: MSFT GOOGL ORCL; ads: META GOOGL |
| SUPPLY CHAIN | 10-K / 10-Q disclosures + major-customer notes of suppliers; curated with citation | AI hardware and capex: NVDA AVGO AMD MU; logistics: UPS FDX |
| MACRO sensitivities | fixed table by segment | retail sales, consumer sentiment, CPI; rates; USD |
| REGULATORY themes | fixed keyword sets with sources | FTC antitrust, EU DMA / cloud rules, labor / unions, tariffs |

**Rules:**
- **A headline or peer move is "related" only through the map in force on that day.** The match is: a tagged symbol in the map, a
  segment keyword, or a macro series. Nothing is chosen after seeing the move.
- **Changes are new versions.** A version applies only to data AFTER its commit, and analyses name the map version.
- **Map quality is measured, not assumed.** For each version, the report lists how many large residual moves had a mapped
  related-company or exposure event before them, versus how many had a pre-move event the map did NOT cover. The second count is
  shown as a coverage gap and becomes a proposed map edit, applied forward only.

## 4. Data sources (checked 2026-10-05 on the providers' pages / docs unless marked)

| Need | Source | Coverage / timing | Cost | Use |
|---|---|---|---|---|
| Bars the app sees | Alpaca historical **IEX** 1-min | 2016+; reproducible | free | triggers are computed on IEX, which is what the live app sees |
| Market outcome path, stock quotes | Alpaca historical **SIP** bars and quotes (free plan: data older than 15 min; verified today: a request touching the last 15 min returns 403) | 2016+ | free | outcomes; stock fills at the SIP ask / bid |
| Company news | Alpaca News (Benzinga): `id headline author created_at updated_at summary content url symbols source` | since 2015; REST has the CURRENT version only; 200 calls / min free | free | versions + receipt only from the VM capture |
| Filings | SEC EDGAR submissions (`acceptanceDateTime`; SEC states < 1 s processing delay; 10 req / s, User-Agent) | full | free | 8-K items, 10-K / Q, S-3, 13D / G, Form 4 |
| Earnings dates + consensus | Finnhub free (calendar 1 month ahead with estimates; EPS surprises only the last 4 quarters; upgrades / downgrades NOT free) | snapshots from the capture start | free | point-in-time consensus = daily snapshots |
| Analyst actions | Benzinga headlines (free, extracted); structured Benzinga ratings via Massive $99 / month | | free / optional | buy only if extraction misses > 10% |
| Macro | official schedules (built in); Forex Factory weekly JSON (forecast / previous, current week only, no actual: sampled today); ALFRED actuals with vintages (not re-verified) | | free | macro surprise exists only from the capture start |
| **Option quotes, history and forward** | **ThetaData**: Value $40 / mo (1-minute, 6 years, 2 concurrent requests); Standard $80 / mo (every OPRA NBBO quote, tick, 10 years); Pro $160 / mo | runs on the PC (Theta Terminal) | $40-80 / month while research runs | **Required for any real option result.** Fetched PER OPPORTUNITY (section 8.5), not whole chains. Check at purchase whether historical IV / Greeks come with the tier, else solve IV from NBBO mid locally. |
| | Massive Options Advanced $199 / mo (quotes, 5+ years); Databento OPRA CBBO-1m from 2013 ($/GB, $125 free credit) | | | alternatives |
| Live quotes of open positions | Alpaca indicative feed (already polled) | live only; no historical option quotes at Alpaca | free | the open-position life cycle (section 10) |

**Costs:**
- The stock-side observation layer is **$0**.
- Real option opportunities need ThetaData: **$40 / month (Value, 1-minute)** is enough for minute-level fills; Standard ($80) gives
  tick-level fills.
- This is your decision (section 17).

## 5. Time, availability and real-time entry timing

- **Every document version** carries:
  - `t_pub` (provider publication);
  - `t_rev` (revision);
  - `t_recv` (our first receipt; VM capture only);
  - `t_cls` (classification available);
  - `t_known = max(t_recv or t_avail_est, t_cls)`.
- **Labels:** `LIVE_VERIFIED`, `SOURCE_TIMESTAMPED` (EDGAR, agency time), `PROVIDER_TIMESTAMPED`, `DAY_ONLY` and `UNVERIFIED`.
  - Estimated availability = `t_pub + 60 s`, or the next open for day-only dates.
  - `UNVERIFIED` is never "known before" anything.
  - A backfilled article whose current version postdates the entry is `TEXT_MAY_POSTDATE` and is excluded from entry features.
- **Bar-based triggers:**
  - a 1-minute bar is available at its end + 2 s (stream delivery) + 3 s (processing), so `t_avail = bar_end + 5 s`;
  - the order is placed at `t_avail + 1 s`;
  - stock fills at the SIP ask (buy) / bid (sell) at that second;
  - option fills at the NBBO ask / bid at that second (ThetaData Standard), or at the END of that minute (Value: the conservative
    choice);
  - no fill is assumed at any earlier price.
- **News triggers** act at `t_known + 1 s` under the same fill rules.
- **Bar sources differ.** The trigger uses IEX bars (what the app sees); the fill and outcome use SIP. A trigger that fires on IEX
  but not on SIP is still a firing; the difference is counted.
- **Entries come only from causal triggers.** Pivot times found in hindsight are never entry times.

## 6. From news to variables (unchanged from revision 1, condensed)

- **Documents and events.** Documents (each version kept, text gzipped with a sha256) are grouped into events:
  - first by structured key: accession number, symbol + fiscal period, symbol + firm + action + date, release + period;
  - then by text similarity: the same subject within 24 h and headline Jaccard >= 0.5.
- **An event's `t_known`** is its earliest document's. Links to prior events give novelty.
- **Classifier `evt-rules@1.0.0`:**
  - deterministic rules: EDGAR form / 8-K items, Benzinga formulaic headlines, wire and agency names;
  - it never sees prices after `t_known` (a test proves its output is identical with future bars present);
  - quality is measured on a 300-document golden set labelled before tuning;
  - LLM classification is off by default because of hindsight leakage.
- **`REACTIVE`** = recap language, or the move from `t_pub - 30 min` to `t_pub` already beyond 1.5 x ATR30. A reactive article is
  never a cause.
- **Event variables:**
  - category, subtype, companies (SUBJECT / MENTIONED / PEER), sectors, scope, scheduled (+ `schedule_known_since`, or
    `SCHEDULE_ASSUMED` for backfill), novelty, `doc_count_at_t`;
  - nature (FACT / OPINION / MIXED), source tier 1-4, confidence (the rule's golden-set precision), age;
  - surprise and surprise_z (only from a point-in-time snapshot);
  - guidance direction, analyst action, text sentiment (text only, never fitted to returns), reactive, availability.
- **Revision 2 adds `map_relation`:** how the event reaches each universe symbol through the exposure map (SELF, SEGMENT_PEER,
  SUPPLY_CHAIN, SECTOR, MACRO, REGULATORY, NONE).

## 7. Live capture on the VM (unchanged from revision 1)

- **What is captured:**
  - a news stream tap (the existing socket; universe symbols added; the app's own handler input is unchanged, tested);
  - a 5-minute REST poll by updated date, for new versions;
  - macro calendar snapshots (a tap on the daily refresh);
  - one Finnhub calendar call a day;
  - open-option leg marks once a minute (a tap on quotes already fetched).
- **How it is written:** through the Phase 93 sink.
  - `record()` is sync and never throws;
  - the queue is bounded;
  - writes happen in 10 ms slices;
  - status is visible;
  - no network call inside a pass;
  - 60-day retention, with the PC archive as the system of record.

### 7.1 Sample event record (illustrative, not real data)

```json
{
  "v": 1, "kind": "EVENT", "eventId": "evt_20261006_AMD_ANALYST_7f3a",
  "classifier": "evt-rules@1.0.0", "vars": "vars@1", "universe": "universe-v1", "map": "exposure-map@1",
  "category": "ANALYST", "subtype": "UPGRADE",
  "analyst_action": { "firm": "Example Securities", "from": "Hold", "to": "Buy", "pt_old": 150, "pt_new": 185 },
  "companies": [{ "symbol": "AMD", "role": "SUBJECT" }, { "symbol": "NVDA", "role": "MENTIONED" }],
  "map_relation": { "AMD": "SELF", "NVDA": "SEGMENT_PEER", "SMH": "SECTOR" },
  "scope": "COMPANY", "scheduled": false, "novelty": "NEW", "nature": "OPINION", "source_tier": 2, "confidence": 0.97,
  "surprise": null, "surprise_source": "NONE", "text_sentiment": { "score": 0.6, "engine": "sentiment-nlp@58" },
  "reactive": { "flag": false }, "t_pub": "2026-10-06T13:05:12Z", "t_known": "2026-10-06T13:05:15Z",
  "availability": "LIVE_VERIFIED", "text_may_postdate": false,
  "docs": [
    { "docId": "alpaca:48123390@2026-10-06T13:05:12Z", "t_rev": "2026-10-06T13:05:12Z", "t_recv": "2026-10-06T13:05:14.210Z",
      "t_cls": "2026-10-06T13:05:15.210Z", "cls_timing": "CLS_SIMULATED", "seenVia": "stream", "contentSha256": "9b0e..." },
    { "docId": "alpaca:48123390@2026-10-06T13:21:40Z", "t_recv": "2026-10-06T13:25:02Z", "seenVia": "poll", "change": "content edited" },
    { "docId": "alpaca:48123517@2026-10-06T13:40:03Z", "role": "FOLLOW_UP", "reactive": true }
  ]
}
```

## 8. Full-day observation layer (new)

### 8.1 Moves at several scales, nested

- **Every universe symbol, every session, 09:30-16:00 ET** (pre-market kept as context), on SIP 1-minute closes.
- **Moves are cut with a zigzag at three fixed scales**, each a multiple of the symbol's ATR30 at the session open (computed from
  prior sessions only):
  - S = 1.0 x ATR30;
  - M = 2.0 x ATR30;
  - L = 4.0 x ATR30.
- **A move** = pivot to opposite pivot. Moves at a smaller scale nest inside larger ones, which gives a tree.
- **Move types:**

  | Type | Definition |
  |---|---|
  | UP / DOWN | a move at its scale, in the direction of its parent move (or of no parent) |
  | REBOUND (counter-move) | a move AGAINST its parent's direction, inside the parent (a bounce within a decline, a pullback within a rise) |
  | QUIET | a stretch of 30 min or more whose high-low range is under 0.75 x ATR30 |
  | FALSE_SIGNAL | a trigger firing (8.2) whose outcome fails its pre-declared success test (8.3) |

- **Each move records:**
  - start / end pivot times and prices;
  - its size in % and in ATR;
  - its duration and volume;
  - its parent / children;
  - its **confirmation time**: the first bar end at which the zigzag rule itself could know the pivot. Before it, the move is a
    hindsight object.
- **These are descriptive objects for explanation and benchmarks.** Pivots are found with hindsight, so a pivot is NEVER an entry
  time. Real-time entries come only from triggers.

### 8.2 Trigger library (`triggers@1`, causal, versioned)

Each trigger reads only data with `t_avail <= now`, and fires with a direction (CALL-side = up, PUT-side = down).

| Id | Fires when (computed on IEX 1-min bars at bar end) |
|---|---|
| T1 REVERSAL_CONFIRM | after a decline / rise of at least 1.0 x ATR30 since the session high / low, a bar closes 0.5 x ATR30 off the running extreme |
| T2 VWAP_CROSS | a bar closes across the session VWAP after 15+ min on the other side |
| T3 RANGE_BREAK | a close beyond the opening 15-min range, or the prior 30-min range |
| T4 RS_DIVERGENCE | the stock's 15-min return minus its sector ex-self return beyond 2 sd (the 20-session same-time-of-day distribution) |
| T5 PEER_SHOCK | a mapped related company moves beyond 2 sd in 5 min while the stock hasn't yet (beyond 1 sd) |
| T6 EVENT_ARRIVAL | a classified event with `map_relation` != NONE reaches `t_known` (direction = its pre-declared category rule, or both sides evaluated) |
| T7 QUIET_BREAK | the first close beyond a QUIET range, once the quiet range is confirmed at its 30-min mark |

- **Thresholds are fixed in `triggers@1`** before any outcome is examined. Changes create `triggers@2`, applied to all history but
  reported separately, and never "tuned" to the window being judged.
- **Every firing is stored, successful or not.** This is where false signals and the "same conditions failed" cases come from.

### 8.3 Outcomes of every firing (stock side)

- **Measured from the real entry** (5) at each fixed horizon: 5, 15, 30, 60 min, the session close, 1, 3 and 5 sessions.
  - `fwd_ret_h`, abnormal `fwd_ar_h` (9.1);
  - MFE / MAE in ATR;
  - time to +1 / -1 ATR;
  - continuation vs reversal.
- **Success test (`triggers@1`, fixed):**
  - success = MFE >= +1.0 x ATR30 before MAE <= -0.5 x ATR30, within the horizon;
  - otherwise FALSE_SIGNAL at that horizon.
- **Each horizon is separate.** A firing can succeed at 15 min and fail at the close.

### 8.4 Hindsight vs real-time, on every move

- **For each move at each scale:**

  | Measure | Label |
  |---|---|
  | pivot-to-pivot return | **HINDSIGHT BENCHMARK** |
  | from confirmation time to the end pivot | **CONFIRMATION BENCHMARK** (the zigzag's own confirmation needs hindsight of the threshold, so still a benchmark) |
  | the best trigger firing INSIDE the move, entered at `t_avail + 1 s`, exited by each pre-declared exit rule (8.6) | **REAL-TIME RESULT** |

- **Capture ratio** = real-time / hindsight. A move with no firing is "not recognizable in real time by triggers@1".
- The daily report shows all three side by side and never adds a benchmark into a strategy total.

### 8.5 Calls and puts (realistic contracts)

- **For every firing, both the stock result and the option result:**
  - a CALL for an up-firing, a PUT for a down-firing;
  - the opposite-side contract is also evaluated, as a control.
- **Contracts are chosen with entry-time information only.** Contract-selection rules (`contracts@1`) form a small fixed grid:
  - expiry class: the nearest weekly with DTE >= 3, 7-14 DTE, or 30-45 DTE;
  - delta target: 0.35, 0.50 or 0.70, from Greeks at entry (solved from the NBBO mid if the vendor has none);
  - structure: single, or a vertical about 1 ATR(daily) wide;
  - liquidity filters at entry: bid / ask <= 10% of mid, quote age <= 30 s, prior-day open interest >= 500. If no contract passes:
    NO_CONTRACT.
- **Quotes are fetched per opportunity.** ThetaData NBBO for the chosen contracts (and the benchmark contracts) from entry to the
  latest horizon.
- **Fills:** entry at the ask and exit at the bid (spreads: natural prices), $0.65 per contract per fill. A stale quote (> 30 s) at a
  fill time is UNFILLABLE at that moment; the fill moves to the next fresh quote and the delay is recorded.
- **HINDSIGHT-BEST CONTRACT** = the listed contract that would have returned the most over the realized move. It is a **benchmark
  only**, shown with its label.
- **Without paid option quotes, every option result is "unavailable"** (not modelled into a P&L). A Black-Scholes estimate may be
  shown only as "MODEL ESTIMATE", never in candidate profitability.

### 8.6 Exit rules (`exits@1`, evaluated separately)

- **Each exit rule family is applied to the SAME entries:**
  - fixed horizon;
  - underlying stop / target in ATR (0.5 / 1.0, 0.75 / 1.5);
  - premium stop / target (-30% / +45%, the Quick Flips values, for comparison);
  - trailing (0.5 ATR from the best);
  - event-aware (exit at the first new tier-1 / 2 event against the position, with `t_known` after entry);
  - scheduled-event exit (before a release inside the hold).
- **HINDSIGHT-BEST EXIT** (the best price inside the horizon) is a benchmark only.
- **Three separate evaluations** (as in revision 1):
  - **entry selection:** the underlying outcome, with the contract and exit held fixed;
  - **contract selection:** the same underlying entry and exit times, different contracts;
  - **exit:** the same entry and contract, different exits.

### 8.7 Explanation vs prediction (two separate stores)

| | Explanatory association (`explain_*`) | Predictive features (`feat_*`) |
|---|---|---|
| Question | what else was happening while this move happened | what was knowable when the trigger fired |
| May use | anything inside the move window, including events arriving during it | only values with availability `<= t_avail` of the firing |
| Output | per-move decomposition: market part (`beta_m x SPY`), sector ex-self part, peer part, residual. An event is a candidate for the residual only if its `t_known` precedes the residual move's start, it is not REACTIVE, and the residual is beyond the 90th percentile of the stock's matched no-event residuals; otherwise "no identifiable driver" | the inputs to candidate patterns and rules |
| May support a trading rule? | **never by itself** | yes, after freeze + forward test |

- **Guard:** `feat_*` reads go through one as-of accessor that refuses any column whose availability is later than the query time.
  A test injects a future-available value and expects a refusal.
- **Map-blind check.** Explanations are generated without reading the price outcome to select headlines: every mapped event in the
  window is listed, whatever the move did.

### 8.8 Coverage of the existing strategies

- **Each real-time opportunity is joined to the Phase 93 decision recorder:**
  - a strategy staged it (and the user approved, rejected, or it expired);
  - a strategy saw and blocked it (the reason);
  - **no strategy produced anything** (the main question of this revision).
- The daily and periodic reports count each class by trigger, horizon and side.

## 9. Market state

### 9.1 Benchmarks and abnormal returns

- **Sector ex-self:** the sector ETF return with the stock's own contribution removed. It is approximated by the cap-weighted return
  of the universe members of that sector excluding the stock, on the same bars.
  - Reason: AMZN is a large part of XLY, so XLY partly IS AMZN.
  - The raw ETF is shown beside it.
- **Abnormal return:** `ar = ret - beta_s x sector_ex_self - beta_m x SPY`. Betas come from the 60 sessions before, excluding the
  stock's event days.
- **Other state:** ATR % (daily, 30 min), RelVol (same time-of-day, 20 sessions), spread bps, gap %, VWAP distance, the SPY regime
  (20-day SMA, vs VWAP), VIX / VIXY, macro window, earnings in the hold, and the option ATM IV and its 20-day percentile (when
  bought).

### 9.2 Time of day, learned statistically

- **Time is a feature in 13 half-hour buckets.** Never "the stock turned at 10:14 yesterday".
- **Intraday profiles are estimated across many days** (per symbol and per sector group), with shrinkage toward the group profile:
  - the volatility by bucket;
  - the probability that a trigger succeeds by bucket;
  - the response to events by bucket.
- **A pre-declared control hypothesis** "yesterday's pivot time predicts today's" is tested and reported. A null result is expected.

## 10. Open options and P&L attribution (unchanged from revision 1)

- **Per open position, once a minute:**
  - each leg's bid, ask, quote age, IV and Greeks (with their source);
  - the spot, and DTE (calendar and trading);
  - the net natural / mid. Indicative feed, labelled.
- **Stale quotes** (> 60 s) are excluded from attribution.
- **Stock-direction result and contract result** are always separate.
- **Attribution per interval:** `delta x dS + 0.5 x gamma x dS^2 + theta x dt + vega x dIV`.
  - The REMAINDER is always shown, along with the execution cost, the fees and the assumptions (Greeks source, mid as fair value,
    indicative quotes, stale intervals).
  - A remainder over 25% of the mid change = LOW CONFIDENCE.

## 11. Continuous research process

### 11.1 Accumulation (never reset)

- **Append-only storage.** Raw data (bars, quotes, documents, VM files) is partitioned by date and never rewritten.
- **Derived tables** (moves, firings, outcomes, features, explanations) are keyed by the versions that produced them: universe, map,
  classifier, triggers, contracts, exits, vars.
  - A new version recomputes ALL history into new partitions; older results are kept.
- **The daily job (PC, after the close)** fetches and derives one more day, and catches up any missed days, idempotently.
  - A day becomes FINAL when its VM archive is merged and its option quotes are fetched; until then it is PROVISIONAL.
- **The history covers:**
  - the backfill (2018+ for stocks and news; options only where quotes are bought, excluding the reserved window, section 11.6);
  - every forward day after that.

### 11.2 The daily report = a progress view, not a verdict

Per day:
- **A move map per symbol:** UP / DOWN / REBOUND / QUIET at each scale.
- **Every trigger firing**, with its real-time result (stock, call, put) beside the hindsight and confirmation benchmarks, and the
  capture ratio.
- **Events aligned** through the exposure map, known-before vs arrived-later.
- **The "never generated by a strategy" opportunities** (8.8).
- **Data quality:** provisional days, gaps, stale quotes.
- **Running totals for every candidate and frozen proposal:**
  - for a candidate: its count of independent examples so far against the number it needs;
  - for a frozen proposal: its forward count.
  - A daily report never declares a pattern.

### 11.3 Periodic discovery run (every 4 weeks, or when the discovery pool grows by 200 independent days x symbols)

- **It runs over the whole accumulated DISCOVERY pool:** all data not reserved for testing any frozen proposal's own forward window.
- **The search space is fixed per run and logged:**
  - conditions: up to 2 predictive features (binned at tertiles fixed on the pool's first 3 months, then frozen per version);
  - x trigger;
  - x side;
  - x horizon;
  - x contract rule;
  - x exit rule.
- **For each candidate pattern, the report gives:**

  | Field | Definition |
  |---|---|
  | Entry conditions | the exact feature bins + trigger + side, all available at `t_avail` |
  | Holding period | the horizon, OR the exit rule; each horizon is its own candidate |
  | n (raw) | firings matching |
  | **n_eff (independent examples)** | distinct clusters. A cluster = one trading day for market-wide conditions, and one EPISODE for shared events. An episode = the connected group of firings linked by overlapping windows on one symbol, or by one event reaching several symbols (macro, sector, a shared news cluster): a CPI day across 130 stocks counts once. Multi-day horizons use non-overlapping holding windows. |
  | Distinct days / symbols | breadth |
  | Consistency | the share of calendar quarters and of symbols with a positive effect; the result in each chronological half |
  | Uncertainty | the after-cost mean per trade with a 95% day-block bootstrap interval; the hit rate with a Wilson interval |
  | After-cost profitability | stock (spread + slippage), call and put (NBBO fills, fees), each separately; "unavailable" without quotes |
  | Failures | EVERY matching firing that failed, listed and charted, not just the winners |
  | Benchmarks | the hindsight entry / exit / contract alongside, labelled |
  | Explanation vs prediction | the predictive evidence above; the explanatory associations listed separately |
  | Multiple testing | BH q-value across ALL candidates in the run (10% FDR) |
| Price-only vs price + events | every candidate that uses an event variable is reported against the SAME trigger / side / horizon / contract / exit with the event condition removed (P vs P+E): the paired after-cost difference with a day-block bootstrap interval. Events must ADD to price alone. |

- **A candidate is reported as "promising" only if all of these hold:**
  - n_eff >= 30 independent days (and >= 8 symbols for a cross-stock pattern, or >= 40 days for a single-stock one);
  - the after-cost interval excludes 0;
  - q <= 0.10;
  - both chronological halves have the same sign.
- Otherwise it is "insufficient" or "not supported", with the numbers shown.

### 11.4 Proposal, freeze, forward test

- **A proposal is written up from a promising candidate** as a mechanical rule in `research/proposals/<id>.md`:
  - the exact entry conditions, trigger, side;
  - the contract rule, exit rule and horizon;
  - the costs;
  - the pass criteria;
  - the required forward sample;
  - the maximum duration.
- **It is frozen by its commit.** Its forward window starts at the next session after the freeze.
- **Pass criteria are pre-stated:**
  - forward n_eff >= the stated number (default 40 independent days);
  - an after-cost mean > 0 with the day-block bootstrap lower bound > 0;
  - for a rule using event variables: better than its price-only version on the same forward data (P vs P+E, 11.3).
- **Calendar time alone is not evidence.** If the forward n_eff isn't reached within the maximum duration (default 12 months), the
  result is INCONCLUSIVE, never "passed by elapsed time".
- **Evaluating more than one frozen proposal at once** is corrected across them (Holm).
- **Proposals are final once frozen.** A failed proposal can't be edited and re-tested on the same forward data; a variant is a new
  proposal with its own freeze date.
- **A passed proposal only becomes eligible** for a separate trading-rule phase, which you approve. Research never switches anything
  on.

### 11.5 The observation period is not the holding period

- **Weeks of observation produce candidates whose holding period** can be 5 minutes, an hour, the close or several sessions.
- **Every horizon is a separate candidate**, with its own n_eff, costs and test.
- **Longer horizons overlap more, so they have fewer independent examples.** The report says so, and n_eff accounts for it.

### 11.6 Splits for the historical part (from revision 1)

| Window | Dates | Use |
|---|---|---|
| D: discovery | 2018-01-01 .. 2022-12-31 | the discovery pool |
| V: validation | 2023-01-01 .. 2025-05-31 | one run per frozen proposal, before the forward test (optional accelerator: passing V does not skip the forward test) |
| R: reserved options window | 2025-06-02 .. 2026-10-01 | stays unseen (Phase 90's pre-registered test); option quotes are NOT downloaded for it |
| Forward | from Stage 1 onward | every frozen proposal's real test; LIVE_VERIFIED news timing |

- **Episodes never straddle a boundary.** There is a 5-session embargo after each boundary.
- **Disclosed contamination:** stock bars in V were used by Phases 88 / 90 for other strategies, not for these features.

## 12. Reports and worked examples

### 12.1 Trade / opportunity card

One time axis:
- **Price:** the underlying, sector ex-self and SPY (rebased).
- **Events:** solid = known before; hollow = arrived later; x = reactive.
- **Trigger firings and entry / exit times:**
  - real-time entries are marked at `t_avail + 1 s`;
  - benchmark pivots are drawn dashed and labelled "hindsight".
- **The option's bid / ask band** (when bought or recorded).
- **The P&L path with improving / deteriorating segments.**
- **The decomposition per segment:** market, sector, peer and residual, with "no identifiable driver" allowed.
- **The peer and matched-no-event comparison.**

### 12.2 Example trade timeline (illustrative, not real data; from revision 1)

AMD bull call spread 165 / 175, 2026-10-23 expiry, paper. Entered 2026-10-06 10:42 ET.

| Time (ET) | Item | Known at entry? | Label | Underlying / option |
|---|---|---|---|---|
| Fri 10-02 07:00 | Earnings date (10-28) in the calendar snapshot | yes | LIVE_VERIFIED snapshot | outside the hold |
| 08:30 | CPI: forecast 0.3 (FF snapshot Mon 06:00), actual 0.2, surprise -0.1 | yes | SOURCE_TIMESTAMPED; SNAPSHOT_PIT | SPY +0.6% by 09:45 |
| 09:05 | Analyst upgrade to Buy, PT 185 (the 7.1 record) | yes | LIVE_VERIFIED | AMD AR +1.1% (09:30-10:00) |
| 10:42 | **ENTRY** at the natural ask $4.10 (mid $3.95) | | LEDGER | spot 166.20 |
| 10:42-12:30 | Improving segment +0.6R | | | market 40%, sector 35%, residual 25% (not abnormal): no stock-specific driver |
| 12:40 | AMD -1.8% in 20 min; SMH -0.4%; SPY flat | | | residual -1.5 ATR30, 97th percentile vs no-event days |
| 12:58 | Report: export-license review for advanced chips | no, arrived later | LIVE_VERIFIED | `t_known` AFTER the move began: candidate, not cause; "no identifiable driver at 12:40" |
| 13:10 | "Why AMD shares are trading lower" | no | REACTIVE | never a cause |
| 15:30 | Mark: net mid $3.60, natural bid $3.45 | | indicative, quote age 4 s | |
| Attribution 10:42-15:30 | Delta -0.31, Gamma +0.02, Theta -0.04, Vega -0.01, **Remainder -0.01** of a -0.35 mid change; execution cost 0.15 at entry + 0.15 if sold now | | Greeks: alpaca 92%, model 8% | |
| Stock vs contract | Underlying -0.3R (WRONG at the close, interim). Contract -$65 at natural prices | | | |

### 12.3 Worked example: AMZN, Friday 2026-10-02 (REAL data, FETCHED: SIP 1-minute bars + Alpaca news; read-only)

**Two episodes, kept separate:**

| Episode | Times (ET) | AMZN | SPY | QQQ | XLY (raw; contains AMZN) |
|---|---|---|---|---|---|
| **E1: morning decline (parent)** | 09:32 (253.30) -> 11:53 (250.07) | **-1.27%** | -0.19% | -0.06% | -0.30% |
| first leg down | 09:32 -> 09:56 | -0.87% | -0.09% | +0.10% | -0.23% |
| **E2: rebound inside E1 (child, counter-move)** | 09:56 (251.09) -> 10:20 (252.85) | **+0.70%** | +0.35% | +0.43% | +0.54% |
| second leg down | 10:20 -> 11:53 | -1.10% | -0.44% | -0.59% | -0.61% |

**What a first look shows** (explanatory, to be confirmed with betas and the ex-self sector when built):
- E1 is mostly stock-specific: AMZN fell about 1.1 points more than SPY / QQQ.
- E2 moved WITH the market and the sector: about half to three-quarters of its size matches SPY / QQQ / XLY over the same minutes.
  The residual is small, so E2 is likely to read "market-led rebound; no identifiable stock-specific driver".

**Hindsight vs real time on E2** (the 10:14 / 10:17 point, with real numbers):
- **HINDSIGHT BENCHMARK:** the 09:57 bar low 250.72 to the 10:20 bar high 252.98 = **+0.90%**.
- **Earliest causal recognition, in this illustration:** a "0.4% off the running low, on a closed bar" rule.
  - It is NOT `triggers@1` (whose T1 uses 0.5 x ATR30), and the threshold here is for illustration only.
  - It first fires on the 10:01 bar, which closes at **10:02:00**. Entry is tested at **10:02:06** at the ask, near 252.03.
- **The best possible exit after that** is the 10:20 high of 252.98, i.e. **+0.38%** before costs: a CEILING, not a result.
- **A mechanical exit** (exits@1) captures less, and is reported as the real-time result once built.

**News in the window** (pulled through the AMZN tag; under the map, mapped peers are pulled the same way whatever the price did).
Times are provider timestamps, so `PROVIDER_TIMESTAMPED` (no VM capture yet):

| `t_pub` (ET) | Gist (paraphrased) | Map relation | Classified (expected) | Known before... |
|---|---|---|---|---|
| 02:41 | FT: Amazon looking to sell about $8bn of Nvidia chips to investors | SELF + SUPPLY_CHAIN (NVDA) | CORP_ACTION / financing, tier 2, NEW | E1 and E2 |
| 06:00 | follow-up on the same chip-sale story | SELF | FOLLOW_UP (same event) | E1 and E2 |
| 06:59 | Samsung reportedly to triple HBM prices | SUPPLY_CHAIN (AI hardware) | SECTOR, tier 2 | E1 and E2 |
| 07:27 | Bloomberg: EU tech rules to bring deeper scrutiny of Microsoft and Amazon cloud | SELF + REGULATORY (EU) | LEGAL_REGULATORY, tier 2 | E1 and E2 |
| 08:44 | Broadcom's $60bn financing plan for AI customers | SEGMENT_PEER / SUPPLY_CHAIN | SECTOR, tier 2 | E1 and E2 |
| 10:20:23 | an investor commentary on cutting risk (tags AMZN, GOOGL, MSFT, NVDA, ORCL) | SELF + peers | OPINION, tier 3 | NOT before E2's top (10:20); `t_known` about 10:21:23, AFTER the second leg began: a candidate association for that leg only, never its cause |
| 10:47 | an analyst turns bullish on Cerebras (AI chips) | SUPPLY_CHAIN | ANALYST (peer), tier 2 | arrived during the second leg |
| 11:01 | "8 of 11 sectors rise" market recap | MARKET | REACTIVE / recap | never a cause |
| 11:45 | commentary warning about AI debt (Amazon, CoreWeave financing) | SELF | OPINION, tier 3, follow-up theme | after most of E1 |

**What the full build adds to this example:**
- betas and the sector ex-self split for E1 / E2;
- the residual percentile against AMZN's matched no-event mornings;
- the mapped peers' moves at the same minutes (NVDA, MSFT, GOOGL, WMT, COST, ...);
- every trigger firing in the window, with the call / put results from real NBBO (once bought);
- whether any strategy staged or blocked anything.

The pre-open items are explanatory candidates for E1. None is evidence of predictive value until a pattern built from many such
days passes 11.3 and 11.4.

## 13. Variable dictionary (additions in revision 2; revision 1's event and market variables remain)

| Variable | Store | Definition | Avail |
|---|---|---|---|
| `move_scale`, `move_type`, `parent_id`, `pivot_start/end`, `confirm_at`, `size_atr`, `dur_min` | explain | 8.1 | hindsight (`confirm_at` for the confirmation) |
| `trigger_id`, `side`, `t_fire`, `t_avail`, `entry_px` (ask) | feat | 8.2, 5 | `t_avail` |
| `fwd_ret_h`, `fwd_ar_h`, `mfe_atr_h`, `mae_atr_h`, `ttt_up/down`, `success_h` | outcome | 8.3 | never a feature |
| `contract_rule`, `contract`, `dte`, `delta_entry`, `iv_entry`, `spread_pct_entry`, `quote_age_entry`, `oi_prev` | feat | 8.5 | `t_avail` |
| `opt_pnl_net_h`, `fill_delay_s`, `unfillable` | outcome | 8.5 | never a feature |
| `bench_hindsight`, `bench_confirm`, `bench_best_contract`, `bench_best_exit`, `capture_ratio` | benchmark | 8.4-8.6 | never a feature or a result |
| `tod_bucket`, `profile_vol_bucket`, `profile_success_bucket` | feat | 9.2 (profiles estimated from the pool BEFORE the firing's date) | `t_avail` |
| `peer_shock_z`, `rs_vs_sector_z` | feat | T4 / T5 inputs | `t_avail` |
| `events_known_n`, `events_known_cat[]`, `latest_event_age` (by `map_relation`) | feat | revision-1 events with `t_known <= t_avail` | `t_avail` |
| `strategy_coverage` | explain | 8.8 | after the fact |
| `n_eff`, `cluster_id` (day / episode) | research | 11.3 | n/a |

## 14. Versioning and governance

- **The registries live in the repo; the data stays out:**
  - `research/registry/`: universes, exposure maps, classifiers (with the golden-set sha), triggers, contracts, exits, vars;
  - the hypothesis log (every candidate, every run);
  - proposals (DRAFT -> FROZEN at a commit -> V result -> FORWARD PASSED / FAILED / INCONCLUSIVE).
- **Every report row names the versions and code commit that produced it.** A new version never overwrites old rows.
- **Research never reaches the app.**
  - No research file writes settings, strategies, the ledger or the VM.
  - A test asserts that `server/` requires nothing from `tools/` or `research/`.
  - A FORWARD-PASSED proposal is only a proposal until a trading phase you approve.

## 15. Crypto reuse (later)

The adapter supplies:
- the calendar: 24/7, UTC days, intraday grid all day, and moves / triggers over the whole day;
- the benchmarks: BTC, ETH, an equal-weight top-10 basket;
- the sector map and exposure map: L1 / L2 / DeFi / exchange tokens / memes; ecosystem relations such as a chain and its tokens;
- the crypto event taxonomy: LISTING / DELISTING, HACK_EXPLOIT, TOKEN_UNLOCK, PROTOCOL_UPGRADE, REGULATORY, ETF_FLOW, STABLECOIN,
  EXCHANGE_INCIDENT, MACRO;
- the sources: Alpaca crypto news + the existing RSS feeds (no `updated_at`: versions from live capture only);
- the costs: `cost-authority` venue fees + recorded spreads; spot only, no options.

The core (observation, availability, episodes, n_eff, freeze / forward) is shared.

## 16. Staged implementation plan

Each stage gets its own plan and your approval before code. VM stages also need a separate deploy approval.

| Stage | Where | What | Done when |
|---|---|---|---|
| 0 | repo | the PR #2 accuracy fixes (**list needed**); Phase 93 deploy when you approve | fixes on the PR branch, suites green |
| 1 | VM, record-only | shared sink; news versions + poll; macro / earnings snapshots; open-option marks; status; vm-audit copies `events-*`; universe-v1 frozen | strategy outputs identical with capture on / off; a hanging fs never delays a pass |
| 2 | PC | warehouse + daily job (idempotent catch-up); backfill: IEX + SIP bars, Alpaca news, EDGAR, calendars | row counts per source / day; every row labelled; re-runs change nothing |
| 3 | PC | **exposure-map@1** (10-K segments, competitors, SIC peers, supply chain, macro / regulatory themes; cited), frozen BEFORE outcome study; classifier `evt-rules@1` + golden set | map reviewed by you; classifier precision / recall reported |
| 4 | PC | observation engine: multi-scale moves, QUIET, `triggers@1`, firings, stock outcomes, benchmarks, sector ex-self, matched controls, episodes / n_eff, strategy coverage join | the AMZN 2026-10-02 example reproduces section 12.3; synthetic tests for every rule |
| 5 | PC | daily progress report + opportunity cards | a daily report for a backfilled week + one forward day |
| 6 | PC + your purchase | ThetaData (Value $40 or Standard $80 / month); `contracts@1`, `exits@1`; call / put results; benchmarks | bought on your approval; R never downloaded |
| 7 | PC | periodic discovery run (11.3) on D (+ forward as it accrues); hypothesis log; the first proposals | proposals written; you choose which to freeze |
| 8 | PC | V run (optional) + forward evaluation of frozen proposals in the daily report | pre-stated criteria only |
| 9 | VM + PC | crypto adapter | as Stages 1-8 |

## 17. Testing

- **VM:**
  - `record()` sync / never throws; bounded queue;
  - the news tap leaves the app's handler input identical;
  - no network call inside a pass;
  - strategy outputs identical with capture on / off;
  - `server/` never requires `tools/` or `research/`.
- **PC, synthetic fixtures:**
  - zigzag nesting and REBOUND typing; QUIET; the confirmation time;
  - every trigger computed only from bars with `t_avail <= now` (a test appends future bars and expects identical firings);
  - entry never before `t_avail + 1 s`;
  - fills at the ask / bid, the stale-quote handling and NO_CONTRACT;
  - benchmarks never summed into results;
  - the as-of feature guard;
  - map-blind explanation listing;
  - n_eff for one shared event across many stocks = 1;
  - horizons kept separate;
  - the freeze / forward window boundaries;
  - INCONCLUSIVE on a time cap;
  - BH / Holm arithmetic;
  - attribution with the remainder.
- **Always:** all existing suites + `npm run check:limits`; every `.js` at or under 300 lines.

## 18. Open decisions (yours)

1. **Universe:** S&P 100 + sector / industry ETFs + the watchlist (about 135, recommended), or the S&P 500.
2. **Option quotes:** ThetaData Value ($40 / month, 1-minute fills) or Standard ($80, tick fills) while research runs. Without one,
   option opportunities stay "unavailable".
3. **The reserved option window R:** keep it unseen for Phase 90's test (recommended), or spend it here.
4. **Structured analyst ratings ($99 / month):** only if headline extraction misses > 10%.
5. **Model-based classification:** off (recommended), or on under the leakage rules.
6. **Discovery cadence and thresholds:** every 4 weeks, with n_eff >= 30 days to call a candidate promising and >= 40 forward days
   to pass. Raise them if you want stricter evidence.
7. **Confirm the Amazon example date** (assumed 2026-10-02) and **send the PR #2 accuracy-fix list.**
