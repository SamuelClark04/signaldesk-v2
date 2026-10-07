# Shadow Research System (Phase 95): Implementation Plan, revision 3 (approved for build and test on review branches, 2026-10-07)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (the working method the user chose: one
> implementer, plus an independent reviewer for every task touching the VM server, recorder, pipeline, router, quotes or news
> handler). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an automatic research and shadow-paper system.
- It observes every symbol of the frozen universe through each session.
- It replays calls and puts after the close on every opportunity: the app's accepted / rejected / expired setups AND opportunities the
  app never generated. Each is replayed under quick-exit and longer-hold rules, using only information available at each moment.
- It keeps each strategy variant in its own research book with declared capital and limits.
- It explains moves (company, competitors, sector, market, or "no identifiable driver").
- It runs a frozen discovery and forward-test protocol.

It runs unattended: no approval per observation or research trade, and no manual archive downloads.

**Architecture:**
- **VM (always on, record-only):** a separate, low-priority `signaldesk-research` process records what cannot be fetched later:
  - option quotes for every contract a rule could select, tracked to expiry;
  - news with our receipt time;
  - the calendar snapshots.

  An exporter uploads closed files to a private Google Cloud Storage bucket.
- **PC (on once a day after the close; never needed in market hours):** a scheduled job pulls the files, fetches stock bars, and runs
  the replay engine into a separate research ledger (SQLite). It builds explanations, features and reports, and runs the frozen
  discovery / forward-test protocol.
- **The trading app keeps every broker-trading control unchanged.** Nothing here can place, approve or change a trade.

**Tech stack:**
- Node 20 on the VM; Node >= 22.5 on the PC, for `node:sqlite`. It is experimental: the PC tools check the version at startup, and the
  fallback is JSONL tables with an index file.
- Alpaca market data (data keys only), Finnhub (free), Forex Factory, Wikipedia (pinned revisions; application User-Agent).
- Google Cloud Storage JSON API (service-account keys).
- Windows Task Scheduler.

**Spec:** `docs/superpowers/specs/2026-10-05-event-research-layer-design.md` revision 3. This plan supersedes:
- its section 16 stage order from Stage 2 on;
- its manual weekly-archive workflow.

It keeps the spec's exposure map (3.2), time availability (5), variables (6, 13), observation layer (8), market state (9) and
continuous research process (11). Task 9.1 amends the spec to match. Stages 0-1 are deployed (`7bfad9c`); the universe is
`research/universe/universe-v1.json` (`d8e89e5`).

---

## 1. What needs your approval, and what never does

**Never needs approval:** an observation, a replayed (research) trade, a discovery run, a freeze, a forward-test verdict. The system
runs, records and reports them automatically.

**Stays separately controlled (each is its own approval):**
- any broker-trading change (a rule, an approval path, automation, exits);
- every deployment to the VM;
- creating any cloud resource (the bucket, projects, service accounts, keys, billing automation): Task 0.3 only writes the runbook;
- any data purchase or paid plan;
- any universe expansion (beyond universe-v1, AND the VM collector widening from the 24-symbol pilot to universe-v1);
- merging into `main`;
- promoting a research result into the trading app.

**Approving this plan approves:** implementation on review branches, tests, and harness runs (approved 2026-10-07).

**Reporting:** each completed component is reported with its tests (failing before, passing after) and a reviewable example (a
fixture run, a sample record or a rendered report).

**Defaults (yours to change at review):**

| # | Default | Section |
|---|---|---|
| D1 | Transfer through a private GCS bucket in a SEPARATE Google Cloud project (so a billing stop there can never stop the VM) | 9 |
| D2 | Option prices from the free indicative feed, labelled INDICATIVE. A re-probe of free 15-min-delayed OPRA first (Task 0.2); no purchase. | 5 |
| D4 | The quick-exit grid: 1 contract; net +$20 / +$40 / +$60 / +$80; net stop -$40; time stop 30 / 60 min; flat 15:50 ET | 6.4 |
| D5 | Daily report: local HTML. Email to your own address OFF until you switch it on. | 10.5 |
| D6 | The Moonshot radar stall (about 44 s every pass, 2026-10-07) is fixed, under its own approval, before any VM collector deployment | Task 0.1 |
| D7 | Research books: $10,000 declared capital each; limits in 6.6 | 6.6 |

## 2. Global constraints

- **Separation:**
  - VM collector code never imports `server/execution/*`, `server/risk/*` or any broker connector. It never reads broker keys, never
    writes `ledger-state.json`, and never messages the trading server.
  - PC research code loads only the Alpaca DATA keys and the GCS read key, and never calls a trading endpoint.
  - Both are enforced by static import tests.
- **Information available at the time (spec 5, 8.7):** every predictive value and every replayed entry / hold / exit decision at time t
  uses only:
  - bars that ENDED at or before t;
  - news with our receipt time `t_recv` at or before t;
  - option quotes with a provider time at or before t;
  - snapshots captured at or before t;
  - map / classifier / feature versions committed before the session.

  One as-of accessor serves all `feat_*` reads and refuses later values; a perturbation test checks it (Task 5.6).
- **Two stores (spec 8.7):** explanations (`explain_*`) may use the whole move window; predictive features (`feat_*`) may not.
  Explanations never support a rule by themselves.
- **Holdout:** the Phase 90 option window (2025-06-02 .. 2026-10-01) stays unseen. Option replays use quotes recorded forward from the
  collector's start.
- **Statistics:** the frozen protocol of section 8 (30 / 40 independent-example minimums; counts never pass alone; correction within
  AND across repeated searches; failed candidates kept).
- **No purchases;** no paid ratings; LLM classification off; EDGAR deferred until you designate a contact address.
- **Requests:** keys in headers; application User-Agent; never your email.
- **Repo rules:** <= 300 lines per file; `npm run check:limits`; scratch dirs, dead URLs and fake fetches in tests.

## 3. The workflow, end to end

```
 VM (e2-micro, always on, record-only)           GCS (separate project)        PC (once a day after the close + on wake)
 signaldesk (trading server; controls unchanged)
   decision recorder -> decisions-*.jsonl ---+
   news stream tap   -> events-srv-*.jsonl --+
 signaldesk-research (nice 10)               |   raw/<kind>/<date>/*.gz       1 pull + verify sha256 (download cap)
   contract grid + pinned contracts -> optq -+-> manifest/<date>.json ------> 2 SIP 1-min bars (> 15 min old)
   news poll (universe) -> events-*.jsonl ---+   lifecycle 21 days            3 ingest -> research.sqlite (idempotent)
   earnings / macro snapshots ---------------+                                4 observe: moves, explanations, triggers
   heartbeat (load, API use, bytes) ---------+                                5 REPLAY: dedup -> books -> fills -> exits
   exporter: hourly, closed files, capped                                     6 features as-of; labels
                                                                              7 forward test of frozen proposals (daily)
                                                                              8 discovery (every 4 weeks, frozen protocol)
                                                                              9 reports + health
```

