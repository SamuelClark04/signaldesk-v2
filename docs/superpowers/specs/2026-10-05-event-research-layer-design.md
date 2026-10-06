# Phase 94: Market Observation and Event Research Layer (design, revision 3)

Status: **revision 3, 2026-10-06: the decisions in section 18 are folded in. It authorizes specification refinement and planning
only.** Implementation, purchases, deployment and trading-rule changes each need a separate approval. No change to trading rules,
safeguards, approvals or automation. The Stage 0-1 implementation plan is `docs/superpowers/plans/2026-10-06-phase94-stage0-1.md`.
- **Revision 3** adds:
  - your decisions (section 18);
  - the PR #2 accuracy-fix list (Stage 0, section 16.1);
  - the availability clarifications (section 5): assumed delays, receipt vs classification, no fact reaches an earlier timestamp
    through grouping;
  - the explicit, dated universe with a pilot (3.1);
  - prior data use (11.7);
  - news capture without widening the strategy's news subscription (7).
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

**Settled (revision 3):**
- A1. "Elsewhere" = this PC. The VM only does light capture.
- A2. **Your Amazon example was hypothetical, not a trading date.**
  - Its lesson is a general rule: an overall decline and a smaller rebound inside it are separate episodes, and an entry is tested
    only after its trigger is available (10:14 vs 10:17).
  - AMZN on 2026-10-02 is kept as a SEPARATE worked illustration on real data (12.3). It describes how AMZN performed against its
    benchmarks, and does not claim that this establishes a cause.
- A3. **The PR #2 accuracy-fix list was received.** It is Stage 0 (16.1). These fixes are PLANNED, not implemented: each counts as
  done only when its code is in and its regression checks pass.
- A4. **No option data purchase now.**
  - Existing entitlements and the coverage each stage needs are checked first (4.1).
  - Option results stay explicitly "unavailable" where there are no real quotes.
  - Results from quotes are SIMULATIONS with documented fill assumptions, never reported as achieved fills.

## 1. Approaches considered

| | Approach | Verdict |
|---|---|---|
| A | **Thin live capture on the VM; observation, warehouse and research on the PC** | **Recommended.** The VM records only what cannot be fetched later. Bars, quotes, filings and calendars are reproducible and are fetched on the PC. |
| B | Run the observation layer on the VM in real time | Rejected: 0.25 vCPU, Alpaca's free stream symbol limit, and research code inside the trading process. |
| C | Vendor history only | Rejected as the only source. It never yields our receipt times or article versions. It is still used for backfill, labelled. |

## 2. Architecture