## 4. Two kinds of research result: REPLAY and LIVE_PAPER

| Mode | What it is | Where it comes from | Claim it supports |
|---|---|---|---|
| `REPLAY` | an entry / hold / exit decided AFTER the close by the PC, at each simulated moment, from the data available at that moment, with a declared decision latency | the shadow engine (section 6) | "this rule, applied with the information then available, would have produced these fills on the observed quotes" |
| `LIVE_PAPER` | a decision actually taken in real time: today, only the app's own paper trades (the setups you approve), from the decision recorder and the ledger | the trading app (unchanged) | "this happened in real time", with real decision latency |

- Every record carries its mode. Reports show the two separately and never add them together.
- A replayed result is never described as a live decision.
- A future live shadow runner for passed proposals (real-time decisions, no orders) is out of this plan. It would be a separate
  deployment approval.

## 5. Option data

### 5.1 Requirements per use

| Use | Needs | Sampling |
|---|---|---|
| Quick (Q) and same-day hold (H) rules | the contract's bid / ask at every sample from entry until the exit | 60 s, Q grid |
| Multi-day (D) and multi-week (W) holds | the contract's bid / ask through exit or expiry, even far from the money | 10 min (5 min if the measured budget allows) |
| Contract selection at entry | the CANDIDATE contracts of the latest re-centre at or before the entry | every 30 min |
| Explanation / features | IV, spread %, quote age | from the samples |
| Calibration of indicative quotes | real (delayed) OPRA trade prints of the same contracts | daily, a sample, if Task 0.2 shows recent trade bars are served |

### 5.2 The contract set (recorded live: Alpaca has no historical option quotes, HTTP 404)

- **Underlyings:** the OPTIONABLE symbols of the ACTIVE capture list.
  - Pilot: the 24 symbols.
  - universe-v1 (about 120 optionable of 128) only after the separate expansion approval (section 11).
- **Q bucket (same-day rules only):**
  - the nearest expiry with 1-7 DTE (daily expiries for SPY / QQQ / IWM; never 0DTE);
  - the 3 nearest strikes each side, calls and puts;
  - kept through the session's close (Q and H positions never span a night).
- **D / W buckets (multi-day rules), standard monthly expiries only** (third-Friday cycle), so the tracked expiries stay few:
  - D = the nearest monthly with >= 14 DTE;
  - W = the following monthly (>= 42 DTE);
  - up to 6 strikes each side within +/-8% of the spot, calls and puts.
- **Candidates and pinning:**
  - At every re-centre (30 min), the collector writes a CANDIDATES line: per underlying, bucket and side, the contract closest to 0.50
    delta (nearest the money if there are no greeks).
  - Every candidate is PINNED: sampled until it expires, wherever the spot goes.
  - The replay selects its contract ONLY from the CANDIDATES line in force at entry, so **every contract a replayed trade can hold is
    tracked through its exit or expiry**.
  - Non-pinned grid contracts may be dropped beyond 20% from the spot.
- **Request budget (to be MEASURED in Task 1.5 before any widening):**
  - Estimate at universe-v1: Q about 15 calls/min, D / W at 10 min about 13 calls/min, re-centring about 4 calls/min: about 32/min.
  - Alpaca allows 200 / min per account, SHARED with the trading server and the PC job.
  - The collector holds itself to a ceiling set from the measurement (default 40 / min). It pauses 2 min on any 429.
- **Each row:**
  - the contract;
  - bid, ask and their sizes;
  - the provider quote time and our receipt time;
  - the underlying price;
  - IV / greeks if provided;
  - `feed` (INDICATIVE / OPRA);
  - `pinned`.

### 5.3 Two kinds of price: never mixed

| Label | Source | Use |
|---|---|---|
| `MARKET_QUOTE` | real NBBO quotes: OPRA (delayed or real-time), only if Task 0.2 finds it available free, or after a separately approved purchase | can support a VALIDATED verdict |
| `INDICATIVE_ESTIMATE` | the free plan's approximated quotes ("not for live trading or strategy validation", per Alpaca) | estimates only: never VALIDATED |

- They are separate research books and separate report sections. Their results are never summed, averaged together or compared as if
  equivalent.
- Calibration (indicative mid vs delayed trade prints) is reported as a measurement. It never converts one label into the other.

### 5.4 Better data later (not purchased)

The options and tiers are in spec section 4: Alpaca Algo Trader Plus for real-time OPRA; ThetaData, Massive or Databento for
historical NBBO. A purchase is a separate approval. Only `feed` changes; the engine and the books stay the same.

## 6. The replay engine

### 6.1 Opportunities

| Source | What |
|---|---|
| APP | every decision-recorder setup: STAGED, approved, user-rejected, EXPIRED, refused at approval, strategy block, pipeline rejection (one per decision id, by the C1-B decision rule) |
| TRIGGER (`triggers@1`, spec 8.2, frozen before any outcome is computed) | on every captured symbol each minute: opening-range break up / down (5 / 15 / 30 min); VWAP reclaim / loss; a move >= 1.5 x ATR(14, 1-min) in 15 min; a rebound >= 50% of a >= 2 x ATR drop; a gap >= 1% held / filled by 10:00; the first news receipt for the symbol (by `t_recv`); a sector-ETF or mapped-peer move >= 1% with the stock lagging; a 30-min range compression then expansion |
| CONTROL | every captured symbol at 10:00, 11:30 and 14:00: the baseline any trigger must beat |

**Time of an opportunity (`t_avail`):**
- APP: the recorded decision time.
- TRIGGER: the END of the bar that completes the condition.
- CONTROL: the clock time.

### 6.2 Deduplication

Deduplication removes only REPEATED RECORDS of the same opportunity; it never merges different opportunities.

- **Identity of an opportunity (one per key):**
  - APP: the decision id (the C1-B decision rule picks its decision record).
  - TRIGGER: symbol + trigger id + direction + the bar end that completed the condition.
  - CONTROL: symbol + scheduled time.
- **Repeated records of the same key are merged, never dropped:** REPEATS lines, re-detections of the same firing, the lifecycle
  events of one decision id. The opportunity keeps every source record and its full decision history (STAGED, approvals, user
  rejection, expiry ...) with their times.
- **Distinct opportunities stay separate, even within 15 min:** different triggers, opposite directions, a decline and a later
  rebound, an APP decision and a TRIGGER firing at the same moment. Related opportunities are LINKED (`relatedIds`: same symbol within
  15 min) for the reports. They share an episode for the statistics (`n_eff`), so linking never inflates the independent count.
- **No double position:** a book holds at most one open position per symbol (6.6). A second linked opportunity in the same book while
  one is open is recorded as skipped with reason `PER_SYMBOL` (6.6), never entered twice.
- **Same event across symbols:** firings of several symbols caused by one shared event (spec 6 event grouping) stay separate
  opportunities but form ONE episode.

### 6.3 Entry: the first eligible observed quote

- **Decision and order:** the decision is made at `t_avail`. The order time is `t_avail + L`, where L = 5 s, the declared processing
  latency.
- **Contract:** ONLY the selection recorded BEFORE the decision: the latest CANDIDATES line whose recorded time is <= `t_avail`
  (5.2):
  - Q / H rules: the Q bucket;
  - D rules: the D bucket;
  - W rules: the W bucket.

  The trade keeps the selection's timestamp, its eligibility facts (bucket, DTE, delta or the nearest-the-money fallback, strike) and
  its quote coverage (samples from the selection to the exit, gaps).

  **A contract from a LATER refresh is never substituted.** When the recorded selection cannot be used, the trade is not entered and
  the reason is recorded:
  - no CANDIDATES line before `t_avail` (e.g. the collector had just started): `NO_SELECTION`;
  - its expiry is too short for the rule: `INSUFFICIENT_EXPIRY`;
  - no eligible quote in time: `UNFILLED`.
- **Eligible quote:** provider time >= the order time; bid > 0; ask > bid; spread <= 50% of the mid.
- **Fill:** at the ASK of the first eligible observed quote.
- **No fill:** none within 2 min (Q / H) or 15 min (D / W) means `UNFILLED`. It is counted, never dropped.
- **Recorded:** the entry latency (fill quote time - `t_avail`).

### 6.4 Exits: no fills between snapshots

- **Exit condition:** evaluated ONLY at observed quotes. Net P/L = (bid x 100) - the entry debit - fees, on each observed quote.
- **Trigger:** the first observed quote where the target, the stop or a time condition is met.
- **Fill:** at the BID of the first eligible observed quote with provider time >= the trigger quote time + L, i.e. the NEXT observed
  quote. Never at the threshold, and never at a price between snapshots.
- **Recorded per exit:**
  - the trigger quote and the fill quote;
  - the gap (seconds between them);
  - the slippage against the threshold;
  - for stops, the **loss beyond the stop threshold** in $.
- **Reported:** the distributions of latency, gaps and losses beyond the stop, per book.
- **Quote gaps:**
  - No eligible quote for a pending exit within its maximum age: the exit waits (`EXIT_DELAYED`, with the delay) and fills at the
    next eligible quote.
  - Quotes end for an unpinned reason (provider gap, VM down): the exit waits for the first eligible quote after the gap and is
    labelled `GAP_EXIT`.
- **Rule families (frozen as `exits@1` in Task 5.4):**
  - **Q (D4):** net target +$20 / +$40 / +$60 / +$80 x time stop 30 / 60 min, net stop -$40, flat at 15:50 ET. That is 8 rules.
  - **H:** exit 2 h after entry, or at 15:50 the same day. Stop at -50% of the premium.
  - **D:** exit at the close of session +1 / +3 / +5. Stop at -50%.
  - **W:** exit at the close of session +10 / +20. Stop at -50%.
- **Switch policies (quick -> hold):** at the observed quote where a Q target triggers, a FROZEN policy (from section 8) may keep the
  position under an H / D / W rule. It may use only `feat_*` values as of that quote.
  - A switch policy is its own book. Its baseline is the same trades exiting at Q.
  - The D / W rule's expiry requirements (6.5) are checked at the switch moment.

### 6.5 Expiry handling

- **Sufficient expiry at entry:**
  - A D or W rule is entered only if the contract's expiry is at least 5 sessions after the rule's PLANNED exit date.
  - Otherwise the trade is `INSUFFICIENT_EXPIRY`: counted, not entered.
  - Q / H never hold overnight.
- **Close at 2 DTE:** any D / W position still open at 2 DTE exits at the first eligible quote from 10:00 ET (`EXPIRY_EXIT`). Nothing is
  held into expiry; exercise and assignment are never modelled.
- **Missing quotes:** a pinned contract with no quote for a whole session (halt, provider gap) stays open, labelled `QUOTE_GAP`. A
  contract that stops existing (delisted, adjusted) is closed at its last quote as `QUOTES_ENDED`. Both are excluded from pass
  criteria and listed.
- **Corporate actions:** an adjusted contract (a changed deliverable) is labelled `ADJUSTED` and excluded.

### 6.6 Research books (strategy variants never pooled)

- **What a book is:** one book = one (opportunity filter) x (exit rule or switch policy) x (price label: MARKET_QUOTE or
  INDICATIVE_ESTIMATE).
- **Defaults per book (D7):**

  | Limit | Default |
  |---|---|
  | Declared capital | $10,000 |
  | Size | 1 contract |
  | Concurrent positions | max 3 (Q / H books); max 5 (D / W books) |
  | Per symbol | max 1 open |
  | Entries per day | max 10 |
  | Daily loss stop | -$300; then no new entries that day |
  | Debit | the entry debit must fit the cash left (capital minus the debits open) |

- **Every opportunity is recorded in every book it qualifies for, entered or not.** Each (opportunity, book) pair gets a BOOK ENTRY
  record:
  - status `ENTERED` (with its trade), or `SKIPPED` with exactly one reason: `CAPITAL` (the debit exceeds the cash left), `CONCURRENCY`,
    `PER_SYMBOL`, `DAILY_ENTRIES`, `DAILY_LOSS`, `NO_SELECTION`, `INSUFFICIENT_EXPIRY`, `UNFILLED`;
  - with the book's state at that moment (cash left, positions open, entries today, P/L today).
- **Order:** entries are decided in `t_avail` order (ties by symbol, then opportunity id).
- **The unconstrained per-opportunity outcome is still computed for skipped opportunities** (as if entered) and reported next to the
  book's constrained results, never replacing them.
- **Competing exits on the same opportunity are different books.** They are compared side by side and never added together as
  portfolio profit.
- **Each book reports:** equity curve, drawdown, return on declared capital, trades / skips / unfilled, and wins AND losses listed.

### 6.7 Every research trade keeps