```
VM (record-only, unchanged trading)                 PC (research; append-only warehouse; never touches the VM)
 news stream tap + 2-min poll ─┐                     daily job (after the close, idempotent, catches up missed days)
 macro / earnings snapshots ───┼─► events-*.jsonl     ├─ fetch: IEX + SIP 1-min bars, SIP quotes (sampled), Alpaca news,
 open-option marks ────────────┘   (Phase 93 sink)    │         EDGAR, calendars, [option NBBO: not purchased]
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

- **universe-v1 is an EXPLICIT, DATED list.** `research/universe/universe-v1.json` is committed before any collection, and every
  symbol carries its source and the freeze date. It is the union of:
  - **the S&P 100 constituents** on the freeze date.
    - Source: the Wikipedia "S&P 100" components table at a PINNED revision, with its revision id, the freeze date and the sha256 of
      the raw page recorded. The iShares OEF holdings link returned a web page, not the file, when checked on 2026-10-05.
    - Share classes are kept as listed (e.g. GOOGL and GOOG).
  - **benchmarks:**
    - SPY, QQQ, IWM, DIA;
    - the 11 SPDR sector ETFs (XLB XLC XLE XLF XLI XLK XLP XLRE XLU XLV XLY);
    - industry ETFs SMH, KRE, XBI, XRT, IYT;
    - VIX (daily, Cboe) with VIXY as the intraday proxy, labelled "proxy".
  - **your watchlist:**
    - the app's stock list in `server/market/universe.js` `STOCKS` at the freeze commit (41 symbols today);
    - plus the VM's saved `watchlist.json` stocks. vm-audit does not copy that file yet: Stage 1 adds it, and the freeze waits for
      that archive.
- **Pilot first (universe-v1, pilot subset P1).** Collection starts with a pilot defined by a rule fixed before any data:
  - the 10 stock symbols of `CORE_WATCHLIST` (SPY QQQ AAPL NVDA MSFT META AMZN GOOGL TSLA AMD);
  - IWM, DIA, the 11 SPDR sector ETFs and SMH.
  - That is 24 symbols.
- **Expansion to the full universe-v1** happens only after at least 10 pilot sessions show:
  - zero recorder drops and write errors;
  - VM CPU / memory within the budget measured in Stage 1;
  - news volume per day measured;
  - your approval.
- **No symbol enters or leaves because it moved.** Removed constituents stay through their last day.
- Changes create a new version, and every row carries its universe version.

**Limits of the universe source (stated in the file and in every report that uses it):**
- **It is a pinned CURRENT list, not historical index membership.**
  - It is the S&P 100 as listed on the freeze date. Applied to earlier dates (the 2018-2025 backfill), it includes companies that
    joined the index later and omits companies that left it before the freeze.
  - It is a SURVIVORSHIP-BIASED sample of past index membership.
  - Reports label such results "universe = membership as of <freeze date>, applied retroactively" and never call it "the S&P 100
    in <year>".
- **Wikipedia is a secondary source.** It can lag an index change or contain an error. The freeze tool records the revision, so the
  exact list is reproducible. A difference found later is a new universe version, not an edit.
- **Real historical membership would need a separate dated source** (S&P index announcements or a point-in-time constituents
  dataset). None is in scope or purchased. Until one is, "fixed universe" means "a fixed list", not "the index as it was".
- **The forward-collected data (from the pilot on) does not have this problem.** The list was fixed before the data existed.

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
| **Option quotes, history and forward** | **ThetaData**: Value $40 / mo (1-minute, 6 years, 2 concurrent requests); Standard $80 / mo (every OPRA NBBO quote, tick, 10 years); Pro $160 / mo | runs on the PC (Theta Terminal) | $40-80 / month; **NOT purchased (decision 2)** | **The candidate source if a purchase is later approved.** Fetched PER OPPORTUNITY (section 8.5), not whole chains. Check at purchase whether historical IV / Greeks come with the tier, else solve IV from NBBO mid locally. |
| | Massive Options Advanced $199 / mo (quotes, 5+ years); Databento OPRA CBBO-1m from 2013 ($/GB, $125 free credit) | | | alternatives |
| Live quotes of open positions | Alpaca indicative feed (already polled) | live only; no historical option quotes at Alpaca | free | the open-position life cycle (section 10) |

**Costs: no purchase now (decision 2).**
- Planning and the first collection run on existing, free entitlements only.
- Any purchase (option quotes, analyst ratings) needs its own approval, AFTER the entitlement check (4.1) shows what is missing.

### 4.0 Identity in outside requests

- **No personal email address (or other personal data) is ever inserted automatically into a request to an outside service**:
  not in a User-Agent, a header, a URL or a body.
- Where a provider accepts it, requests identify the APPLICATION only: `User-Agent: SignalDesk-research/1.0`.
- **Providers that ask for a contact address are FLAGGED, not filled in.** The user decides whether to designate an address (it may
  be a dedicated one), and it is then read from a setting, never taken from the user's account email.
  - **SEC EDGAR:** its fair-access policy asks automated clients to declare a User-Agent with a company / contact email.
    - It is needed from Stage 2 (filings backfill), so Stage 2 is blocked on a designated contact until the user provides one.
    - Without it, EDGAR may refuse requests, and filings stay "not collected".
  - **Wikipedia (the universe freeze):** its User-Agent policy asks for contact information.
    - The freeze tool sends the application identifier only.
    - If Wikipedia refuses that, the freeze stops and reports it; no address is added automatically.
- On 2026-10-05, one exploratory request to Wikipedia carried the user's email in its User-Agent. That was a mistake: the rule
  above prevents it, and the scripts in the plan use the application identifier only.

### 4.1 Existing entitlements and the coverage each stage needs (checked before any purchase)

| Data | What we have now (Phase 89b findings; re-checked by a read-only script in Stage 1) | Needed by | Without it |
|---|---|---|---|
| Alpaca stock bars / quotes | IEX real time; SIP history older than 15 min; free plan, 200 calls / min | observation (Stages 2-4) | (have it) |
| Alpaca option snapshots | INDICATIVE feed only (not OPRA: 403 until the OPRA agreement is signed); live, no history | open-position marks (Stage 1) | (have it) |
| Alpaca option history | trade bars / trades from Feb 2024; NO historical quotes (404) | contract simulations | prints are ESTIMATES (Phase 93 tier 2), never quote-based results |
| Alpaca News | Benzinga, since 2015, current version only | events | (have it) |
| Finnhub | free key in use (earnings shield) | earnings snapshots | (have it) |
| ThetaData | none (a free tier exists: end-of-day only, from 2023-06; creating an account is your action) | quote-based option simulation (Stage 6) | option results "unavailable" |

- **Quote-based option results are always simulations.**
  - Each states its fill assumptions: entry at the ask / exit at the bid at a stated time; the quote age limit; the stale-quote rule;
    fees.
  - None is called an achieved fill.
- **Option trade prints stay ESTIMATES** (Phase 93), and are never mixed into quote-based results.
- **Checked 2026-10-06** (read-only, docs/research/phase94-entitlements.md):
  - news `start` filters on updated_at (the news cursor relies on it);
  - option trade bars exist before Feb 2024 for at least one contract (coverage is checked per contract);
  - Finnhub's all-US earnings calendar answer was capped at 1,500 rows, so the snapshot queries each capture symbol;
  - OPRA is not available (agreement not signed);
  - there are no historical option quotes.

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

### 5.1 What each time does and does not prove (revision 3)

- **Assumed delays are assumptions.**
  - Every historical delivery or processing delay is an ASSUMPTION: the +60 s on a provider timestamp, the +5 s on a bar, the +1 s
    to order.
  - It is never presented as a verified receipt time. Such a time carries `timing: ASSUMED` with the assumption's name and value
    (e.g. `ASSUMED_PROVIDER_DELAY_60S`).
  - Only a time our own system recorded is `RECORDED`.
  - Reports can re-run with different assumed delays (a sensitivity table), and say so.
- **A receipt is not a classification.**
  - `t_recv` proves only that our system HAD the document then. It does not prove a classification existed then.
  - Until a classifier runs live and records its own completion time, every `t_cls` is SIMULATED: `t_recv` (or the assumed
    availability) + the classifier's declared latency, labelled `CLS_SIMULATED`.
  - It is kept in a separate field from any measured `CLS_RECORDED` time, and the two are never merged.
- **Grouping never moves a fact earlier.**
  - An event is a TIME-INDEXED object. Its state "as of t" holds only the document versions with `t_known <= t`, and only the
    fields those versions support.
  - A fact first stated in a later article, or in a later revision of the first article, becomes available at THAT document's
    `t_known`, not at the event's first timestamp. Examples: a surprise number, a guidance figure, a confirmation.
  - The event record stores each field with the document version and time that first supplied it (`field_sources`), and every
    predictive read goes through `eventAsOf(eventId, t)`.
  - A test feeds a later article that adds a fact and checks that `eventAsOf(firstArticle.t_known)` does not contain it.
- **Predictive fields use only evidence available by that decision.**
  - Every predictive field (event, market, option) is read through one as-of accessor (8.7), which refuses a value whose
    availability is later than the decision.
  - A value whose availability is ASSUMED stays usable only under its labelled assumption, and is reported that way.

### 5.2 Real-time entry timing

- **Bar-based triggers:**
  - a 1-minute bar is available at its end + 2 s (stream delivery) + 3 s (processing), so `t_avail = bar_end + 5 s` (ASSUMED);
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
- **An event's `t_known`** is its earliest document's, for the fields THAT document supports. Every other field has its own
  availability time (5.1), and links to prior events give novelty.
- **Classifier `evt-rules@1.0.0`:**
  - deterministic rules: EDGAR form / 8-K items, Benzinga formulaic headlines, wire and agency names;
  - it never sees prices after `t_known` (a test proves its output is identical with future bars present);
  - quality is measured on a REVIEWED example set: 300 documents, stratified by category, labelled by you or with your review
    BEFORE the rules are tuned, and frozen with the classifier version;
  - **model-based (LLM) classification is OFF (decision 5)**, because of hindsight leakage.
- **Structured variables are always produced, with uncertainty explicit.**
  - Every event gets every variable in the dictionary.
  - A field the rules cannot decide is never guessed and never left blank. It carries an explicit state: `UNKNOWN` (no rule
    matched), `AMBIGUOUS` (two rules disagree; both candidates listed) or `NOT_APPLICABLE`.
  - It also carries a per-field `confidence`: the matching rule's precision on the reviewed set, or null when that rule has fewer
    than 10 reviewed examples.
  - Analyses report how many events had each field UNKNOWN / AMBIGUOUS.
- **Analyst actions: no paid ratings now (decision 4).** Headline extraction quality is measured first, as precision / recall on the
  reviewed set. A later purchase needs its own approval.
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

## 7. Live capture on the VM (revision 3)

- **The news stream's subscription is NOT changed.**
  - `server.js` subscribes the news socket to `STREAMED_STOCKS`, and `strategy-runner` hands `getNewsContext()` to `equity-day`.
  - Adding symbols to that subscription would change a strategy's inputs, which is a trading change.
  - So the capture TAPS the messages the socket already receives (record-only, after the app's own handler, which sees exactly
    what it saw before; tested), and covers the rest of the pilot / universe by REST polling.
- **What is captured:**
  - the news stream tap above;
  - a REST poll every 2 minutes in market hours (every 10 minutes otherwise) for the pilot / universe symbols, sorted by updated
    date since the last poll, with content. It is 1 call per poll for the pilot (the symbols in one request, paged at most 2 pages),
    far under 200 / min.
    - A new `updated_at` for a known id = a new version.
    - `t_recv` = the poll's receive time, labelled `seenVia: poll` with the poll interval: our receipt is RECORDED, and the delay
      since publication is at most one interval plus the provider's own delay;
  - **Limits of polling, kept in the research labels (whatever the interval: 2, 5 or 10 minutes):**
    - A poll captures only the versions that exist when it runs. A revision that is published and then replaced between two polls
      is never seen. Every polled document carries `versionCoverage: OBSERVED_ONLY` (the versions we saw, not every revision
      there was).
    - A poll is not immediate awareness. `t_recv` is the time our poll actually received the version, labelled
      `receipt: POLL_RECEIPT` with `pollEveryMs`. A headline may have existed up to one interval (plus the provider's own delay)
      before that.
    - Research may use `t_recv` as when the app COULD have known. It must not assume the app knew at `t_pub`.
    - Stream-tapped messages are `receipt: STREAM_RECEIPT`, and only for the app's streamed symbols.
    - Neither proves that every intermediate revision was captured.
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
- **Quotes are fetched per opportunity:** NBBO for the chosen contracts (and the benchmark contracts) from entry to the latest
  horizon. That needs a quote source. None is purchased (decision 2).
- **Every quote-based option result is a SIMULATION.** Its card and table row state the fill assumptions:
  - entry at the ask, exit at the bid (spreads: natural prices), at the stated time;
  - $0.65 per contract per fill;
  - quote age <= 30 s; a stale quote at a fill time is UNFILLABLE at that moment, the fill moves to the next fresh quote, and the
    delay is recorded;
  - no partial fills, no price improvement.

  It is never called an achieved or a realistic fill.
- **HINDSIGHT-BEST CONTRACT** = the listed contract that would have returned the most over the realized move. It is a **benchmark
  only**, shown with its label.
- **Without quotes, every option result is explicitly "UNAVAILABLE (no quote source)".** It is not modelled into a P&L.
  - A Black-Scholes estimate may be shown only as "MODEL ESTIMATE", never in candidate profitability.
  - Trade prints (Alpaca, Feb 2024+) may be shown only as Phase 93's "ESTIMATE: trade prints".
  - The stock-side and direction results are unaffected.

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
  - both chronological halves have the same sign;
  - for a candidate using event variables: the P vs P+E difference interval is above 0.
- Otherwise it is "insufficient" or "not supported", with the numbers shown.
- **Counts alone never make a candidate promising, and never make a proposal pass (decision 6).** Reaching 30 (discovery) or 40
  (forward) independent examples only makes the test ELIGIBLE to run. The verdict comes from:
  - the after-cost uncertainty checks;
  - consistency;
  - the multiple-testing correction;
  - the price-only comparison.

  A candidate that reaches its count but fails those is reported as "enough examples, not supported".

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
- **R stays unseen (decision 3).** No option quotes, prints or chains dated 2025-06-02 .. 2026-10-01 are downloaded or examined by
  this layer. Its stock bars and news are NOT reserved: they were already examined by earlier phases (11.7).

### 11.7 Data examined before this layer (documented separately, decision 3)

Results on windows that earlier phases already looked at are marked **"previously examined (other hypotheses)"** in every report.
Only data collected after a proposal's freeze is untouched for that proposal.

| Phase | Data examined | Window | Markets / symbols |
|---|---|---|---|
| 78 | crypto bars (swing replay) | 2 x 90 days, before 2026-09 | Coinbase crypto |
| 79 / 89b | crypto 5m bars (Moonshots); then the 90 days before | about 2026-04 .. 2026-09 | 62 gems |
| 87 | stock IEX 1h / daily bars (options signals on the underlying) | 2 years, about 2024-10 .. 2026-10 | 25 symbols |
| 88 | stock IEX bars (Equity Swing / ORB) | 2024-10 .. 2026-10 | the app's stocks |
| 89 / 89b | SPY / QQQ IEX bars + option trade bars (Quick Flips development) | Feb 2024 .. 2025-05; R kept unseen | SPY, QQQ |
| 89 / 89b | crypto 15m / 1h bars (Crypto Intraday revised rules) | 2022-23 and recent | 15 coins |
| 90 | stock bars (Swing / ORB unseen test) | 2022-10 .. 2024-10 | the app's stocks |
| 90 | SPY / QQQ 1-min bars, Black-Scholes model (N1 / N2) | 2019 .. 2023 | SPY, QQQ |
| 93 | the app's own decisions + fetched bars | 2026-09 .. 2026-10 | accepted / rejected setups |
| 94 (this design) | AMZN / SPY / QQQ / XLY 1-min bars + AMZN news | 2026-09-28 .. 2026-10-02 | the 12.3 illustration |
| (live app) | the Catalyst & News Feed has shown recent headlines in the app since Phase 62 | rolling 48 h | the app's symbols |

- **No phase studied historical news or event variables systematically**, so the event features are new hypotheses on every window.
- **The PRICE data of the D and V windows is not pristine.**
  - SPY / QQQ 2019-2023 (Phase 90) and the app's stocks 2022-10 .. 2025-05 (Phases 87-90) were examined for other strategies.
  - Reports flag results that depend mostly on those symbol-windows.
  - Forward data is the clean test.

## 12. Reports and worked examples

### 12.1 Trade / opportunity card

One time axis:
- **Price:** the underlying, sector ex-self and SPY (rebased).
- **Events:** solid = known before; hollow = arrived later; x = reactive.
- **Trigger firings and entry / exit times:**
  - real-time entries are marked at `t_avail + 1 s`;
  - benchmark pivots are drawn dashed and labelled "hindsight".
- **The option's bid / ask band** (recorded live for open positions; otherwise only if a quote source is ever approved).
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

### 12.3 Separate worked illustration: AMZN, Friday 2026-10-02 (REAL data, FETCHED: SIP 1-minute bars + Alpaca news; read-only)

Your Amazon example was hypothetical. This day is NOT it: it is an independent illustration of the same mechanics on real data,
picked because it has a morning decline with a rebound inside it. It is "previously examined" data from now on (11.7).

**Two episodes, kept separate:**

| Episode | Times (ET) | AMZN | SPY | QQQ | XLY (raw; contains AMZN) |
|---|---|---|---|---|---|
| **E1: morning decline (parent)** | 09:32 (253.30) -> 11:53 (250.07) | **-1.27%** | -0.19% | -0.06% | -0.30% |
| first leg down | 09:32 -> 09:56 | -0.87% | -0.09% | +0.10% | -0.23% |
| **E2: rebound inside E1 (child, counter-move)** | 09:56 (251.09) -> 10:20 (252.85) | **+0.70%** | +0.35% | +0.43% | +0.54% |
| second leg down | 10:20 -> 11:53 | -1.10% | -0.44% | -0.59% | -0.61% |

**Benchmark comparison: a description, not a cause.**
- **E1:** AMZN fell 1.27% while SPY fell 0.19%, QQQ 0.06% and XLY 0.30%. AMZN UNDERPERFORMED these benchmarks by about 1.0-1.2
  points.
- **E2:** AMZN rose 0.70% while SPY rose 0.35%, QQQ 0.43% and XLY 0.54%. The benchmarks moved the same way over the same minutes.
- **Neither comparison establishes why AMZN moved.**
  - The underperformance in E1 says only that a raw benchmark-relative difference existed.
  - It does not show the move was caused by company news, nor that it was "stock-specific" in any causal sense. XLY even contains
    AMZN.
  - The full build adds the betas, the sector ex-self comparison and the residual percentile against AMZN's matched no-event
    mornings.
  - Any candidate explanation is then labelled an association, and "no identifiable driver" remains a possible answer for either
    episode.

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
- every trigger firing in the window, with call / put results that are quote-based simulations if a quote source is ever approved,
  else "UNAVAILABLE (no quote source)";
- whether any strategy staged or blocked anything.

The pre-open items are possible explanatory associations for E1, nothing more. None is a cause, and none is evidence of predictive
value until a pattern built from many independent days passes 11.3 and 11.4.

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
| 0 | repo | the PR #2 accuracy fixes (16.1); regression checks; a regenerated report that explains every changed count; the integrated PR #1 fee + PR #2 recorder code tested together | suites green on the integrated code; the change report reviewed by you |
| 1 | VM, record-only (pilot P1) | shared sink; news tap (no subscription change) + REST poll; macro / earnings snapshots; open-option marks; status; vm-audit copies `events-*` + `watchlist.json`; option entitlement check; universe-v1 frozen as an explicit dated list | strategy outputs identical with capture on / off; a hanging fs never delays a pass; deploy separately approved |
| 2 | PC | warehouse + daily job (idempotent catch-up); backfill: IEX + SIP bars, Alpaca news, EDGAR (needs a user-designated contact address, 4.0), calendars | row counts per source / day; every row labelled; re-runs change nothing |
| 3 | PC | **exposure-map@1** (10-K segments, competitors, SIC peers, supply chain, macro / regulatory themes; cited), frozen BEFORE outcome study; classifier `evt-rules@1` + golden set | map reviewed by you; classifier precision / recall reported |
| 4 | PC | observation engine: multi-scale moves, QUIET, `triggers@1`, firings, stock outcomes, benchmarks, sector ex-self, matched controls, episodes / n_eff, strategy coverage join | the AMZN 2026-10-02 example reproduces section 12.3; synthetic tests for every rule |
| 5 | PC | daily progress report + opportunity cards | a daily report for a backfilled week + one forward day |
| 6 | PC | `contracts@1`, `exits@1`; call / put evaluation with "UNAVAILABLE (no quote source)" until a quote source is separately approved; benchmarks | no purchase without its own approval; R never downloaded |
| 7 | PC | periodic discovery run (11.3) on D (+ forward as it accrues); hypothesis log; the first proposals | proposals written; you choose which to freeze |
| 8 | PC | V run (optional) + forward evaluation of frozen proposals in the daily report | pre-stated criteria only |
| 9 | VM + PC | crypto adapter | as Stages 1-8 |

### 16.1 Stage 0: the PR #2 accuracy fixes (your list): IMPLEMENTED 2026-10-06, regression checks passing

Status: **implemented on `phase93-decision-review` (PR #2).**
- Each fix has regression checks that failed on the Phase 93 code and pass now: tests/ph94unit.js (S0-1) and tests/ph93hooks.js (S0-3
  server); tests/ph94review.js (S0-2, S0-3, S0-4, S0-5, C1).
- Each server change was approved by an independent reviewer, and the analyzer changes by an end-of-branch review.
- The regenerated report and its attributed changes: docs/research/phase94-stage0-report-changes.md.
- Not merged, not deployed.

| # | Fix (implemented) | Where in PR #2 (found while planning) |
|---|---|---|
| S0-1 | **Captured chart evidence is immutable, and deduplicated by its complete stored contents.** | `decision-context.capture` copies the bar ARRAY but keeps the bar OBJECTS by reference, so a bar the stream later updates changes the evidence before it is written. `decision-serialize.seriesLine` keys a series by name / count / first and last time / last close / volume, so two different series with the same endpoints share one stored copy. Fix: copy each bar into a fresh frozen row at capture; key = sha256 of the stored series body (`b2:` / `r2:`). The analyzer labels legacy `b:` keys "EVIDENCE_KEY_V1: may be ambiguous". |
| S0-2 | **No future price in pre-decision calculations; recorded inputs first.** | `measure.priceAt` (P0 fallback), `atrBefore`, `dailyAtr`, `patterns.features` (session / SPY VWAP, gap) and the chart's pre-decision part use bars whose START is before t0. That includes the unfinished t0 minute bar and the decision day's daily bar, which hold later prices. Fix: a bar is usable only if its END is at or before t0. Pre-decision values come first from the RECORDED strategy inputs, then from FETCHED complete bars, labelled. |
| S0-3 | **Each lifecycle event keeps its own guard / context; a rejection is checked against its own time; decision / entry / close times stay separate.** | Approval-time events (APPROVAL_HOLD / REJECT, APPROVED, USER_REJECT) carry no guard. The loader keeps only the FIRST guard (`d.guard`), and `safeguards.check` uses it with the FIRST event whose reason matches. LEDGER records set t0 = stagedAt OR approvedAt OR openedAt. Fix: a guard snapshot on every event; the check uses the rejecting event's own snapshot; `t0` (decision), `tApproved`, `tEntry` and `tClose` are separate fields, each with its source, and no measure silently substitutes one for another. |
| S0-4 | **Original and opposite simulations are comparable.** | `oppositeOf` enters at market at the next bar's open with no approval window, a single target (T1 share 1) and no runner, while the original uses its zone / window and its T1 / T2 split. Fix: a "matched" pair. Both sides use the same entry opportunity (the same rule type, window and timing), the same costs, mirrored stop / targets and the SAME T1 / T2 allocation. An unfilled outcome stays UNFILLED for either side and is counted. The opposite option stays "unavailable". The original's as-planned trade is still shown separately. |
| S0-5 | **Harness examples are separate from account statistics. Crypto coverage stays UNCLEAR. PFE target order is investigated separately.** | `run.js` merges every input folder into one set. Fix: an input is ACCOUNT (vm-audit archive) or HARNESS (`--harness <dir>`), decided by the command, not guessed. HARNESS records are excluded from every count, statistic and pattern, and shown in their own "harness examples" section. The crypto 90% coverage rule is unchanged (a test pins it). PFE's T2-below-T1 becomes a report flag + a separate investigation note; no trading change. |

**Also in Stage 0:**
- **guard exemption:** strategy-internal post-detection filters recorded through `decision-context.block` (ORB_FILTER,
  QUICKFLIPS_SIGNAL_SKIPPED) carry no guard snapshot; their rule checks use their own recorded signal values. Every other decision event
  carries its own snapshot, the pipeline's taken before any rejection of the pass is recorded;
- **C1 (approved correction):** the decision is the STAGED record, else the rejection that ENDED the setup (ids repeat per symbol per
  day); a later lifecycle event is never the decision, and without a recoverable stagedAt the decision time is MISSING. Checkpoint
  prices use bars completed by the checkpoint;
- **regression checks** for each fix (tests that fail on the PR #2 code and pass after);
- **a regenerated report** from the same Oct 4 archive + harness file, with a "what changed and why" section: the before / after
  counts, and per setup the fix behind each changed class, label or result;
- **the integrated code tested together, on a TEMPORARY local integration branch:**
  - PR #1 (fees) is merged into a copy of the PR #2 branch: never into `main`, and never `main` into either PR;
  - every suite and the browser harness run there;
  - no `git reset`, stash or rewrite of existing work; the branch is deleted after the test;
  - nothing is deployed;
  - the harness is isolated from real trading accounts: scratch ledger and credentials file, broker / AI URLs pointed at local mocks
    or dead ports, keys blank or fake, and that environment is checked before it starts.

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
  - `eventAsOf`: a fact added by a later article or revision is absent before that document's `t_known`;
  - ASSUMED vs RECORDED timing labels, and `CLS_SIMULATED` kept apart from `CLS_RECORDED`;
  - map-blind explanation listing;
  - n_eff for one shared event across many stocks = 1;
  - horizons kept separate;
  - the freeze / forward window boundaries;
  - INCONCLUSIVE on a time cap;
  - BH / Holm arithmetic;
  - attribution with the remainder.
- **Always:** all existing suites + `npm run check:limits`; every `.js` at or under 300 lines.

## 18. Decisions (settled 2026-10-06)

| # | Decision | Where it applies |
|---|---|---|
| 1 | S&P 100 + sector / industry benchmarks + your watchlist, frozen as an explicit dated list; a small pilot first, expanded on criteria | 3.1 |
| 2 | No option data purchase now; check entitlements and the needed coverage first; unavailable stays explicit; quote-based results are simulations with documented fills | 4, 4.1, 8.5 |
| 3 | Keep the Phase 90 options holdout R unseen; document previously examined price / news data separately | 11.6, 11.7 |
| 4 | No paid analyst ratings; measure headline extraction first; a purchase needs separate approval | 6 |
| 5 | Rules-based classifier + reviewed examples; model-based classification off; structured variables always produced, uncertain fields labelled | 6 |
| 6 | Four-week discovery; 30 / 40 independent-example minimums; after-cost uncertainty checks and the price-only comparison stay; counts alone never pass | 11.3, 11.4 |
| 7 | The Amazon example was hypothetical; 2026-10-02 is a separate illustration; benchmark underperformance described, not taken as a cause | 0, 12.3 |

This revision authorizes specification refinement and planning only. Implementation, purchases, deployment and trading-rule changes
each need a separate approval.