- **Identity:** mode (REPLAY / LIVE_PAPER), book, opportunity id, tags, episode.
- **Contract and fills:** the contract and its bucket; the entry and exit trigger / fill quotes; the latencies and gaps.
- **Results:** net $ (normal + stressed: fills 10% of the spread worse), the loss beyond the stop, MFE / MAE.
- **Selection:** the CANDIDATES line used (its time, eligibility facts, quote coverage).
- **Labels and inputs:** the labels (EXIT_DELAYED, GAP_EXIT, QUOTE_GAP, QUOTES_ENDED, ADJUSTED, EXPIRY_EXIT), the `feat_*` snapshot id,
  the input file hashes. Skips are BOOK ENTRY records with their reason (6.6).

**Costs:** commission $0; regulatory / clearing fees assumed at $0.05 per contract per side (labelled as an assumption).

## 7. Explanation, company map, events and variables

### 7.1 `exposure-map@1` (spec 3.2; frozen BEFORE any outcome is examined)

Built WITHOUT EDGAR (deferred), each entry with a source citation and a date:

| Relation | Source for @1 |
|---|---|
| SECTOR / SUB-INDUSTRY | GICS sector and sub-industry from the pinned Wikipedia "S&P 100" and "List of S&P 500 companies" revisions (secondary sources, labelled) |
| SECTOR_ETF (ex-self) | the SPDR sector ETF + industry ETFs (SMH, KRE, XBI, XRT, IYT); ex-self weights where the issuer's published holdings give them |
| COMPETITOR / SEGMENT peers | a curated list per company, each pair cited to a public source (company investor materials, the issuer's segment descriptions). Marked `CURATED`. |
| SUPPLY CHAIN | curated with citations, marked `CURATED`; sparse in @1 |
| MACRO / REGULATORY themes | the fixed tables of spec 3.2 |

- **One-time review:** you review the map once before it is frozen (spec 3.2). This is a one-off quality step, not a per-observation
  approval.
- **Later versions:** EDGAR 10-K segments, competition sections and SIC peers become `exposure-map@2` once you designate a contact
  address. Each version applies only to data after its commit.
- **Coverage gaps:** large residual moves preceded by an unmapped event are counted and proposed as edits, applied forward only.

### 7.2 Events: `evt-rules@1` (spec 6)

- **Documents:** grouped into events. `t_known` per field; REACTIVE detection.
- **Variables:** every event gets every variable in the dictionary; an undecidable field is `UNKNOWN` / `AMBIGUOUS` /
  `NOT_APPLICABLE`, with a confidence.
- **Rules only:** model-based classification stays off.
- **Quality:** measured once on a 300-document stratified set, labelled with your one-time review BEFORE the rules are tuned (spec 6).
  Categories below 0.7 precision are marked "low confidence" everywhere.

### 7.3 Moves and explanations (spec 8.1, 8.7, 9.1)

- **Moves:** every rise, drop, rebound and quiet period per symbol at 5 / 15 / 60 min and 1 / 5 / 20-session scales, with start, peak,
  reversal and duration.
- **Decomposition of each move:** market part (`beta_m x SPY`), sector ex-self part, mapped-peer part, residual.
- **Candidate drivers listed for each move:** every mapped event in the window, whatever the move did (map-blind), with its `t_known`
  relative to the move start, REACTIVE flags and `map_relation` (SELF, SEGMENT_PEER, SUPPLY_CHAIN, SECTOR, MACRO, REGULATORY, NONE).
- **Verdict per move:**
  - `ASSOCIATED_EVENT` (a non-reactive mapped event known before the residual move started; the residual beyond its 90th
    percentile);
  - `MARKET` / `SECTOR` / `PEER` (the decomposition explains >= 70% of the move);
  - `NO_IDENTIFIABLE_DRIVER` (none of the above).
- **Reports:** the counts of each verdict, and examples of each, including the `NO_IDENTIFIABLE_DRIVER` moves. Every verdict reads as
  an association, never a cause.

### 7.4 Predictive variables (`feat_*`, spec 13; available at `t_avail` only)

- **News / events:** category, novelty, scope, scheduled, REACTIVE, surprise (point-in-time only), recency by `t_recv`, `map_relation`.
- **Peers / sector:** sector ex-self and mapped-peer moves (15 / 60 min, day); relative strength.
- **Market:** SPY vs VWAP and 20-day trend; VIXY change; universe breadth.
- **Stock:** gap, ATR, relative volume, time of day, distance from VWAP / opening range.
- **Option:** IV and its 20-session percentile from recorded quotes; spread %; DTE; quote age.

## 8. The frozen discovery and forward-test protocol

`docs/research/phase95-protocol.md` is written and committed (hash recorded) BEFORE the first discovery run (Task 7.0). It fixes the
following.

### 8.1 Cadence and pool

- Discovery runs every 4 weeks, or when the discovery pool grows by 200 independent symbol-days (spec 11.3; decision 6).
- The pool is all data not reserved as any frozen proposal's forward window.

### 8.2 Search space per run

- Up to 2 predictive features, binned at tertiles fixed on the pool's first 3 months, then frozen per version.
- Crossed with: trigger / opportunity filter, side, contract bucket, exit rule or switch policy.
- The list of candidates is written and hashed BEFORE any outcome is read.

### 8.3 Independence

- `n_eff` = distinct clusters: one trading day for market-wide conditions; one EPISODE for shared events (spec 11.3).
- >= 30 to propose (+ >= 8 symbols cross-stock, or >= 40 days for a single stock); >= 40 forward.

### 8.4 Promising (all required)

- the after-cost mean with a 95% day-block bootstrap interval excluding 0;
- the stressed-cost mean > 0;
- both chronological halves with the same sign;
- better than CONTROL opportunities on the same exits;
- for event-using candidates, better than the price-only version (P vs P+E, paired);
- the multiple-testing rule (8.5) passed.

Counts alone never pass.

### 8.5 Correction within AND across repeated searches

These rules are exact and fixed now. Task 7.0 copies them unchanged into the protocol file, which is committed and hashed before the
first evaluation; any later change is a new protocol version that applies only to runs after its commit.

**The p-value (every candidate and every forward test):**
- one-sided test of H0 "after-cost mean net $ per trade <= 0";
- a day-block bootstrap: all trades of one trading day resampled together;
- B = 10,000 resamples; seed = the first 8 bytes of the candidate's sha256;
- centred statistic: p = (1 + #{b : m*_b - m_hat >= m_hat}) / (B + 1).

**Discovery runs: a decreasing error budget, spent run by run.**
- Runs are numbered k = 1, 2, 3 ... from the protocol's first run. They are never reset, and runs with no candidates still count.
- Run k gets level alpha_k = 0.10 x 6 / (pi^2 x k^2):

  | k | 1 | 2 | 3 | 4 | 5 | 6 |
  |---|---|---|---|---|---|---|
  | alpha_k | 0.0608 | 0.0152 | 0.00675 | 0.00380 | 0.00243 | 0.00169 |

  The sum over all runs is <= 0.10.
- **Within run k: Benjamini-Hochberg at alpha_k** over ALL m_k candidates of the run's hashed list.
  - Candidates below the `n_eff` minimum count in m_k with p = 1.
  - A candidate re-tested on a grown pool is a new hypothesis in its run.
- **Guarantee:** the false-discovery proportion is V / R = sum_k V_k / R <= sum_k V_k / R_k. So the expected FDR over all runs ever is
  <= sum_k alpha_k <= 0.10, given BH's validity within a run.
  - BH needs positive regression dependence, which overlapping trades plausibly have.
  - The report adds a Benjamini-Yekutieli column (valid under any dependence) as a sensitivity check. It is not the decision rule.
- A candidate is "promising" only if it is rejected by BH at alpha_k AND meets every condition of 8.4.

**Forward tests: one look each, Bonferroni within a family, the budget spent across families.**
- The proposals frozen from run k form family F_k; |F_k| is fixed at freeze time.
- Each proposal has ONE look, when its forward `n_eff` reaches 40. Interim numbers are shown as "interim, not a verdict" and never
  decide.
- **PASS** requires all of:
  - p_fwd <= beta_k / |F_k|, where beta_k = 0.05 x 6 / (pi^2 x k^2) (family-wise error over all forward verdicts ever <= 0.05);
  - the stressed-cost mean > 0;
  - both forward halves > 0;
  - for event-using rules, better than the price-only version on the same forward data.
- **INCONCLUSIVE:** below 40 after 12 months. It never passes by elapsed time.
- **Switch policies (quick -> hold)** are candidates and proposals like any other, under the same rules.

### 8.6 Proposal, freeze, forward

- Each promising candidate becomes `research/proposals/<id>.json`, written once (`wx`, sha256): the exact rule, book, limits, costs,
  pass criteria and maximum duration. It is frozen automatically.
- Its forward window starts at the next session. Nothing is tuned after freezing.

### 8.7 Verdicts

- **PASSED-INDICATIVE:** passed on INDICATIVE_ESTIMATE prices; NOT validated.
- **VALIDATED:** passed on MARKET_QUOTE prices.
- **FAILED.**
- **INCONCLUSIVE.**

### 8.8 Failed candidates are kept

- Every tested candidate and every failed proposal stays in the registry with its numbers and reason.
- It is listed in the discovery report and never re-proposed unchanged. A variant is a new candidate counted in the family.

### 8.9 Promotion

A VALIDATED proposal is reported as eligible for a separate trading-rule phase. Changing the app needs your approval.

## 9. Transfer, retention and cost controls

### 9.1 Transfer

- **Exporter (VM, hourly at :05):**
  - uploads CLOSED files matching a whitelist (`optq-*`, `events-*`, `events-srv-*`, `decisions-*`, `heartbeat-*`), gzip, sha256;
  - writes the per-date manifest last;
  - its key can only CREATE objects;
  - NEVER uploads logs, `.env`, the vault, the ledger or pm2 output (the pm2 log can contain your LAN access link with its token).
- **Puller (PC):** lists the manifests, downloads only new objects, verifies sha256 (re-fetches once, then reports), and is idempotent
  and resumable. Its key can only READ.

### 9.2 Retention

| Where | Kept | Why |
|---|---|---|
| VM local files | 30 days | the backstop when the PC or the transfer is down |
| GCS bucket | 21 days (lifecycle rule) | covers PC downtime; deletes automatically |
| PC raw files (gz) | permanent | the system of record; about 0.3 GB a month at universe-v1 (measured in Task 1.5) |
| PC research ledger | permanent + 8 weekly backups | the research books and the registry |
| Reports | permanent (local) | the history |

### 9.3 PC downtime recovery

- **No market-hours requirement.**
- **Daily reports:** the PC is on once a day after 17:15 ET for one run (estimated 20-60 min; measured and written into the runbook).
- **Off for up to 21 days:** the next run pulls everything still in the bucket and processes the sessions in order. Multi-day holds
  complete as later sessions arrive. Nothing is lost.
- **Off for 21-30 days:** the bucket has deleted the oldest days; the VM still has them. `vm-audit.sh --research <from-date>` +
  `tools/research/import-archive.js` (Task 2.4) recovers them, as a manual step that the report asks for by date.
- **Off for more than 30 days:** those days are lost. They are reported as missing sessions; never imputed.

### 9.4 Cost controls: a budget alert is NOT a spending cap

- **A Google budget alert only sends a notification;** it does not stop spending. The controls that actually limit cost:
  1. **A separate Google Cloud project for the bucket only:** a billing problem there can never stop the VM.
  2. **The Always Free region** us-central1. The free tier, per Google: 5 GB-months of standard storage in US regions; 5,000 Class A and
     50,000 Class B operations a month; network egress from North America. Verify in the console at setup (Task 0.3).
  3. **The lifecycle rule** (21 days) bounds the stored volume.
  4. **Hard caps in our code:**
     - the exporter refuses to upload more than 150 MB or 300 objects a day (the data waits on the VM; the heartbeat and report say
       so);
     - the puller refuses more than 1 GB or 2,000 objects a run.
  5. **Optional true cap:** Google's documented "disable billing with budget notifications" automation (budget -> Pub/Sub -> function
     that removes the billing account). Safe only BECAUSE the bucket is in its own project. Off unless you choose it.
- **Expected usage at universe-v1** (to be replaced by Task 1.5 measurements): about 15 MB / day compressed, about 0.3 GB stored,
  about 1,500 uploads / month, about 0.3 GB / month downloaded.
- **Alpaca:** the free plan, no purchase. The shared 200 / min limit is managed in 9.5.

### 9.5 Shared API usage

- **Server:** the trading server's data requests per minute are counted by host / endpoint in its STATUS line. This is a record-only
  counter in `net-guard`. **[server change: reviewer]**
- **Collector and PC:** each records its own counts.
- **Rule:** the collector's ceiling = min(40, 200 - the server's measured p99 per minute - 20 margin). The PC job runs after the close
  at <= 60 / min.

## 10. Unattended operation

### 10.1 VM process

- `signaldesk-research` is its own pm2 app (`nice -n 10`, `max_memory_restart 200M`, starts on boot).
- A crash never touches the trading process. The trading server's own news poll is switched off by `EVENTS_NEWS_POLL=off` once the
  collector polls; its stream tap stays.

### 10.2 Heartbeat (every 5 min)

- the collector's CPU / RSS;
- requests / min and 429s;
- grid and pinned counts;
- bytes written today;
- the export backlog;
- the server's last STATUS.

### 10.3 Gaps

NEWS_GAP and QUOTE_GAP are recorded with from / to and their reason.

### 10.4 PC scheduler

- A Task Scheduler entry `SignalDesk Research`, installed by a script you run once (Task 8.3):
  - 17:30 ET weekdays, plus at logon and on wake;
  - "run as soon as possible after a missed start";
  - "wake to run" on;
  - stop after 3 h.
- A lock file prevents two runs. Every stage is idempotent and keyed by session and input hashes; a crashed run resumes.

### 10.5 Reports

- **Daily:** `reports/research/daily-<date>.html` + `status.json` (git-ignored):
  - health (coverage, gaps, transfer, load, API use, bytes);
  - REPLAY books by price label, successes AND failures;
  - LIVE_PAPER separately;
  - the deduplicated opportunity counts by source (APP accepted / rejected / expired, TRIGGER, CONTROL);
  - move explanations, including NO_IDENTIFIABLE_DRIVER;
  - forward tests (interim);
  - latency, gaps and losses beyond the stop.
- **Discovery report (every 4 weeks):** the candidates, the corrections, the frozen proposals, every failure.
- **Optional email (D5):** a status summary only.

### 10.6 Recovery matrix (each row is a test or a drill in Task 8.5)

| Failure | Result | Visible as |
|---|---|---|
| Trading server restart | the collector is unaffected; the tap gap is recorded | NEWS_GAP |
| Collector crash | pm2 restart; the grid is rebuilt; pinned contracts restored from the last CANDIDATES lines | QUOTE_GAP |
| VM down | that period has no quotes: entries UNFILLED, exits GAP_EXIT after it | missing sessions |
| Upload failure / a cap reached | files wait on the VM, sent oldest first | export backlog |
| PC off <= 21 days | full catch-up | "processed through" |
| PC off 21-30 days | manual archive recovery, listed by date | report |
| PC run crash | resumes at the first unfinished stage | run log |
| Alpaca 429 / outage | VM: a 2-min pause + a gap. PC: retry next run | QUOTE_GAP / bars status |
| A partial manifest | that session waits | "waiting for data" |
| A schema change | a versioned reader; an unknown version stops that file with a clear error | run log |

## 11. Measurements required before any universe expansion (the request for your separate approval)

The expansion request (pilot 24 -> universe-v1 on the VM) needs BOTH of the following:

1. **The original pilot requirement, unchanged:** at least 10 healthy pilot sessions, with the last 10 consecutive sessions all healthy
   (`inspect.js`, spec 3.1).
2. **In addition, the load measurements:** from >= 5 sessions on the VM at pilot size WITH the collector running. Each is extrapolated
   to universe-v1 with its assumption stated. These supplement requirement 1 and never replace it:

| Measure | Limit for the request |
|---|---|
| Trading server event-loop p99 / CPU p95 with the collector running | within 20% of its pre-collector baseline (after the D6 fix) |
| Collector CPU p95 / RSS max | <= 15% of one vCPU / <= 150 MB |
| Alpaca requests / min, server + collector p99 | <= 120 (60% of 200) at universe-v1 scale |
| 429s | none attributable to the collector |
| Compressed bytes / day and objects / day | measured; projected within the 9.4 caps and the free tier |

`inspect.js` prints these as one "expansion readiness" table. The decision is yours.

## 12. Tasks and acceptance criteria

Each task follows the TDD cycle:
1. write the listed tests;
2. watch them fail;
3. implement;
4. watch them pass;
5. check the limits;
6. commit on the review branch.

A `[reviewer]` mark = an independent review before the next task.

### M0: prerequisites

- [ ] **Task 0.1 (its own approval; already flagged as a task chip): the Moonshot radar stall.**
  - **Accept:** < 5 "pass exceeded 45 s" lines in one full VM session (it was 195 of 400).
- [ ] **Task 0.2: entitlement re-probe** (`scripts/research/entitlements.js`). Probes:
  - (a) the `feed=opra` snapshot of a quote > 15 min old;
  - (b) recent option trade bars;
  - (c) the maximum symbols per `snapshots?symbols=`;
  - (d) the chain endpoint filters.
  - Results go into `docs/research/phase94-entitlements.md`. If (a) asks for an agreement, report what Alpaca asks and whether it costs
    anything; you accept or decline it yourself.
  - **Accept:** each status and its meaning in the doc.
- [ ] **Task 0.3: bucket runbook** (`docs/deploy/phase95-research-runbook.md`; you perform the setup):
  - a separate project, the bucket in us-central1, two service accounts (creator / viewer, bucket-scoped), keys outside the repo
    (git-ignored), the lifecycle rule, the budget alert, the optional billing-disable automation.
  - `scripts/research/gcs-check.js` prints "writer: can create, cannot read" / "reader: can read, cannot create", never a key.
  - **Accept:** both checks pass on their machines.

### M1: VM collector `[reviewer on every task]`

- [ ] **Task 1.1: skeleton** (`server/research/collector/main.js`, `budget.js`, `heartbeat.js`).
  - Tests (`tests/ph95collector.js`): the import guard; the heartbeat fields of 10.2; the limiter ceiling and the 2-min pause; SIGTERM
    exit within 5 s.
  - **Accept:** a 15-min harness run next to the trading server keeps the server's loop p99 within 20%.
- [ ] **Task 1.2: grid, candidates, pinning** (`collector/grid.js`). Tests on fake chains:
  - the Q / D / W choice (no 0DTE; D / W monthly only);
  - the strikes;
  - a CANDIDATES line every 30 min;
  - candidates pinned until expiry through a 30% spot move;
  - unpinned dropped beyond 20%;
  - NO_OPTIONS recorded;
  - a restart restores the pins from the files.
- [ ] **Task 1.3: quote sampler** (`collector/quotes.js` via `jsonl-sink`).
  - Tests: batching at the verified limit; Q 60 s, D / W 10 min; the row fields (5.2); provider time kept apart from receipt time; a
    429 gives a QUOTE_GAP; the hourly roll; a bounded queue.
  - **Accept:** a 30-min fake-server run gives the expected rows +/-1%.
- [ ] **Task 1.4: news poll and snapshots move into the collector; `EVENTS_NEWS_POLL=off` on the server; the server writes
  `events-srv-*`.**
  - Tests: the `ph94capture` suites pass against the collector; the server never polls with the flag; `inspect.js`, `news-coverage.js`
    and `vm-audit.sh` read both file names.
- [ ] **Task 1.5: measurement instrumentation** (`net-guard` request counters in the server's STATUS line; collector bytes / objects;
  `inspect.js` "expansion readiness").
  - Tests: the counters per host / endpoint; the readiness verdict for pass and for each failing row of section 11.

### M2: transfer

- [ ] **Task 2.1: exporter** (`collector/exporter.js`) `[reviewer]`. Tests against a fake GCS:
  - the whitelist (a renamed `.env` / log / ledger in the folder is NOT uploaded);
  - closed files only;
  - gzip + sha256;
  - the manifest last;
  - retry, and no double upload after a restart;
  - the daily caps (9.4) stop uploads and report it;
  - the key is never logged.
- [ ] **Task 2.2: GCS client** (`server/research/gcs.js`): service-account JWT with `crypto`, no new dependency.
  - Tests: token request shape, upload / list / get, error mapping.
- [ ] **Task 2.3: puller** (`tools/research/pull.js`).
  - Tests: new objects only; sha256 mismatch re-fetched then reported; idempotent; resumable; the per-run caps.
- [ ] **Task 2.4: archive recovery** (`vm-audit.sh --research <from-date>`, `tools/research/import-archive.js`).
  - Tests: a fixture archive is imported exactly like pulled files.

### M3: warehouse

- [ ] **Task 3.1: ledger schema** (`tools/research/db.js`).
  - Versioned tables:
    - `sessions`, `files`, `runs`;
    - `bars_1m`, `news_versions`, `events`, `snapshots`, `quotes`, `candidates`;
    - `moves`, `explanations`;
    - `opportunities`, `books`, `research_trades`, `features`;
    - `registry`, `proposals`, `forward_results`.
  - Tests: create / migrate; idempotent content-keyed upserts; a backup before migration; the import guard for `tools/research/**`.
- [ ] **Task 3.2: bars** (`tools/research/bars.js`): SIP 1-min bars, one symbol per request, only sessions ended > 15 min ago, <= 60 /
  min, 429 backoff.
  - Tests: pagination, the NYSE calendar, idempotent re-fetch.
  - **Accept:** a 20-session backfill with row counts per symbol / day.
- [ ] **Task 3.3: ingest** (`tools/research/ingest.js`).
  - Tests: versions; duplicates; a partial session waits; gaps into a table.

### M4: observation and explanation

- [ ] **Task 4.1: moves** (`tools/research/observe.js`).
  - Tests: synthetic bars with known start / peak / reversal minutes; QUIET; the multi-session scales.
- [ ] **Task 4.2: `exposure-map@1`** (`research/maps/exposure-map@1.json` + `tools/research/build-map.js`).
  - Wikipedia GICS at pinned revisions; ETF holdings where published; curated pairs with citations.
  - Frozen by hash after your one-time review.
  - Tests: every entry has a relation, a source and a date; no outcome data read by the builder.
- [ ] **Task 4.3: `evt-rules@1` + event grouping** (`tools/research/classify.js`, `events.js`).
  - The 300-document stratified set for your one-time review; precision / recall per category in `docs/research/phase95-classifier.md`.
  - Tests:
    - grouping by structured key, then text similarity;
    - `t_known` per field;
    - REACTIVE;
    - UNKNOWN / AMBIGUOUS states;
    - the output identical with future bars present.
- [ ] **Task 4.4: explanations** (`tools/research/explain.js`): the decomposition, map-blind candidate drivers, the verdicts of 7.3
  including NO_IDENTIFIABLE_DRIVER.
  - Tests:
    - a planted pre-move company event -> ASSOCIATED_EVENT;
    - a market-wide move -> MARKET;
    - a reactive article is never a driver;
    - no event -> NO_IDENTIFIABLE_DRIVER;
    - the explanations never reach the `feat_*` store.
- [ ] **Task 4.5: `triggers@1`** (`tools/research/triggers.js`), frozen by hash in `research/frozen/triggers@1.json` before any outcome
  code runs.
  - Tests: each trigger on its pattern and its near-miss; re-arm after 30 min; bars ended by `t_avail` only.

### M5: replay engine

- [ ] **Task 5.1: opportunities and dedup** (`tools/research/shadow/opportunities.js`).
  - Tests:
    - APP by the C1-B rule (one per decision id; every path);
    - TRIGGER / CONTROL times;
    - repeated records of one key merged with every source record and the full decision history kept;
    - two different triggers, opposite directions, and a decline then a rebound within 15 min stay separate opportunities, linked
      and sharing an episode;
    - episodes across symbols for shared events.
- [ ] **Task 5.2: entry fills** (`shadow/fills.js`).
  - Tests:
    - the contract from the latest CANDIDATES line recorded at or before `t_avail`, with its timestamp, eligibility and coverage kept;
    - a CANDIDATES line recorded after `t_avail` is never used, even if the earlier one is unusable (NO_SELECTION /
      INSUFFICIENT_EXPIRY instead);
    - the first eligible observed quote at or after `t_avail + L`;
    - the eligibility filter;
    - UNFILLED after 2 / 15 min;
    - the latency recorded;
    - the price label carried from the quote's feed.
- [ ] **Task 5.3: exit fills** (`shadow/exits.js`).
  - Tests:
    - the trigger only at observed quotes;
    - the fill at the NEXT eligible quote, never at the threshold;
    - a gap -> EXIT_DELAYED / GAP_EXIT;
    - the loss beyond the stop computed to the cent;
    - the 15:50 flat;
    - session counting across holidays and early closes;
    - INSUFFICIENT_EXPIRY;
    - EXPIRY_EXIT at 2 DTE;
    - QUOTE_GAP, QUOTES_ENDED, ADJUSTED.
- [ ] **Task 5.4: `exits@1` + books** (`shadow/books.js`; the rule table and the D7 limits frozen in `research/frozen/exits@1.json`).
  - Tests:
    - the capital / concurrency / per-symbol / daily-entry / daily-loss limits;
    - a BOOK ENTRY record for every (opportunity, book): ENTERED, or SKIPPED with exactly one reason (CAPITAL, CONCURRENCY, PER_SYMBOL,
      DAILY_ENTRIES, DAILY_LOSS, NO_SELECTION, INSUFFICIENT_EXPIRY, UNFILLED) and the book state at that moment;
    - the unconstrained outcome still computed for skipped opportunities;
    - competing exits never summed across books;
    - MARKET_QUOTE and INDICATIVE_ESTIMATE never in the same book.
- [ ] **Task 5.5: the engine run** (`shadow/run.js`).
  - Sessions in order; multi-day holds completed as sessions arrive; REPLAY vs LIVE_PAPER labels.
  - Tests: an idempotent re-run; a missing session inside a hold; wins and losses both stored.
  - **Accept:** a fixture week gives the expected trades and P/L to the cent.
- [ ] **Task 5.6: leakage guard** (`tests/ph95asof.js`).
  - Every `feat_*` value and every replayed entry / switch / exit decision is recomputed after perturbing all data after its time,
    each source separately.
  - **Accept:** 0 differences on 500 sampled decisions; a planted leaking feature is caught.

### M6: features

- [ ] **Task 6.1: `feat_*`** (`tools/research/features.js`): section 7.4 through one as-of accessor.
  - Tests: each feature on fixtures; a missing input gives `null` + a reason; a future-available value is refused.

### M7: protocol, discovery and forward tests

- [ ] **Task 7.0: the protocol** `docs/research/phase95-protocol.md` (section 8 in full, with the exact rules of 8.5 copied unchanged: the
  bootstrap p-value, alpha_k, beta_k, the families; the bins, the search space, the criteria). Committed and hashed BEFORE any discovery run.
  - **Accept:** the hash is recorded in the registry header.
- [ ] **Task 7.1: discovery** (`tools/research/discover.js`): the candidate list hashed before outcomes; `n_eff`; the 8.4 criteria; BH
  at alpha_k in run k; the BY sensitivity column; the registry append.
  - Tests:
    - a planted effect is found;
    - pure noise yields no promising candidate in >= 95 of 100 seeded runs;
    - the alpha_k values of 8.5 to 3 significant digits;
    - 20 repeated runs on growing noise keep the overall false-discovery rate <= 10% over 200 simulations;
    - the bootstrap p-value matches a hand-computed small case for a fixed seed;
    - a leaked-label feature is excluded.
- [ ] **Task 7.2: the quick-vs-hold study** (`tools/research/hold-study.js`): switch policies as candidates; labels at the Q-trigger
  quote; features as of that quote.
  - Tests: the outcome is used only as the label; the comparison is against "exit at Q" on the same trades.
- [ ] **Task 7.3: proposals and forward tests** (`tools/research/forward.js`).
  - Tests:
    - `wx` immutability;
    - one look at `n_eff` 40;
    - Bonferroni within family F_k at beta_k / |F_k|, with |F_k| fixed at freeze;
    - interim looks never change a verdict;
    - PASSED-INDICATIVE vs VALIDATED;
    - INCONCLUSIVE at 12 months;
    - failed candidates retained and never re-proposed unchanged.

### M8: reports, scheduling and drills

- [ ] **Task 8.1: reports** (`tools/research/report.js`): sections 10.5.
  - Tests: renders from fixtures; health conditions; REPLAY and LIVE_PAPER never combined; MARKET_QUOTE and INDICATIVE sections
    separate.
- [ ] **Task 8.2: orchestrator** (`tools/research/daily.js`): the lock; the stages of section 3; resume; `status.json`; the
  expansion-readiness table.
  - Tests: a crash at each stage resumes; concurrent runs wait.
- [ ] **Task 8.3: PC scheduler** (`scripts/research/install-pc-task.ps1` + uninstall; you run it once). A dry-run mode.
- [ ] **Task 8.4: VM collector runbook** (deployment needs YOUR separate approval): the pm2 start, key placement, verification,
  rollback (`pm2 delete signaldesk-research`, the server flag back on).
- [ ] **Task 8.5: recovery drills** (harness): every row of 10.6.
  - **Accept:** a drill log in the runbook with the visible signal and the data loss stated.
- [ ] **Task 8.6: 10 unattended sessions** (after a separately approved deployment).
  - **Accept:**
    - 10 consecutive daily reports with no manual step;
    - >= 90% grid and poll coverage in session hours;
    - export backlog <= 2 h;
    - zero duplicates;
    - server health within budget;
    - the section 11 table produced.

### M9: documentation

- [ ] **Task 9.1:** the spec amendment (the automatic workflow, REPLAY / LIVE_PAPER, the books, the option set, the protocol, the cost
  controls) and the `CLAUDE.md` Phase 95 note.

## 13. Acceptance summary (what you can check)

| Area | Check | Where |
|---|---|---|
| Unattended | 10 daily reports with no manual step; PC 5 days off loses nothing | reports, drill log |
| Coverage and gaps | >= 90% coverage; every gap with a reason | daily health |
| Fills | entry and exit at the first eligible observed quote; never at thresholds; latency / gaps / losses beyond the stop reported | tests 5.2 / 5.3, report |
| Selection and tracking | the contract comes only from the selection recorded before the decision (timestamp, eligibility, coverage kept; never a later refresh); every selected contract tracked to its exit or expiry; expiry rules applied | tests 1.2 / 5.2 / 5.3 |
| Two price kinds | MARKET_QUOTE and INDICATIVE_ESTIMATE separate everywhere; no VALIDATED on indicative | tests 5.4 / 7.3 |
| Books | only repeated records of one opportunity merged, with sources and history kept; distinct triggers / directions / declines / rebounds separate; every (opportunity, book) recorded, ENTERED or SKIPPED with its reason; declared capital and limits; competing exits never summed | tests 5.1 / 5.4, report |
| Replay vs live | every record labelled; never combined | test 8.1 |
| Explanations | ASSOCIATED_EVENT / MARKET / SECTOR / PEER / NO_IDENTIFIABLE_DRIVER counts and examples | report |
| No leakage | perturbation test: 0 differences; planted leak caught | `tests/ph95asof.js` |
| Protocol | the exact rules of 8.5 (bootstrap p-value; BH at alpha_k = 0.10 x 6 / (pi^2 k^2) per run; forward Bonferroni within families at beta_k = 0.05 x 6 / (pi^2 k^2)), frozen before any evaluation; failed candidates retained | protocol hash, registry |
| Load, API use, bytes | measured before any expansion request | section 11 table |
| Cost | separate project; lifecycle; code caps; alert understood as notification only | runbook |
| Separation | zero writes to the trading ledger; no trading imports | import tests |

## 14. Review focus (the most likely real-world failures)

1. **The indicative feed repeating a stale quote.** Eligibility uses the PROVIDER time, not our receipt time (test 5.2).
2. **A holiday or early close inside a multi-day hold.** Sessions are counted with the NYSE calendar (test 5.3).
3. **One news story reaching several mapped peers.** One episode, not N independent examples (tests 5.1 / 7.1).
4. **The collector restarting mid-session.** The pins are restored from the files, so a held contract is not lost (test 1.2).
5. **A DST-change week.** All times in UTC ms, sessions in ET via the DST-safe helper; a DST fixture runs end to end (test 5.5).

## 15. Not in this plan

- Broker-trading changes.
- Deployments, purchases, expansion and merges without your separate approval.
- Paid ratings.
- LLM classification.
- EDGAR (until your contact decision).
- Crypto (spec Stage 9).
- A live shadow runner.
- Symbols beyond universe-v1.
