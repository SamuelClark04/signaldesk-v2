# Phase 92: crypto research brief, strategy proposal and validation protocol (FROZEN)

Status: **FROZEN 2026-10-05 UTC**, approved by the user for isolated BTC screening. The commit that adds this file is the freeze record; nothing below may change after it. Nothing has been replayed and no strategy outcome has been computed. Data
touched so far:
- **availability probes only**: file listings, row and bar counts, column names and timestamps; no prices, OI values or returns (scratchpad `ph92/probe.js`, `ph92/okx-hist-probe.js`);
- the **venue fee reads** (`docs/research/phase92-fee-verification.md`).

On approval, the commit that adds this file is the freeze record. No backtest code is written before it.

Crypto stays manual-only in the app (Phase 91) whatever this research finds. A pass here would only justify a later, separately
approved radar-alert scanner (paper, manual approval).

---

## Part 1: Research brief

### 1.0 What our own data already says

| Test | Idea | Result |
|---|---|---|
| Phase 78 | Crypto Swing 4h (pullback / reversal, RSI / EMA) | PF 0.82-0.96 on 2 x 90 days; every filter worse |
| Phase 89 | Crypto Intraday 15m / 1h (squeeze, sweep, range failure, EMA / VWAP reclaim) | BTC / ETH: 2 trades in a year; 15 coins: PF 0.34-0.81 |
| Phase 89b | The same, revised (trend filter, venue fee floor, time stop), 2022-23 | 0-24 trades; without the filter, 208 trades at PF 0.66 |
| Phase 89b | Moonshots (breakout + retest) out of sample | PF 0.58 / 0.74 / 0.82 (Coinbase / Kraken / OKX) |

**Common failure pattern:**
- About 75% of trades hit the stop.
- Signals built only from price shape (sweeps, reclaims, breakouts) carried no information.
- At Coinbase Intro fees no setup survives the cost gates at all.
- Those tests used OKX / Kraken fees that were never verified and were too low (see 2.6), so their results were, if anything, flattering.

Two lessons follow:
- A new idea must use **information the failed rules never had**, not new parameters on price.
- The trade must be **large compared with costs**. At the verified OKX US taker rate a stopped trade costs about 0.79% (2.6): 0.79R on a 1% stop, about 0.26R on a 3% stop.

### 1.1 How each candidate is judged

Each research area is scored on four questions:
1. **Mechanism.** Is there a reason someone loses money to us?
2. **Size.** Is the move big enough to pay taker fees on US spot venues?
3. **Testability.** Does free historical data exist?
4. **Usability.** Can the Phase 91 workflow use it? That workflow means an alert, a human click within minutes, REST polling and a 0.25 vCPU VM.

The citations are from memory. They shaped the hypotheses, but I have not re-read them for this brief. The evidence will be our own frozen test.

### 1.2 Order-book dynamics (sweeps, imbalance, spread)

- **Mechanism: real.**
  - Order-flow imbalance at the top of the book predicts the next price change (Cont, Kukanov & Stoikov 2014, equities). Similar results are reported for crypto exchanges.
  - Liquidity sweeps exist: price runs resting stops beyond obvious levels.
- **Size: fails.**
  - The predictable move lasts seconds to a few minutes and is usually smaller than the spread plus one taker fee (verified: OKX US 0.35%, Kraken 0.80%, Coinbase 0.90%).
  - That edge belongs to co-located market makers paid maker rebates. A retail taker pays it rather than earns it.
- **Testability: fails.** No free historical L2 order-book data. Tardis, Kaiko and similar are paid.
- **Usability: fails.** A manual approval taking minutes outlives any imbalance signal.
- **Our sweep tests already failed:** the Phase 89 SWEEP and range-failure archetypes used price only, and range failure scored PF 0.19.

**Verdict: rejected as an entry signal.**
- A sweep of the flush low is kept only as the structural stop level in 2.4.
- Recording L2 snapshots on the VM to build our own dataset is possible later. It would take months and the VM's CPU is tiny, so it is not proposed now.

### 1.3 Derivatives data (funding, open interest, liquidations)

- **Mechanism: the strongest of the four.**
  - Leveraged perpetual-futures positions are closed **by force** when margin runs out.
  - A liquidation cascade is price-insensitive selling: the seller has no view and simply must sell.
  - The theory of liquidity spirals (Brunnermeier & Pedersen 2009) and the returns to liquidity provision when liquidity evaporates (Nagel 2012) both predict a temporary **overshoot** followed by partial reversion.
  - The traders who absorb forced selling are paid for it. Spot buyers can take that side **long-only, without leverage**, which fits our venues.
- **Funding rate.**
  - Funding mostly echoes past returns: high funding means longs are crowded.
  - Its predictive power for later returns is weak and mixed in published work.
  - It is better used as context than as a trigger, so it is not part of the rules here (see 2.7).
- **Open interest (OI).**
  - A sharp **drop in OI during a sharp price drop** is the fingerprint of a long liquidation, as opposed to ordinary informed selling. In ordinary selling OI is flat or rising, because new shorts are opening.
  - This is exactly the information our failed price-only flush rules lacked.
- **Counter-evidence (reported via a second reviewer, not verified by us).** An exploratory Hyperliquid study, corrected after look-ahead errors, associates large OI contractions with *deeper* displacement and *slower* recovery over four months. That is the main way this hypothesis fails. It is why a deleveraging event only ARMS the setup and never triggers a buy by itself, and why control C2 exists.
- **OI data quality.** A study of seven derivatives exchanges reported implausible OI figures on some venues. Stage 0 therefore flags 5-minute OI jumps over 10% that reverse within 15 minutes, as a count only.
- **Liquidation feeds.** Not free historically (Binance's liquidation snapshots are no longer published; Coinglass is paid). The OI drop is our proxy.
- **Size: large.** Cascades move BTC and ETH several percent within an hour, so a structural stop is wide and costs are a small fraction of R.
- **Testability: yes, free.** Probe of 2026-10-04 on data.binance.vision:

  | Data | Coverage |
  |---|---|
  | BTCUSDT perp OI, 5-minute | 2020-09-01 to 2026-10-03, 2,224 daily files, no missing days (some 2020-21 days have duplicate rows to drop) |
  | ETHUSDT perp OI, 5-minute | from 2021-12-01 only |
  | Funding | from 2020-01 |
  | Perp 5m klines | from 2020-01, with taker-buy volume |
  | Spot 5m klines | from 2017-08 |
  | Liquidation snapshots | none |

- **Usability: yes.**
  - Cascades unfold over 30 minutes to hours, so an alert followed by a click within minutes is not too late.
  - Risk: Binance's live futures API returns **HTTP 451 from the US**.
  - OKX (global), Kraken Futures and Deribit public OI endpoints answered HTTP 200 from this PC.
  - A live version would therefore read OI from a different venue than the backtest. That is a deployment risk, handled in 3.9, and it does not block the research.

**Verdict: chosen as the primary mechanism.**

### 1.4 Volume delta and CVD (aggressive flow)

- **Mechanism: partly.**
  - Taker-buy minus taker-sell volume (CVD) shows who is crossing the spread.
  - It moves almost one-for-one with price in the same bar, so as a *predictor* it is weak.
  - "CVD divergence" setups are folklore with no robust published evidence.
- **Useful role: an exhaustion gauge.**
  - During a cascade, taker selling dominates.
  - When aggressive selling stops dominating while price holds above the low, the forced flow has probably finished.
  - This uses CVD for what it measures (who is aggressing now), not as a forecast.
- **Testability: yes.** Binance perp and spot klines carry taker-buy volume per bar, which gives bar-level CVD for free. Coinbase candles have no aggressor field.
- **Possible refinement, not used:** perp-led selling against steady spot buying (a leverage flush rather than spot distribution). It is left out to limit the degrees of freedom and recorded in 2.7.

**Verdict: used inside the trigger (exhaustion), not as a standalone signal.**

### 1.5 Time of day and session effects

- **Mechanism.** Volume and volatility seasonality are clear in BTC (e.g. Eross, McGroarty, Urquhart & Wolfe 2019, intraday bitcoin dynamics). Activity concentrates in:
  - the US equity overlap, about 13:30-16:00 UTC;
  - around 00:00 UTC;
  - around the funding times, 00:00 / 08:00 / 16:00 UTC on Binance.
  Weekends are thinner.
- **Size: fails as an edge on its own.** Hour-of-day *return* effects reported in studies are a few basis points and unstable across years, far below a 0.2%+ round trip.
- **Weekend gaps.** "CME gap fills" are survivorship folklore.
- **Useful role: description.**
  - Thin weekend and Asia-session books may make cascades overshoot more. That is a plausible hypothesis for the future, recorded in 2.7.
  - To avoid adding a free parameter, the rules have **no** time filter. Results are reported by session as description only.

**Verdict: no time-based rule; stratified reporting only.**

### 1.6 Summary

| Area | Mechanism | Beats costs | Free history | Fits manual radar | Use |
|---|---|---|---|---|---|
| Order book | yes | no | no | no | stop placement only |
| Funding / OI / liquidations | yes | yes | yes (OI, funding) | yes | **primary signal** |
| CVD / taker flow | weak as a predictor | n/a | yes | yes | exhaustion trigger |
| Time of day | volume only | no | yes | yes | reporting only |

**Honest prior:** every pre-registered test in this project so far has failed (Phases 87, 89, 89b and 90). The most likely outcome of this one is also FAIL. Freezing the rules first is what makes a FAIL informative instead of an invitation to re-tune.

---

## Part 2: Strategy proposal: Leverage Flush Reversion (LFR)

### 2.1 The "why"

- When an OI drop and a price drop coincide, leveraged longs are being liquidated: forced, price-insensitive sellers.
- Their selling pushes price below where informed traders value it. Once the forced flow is exhausted, price partially reverts.
- We buy spot after the forced selling stops, put a stop just under the forced low, and target part of the move back.
- **What would show it is false:** the rule does no better than the same rule without the OI condition (control C2, 3.6).

### 2.2 The "what"

- **Coins:** BTC and ETH, spot, long only, no leverage. No alts.
- **Intended execution pairs: OKX US BTC-USDC and ETH-USDC**, bought with USD or USDC.
  - This is the book SignalDesk's router uses for BTC-USD / ETH-USD: OKX US lists no -USD book, and these settle in USD / USDC / USDG / RLUSD.
  - The -USDT books are not intended: they settle only in USDT.
- **Data roles:**
  - Signals: Binance USD-M perp OI in **coins** (`sum_open_interest`; the USD value falls with price on its own) and perp taker-buy volume.
  - Prices, fills, ATR and levels in the **screening** stage: Coinbase BTC-USD / ETH-USD 1-minute candles.
  - The OKX-specific checks are in 3.7.

### 2.3 Bars, data timing and statistics

- **Bars.**
  - Coinbase 1-minute candles are UTC and stamped at their start.
  - A 5-minute bar is built from its 1-minute bars and needs at least 3 of 5. A 1-hour bar needs at least 45 of 60.
  - Open = the first present open; close = the last close; high / low = the extremes.
- **Decision time.** D = C + 60 s, where C is a 5-minute close. At D only these may be used:
  - Coinbase bars ending at or before C;
  - Binance perp 5-minute klines ending at or before C;
  - Binance OI rows with `create_time` at or before **C - 5 min**. Its timestamp convention is unverified, so a row may describe the 5 minutes after its stamp.
- **r60(C)** = ln(Coinbase close at C / close at C - 60 min).
- **oi60(C)** = ln(OI of the latest usable row / OI of the row 60 minutes before it).
- **Percentile threshold q2(x, C):**
  - It is the value at rank ceil(0.02 x n) among the n values of x at every 5-minute close in (C - 90 days, C - 5 min].
  - It needs n of at least 95% of 25,920; otherwise no ARM at C.
- **ATR:** Wilder ATR(14) on Coinbase 1-hour bars.
  - TR = max(H - L, |H - previous close|, |L - previous close|), seeded with the mean of the first 14 TRs in the warm-up.
  - The last hour ending at or before C is used, **frozen at the ARM** (ATR_arm).

### 2.4 Setup (ARM) and trigger

- **ARM** at a 5-minute close C when **all** hold:
  1. r60(C) <= q2(r60, C) (price flush);
  2. oi60(C) <= q2(oi60, C) (leverage wipeout);
  3. no open position, no active ARM, and no cooldown on that coin;
  4. the UTC day passes the data-coverage check (3.3);
  5. C is at least 17 hours before its window's end (4 h armed + 1 min + 12 h hold + margin).
- **Levels at the ARM:**
  - H = the highest Coinbase 1-minute high in [C - 60 min, C).
  - L = the lowest 1-minute low from C - 60 min onward, updated at every 5-minute close while armed and frozen at the trigger.
- **TRIGGER** at the first later 5-minute close C' with C < C' <= C + 4 h where:
  1. **Exhaustion (CVD).** Taker-buy base volume divided by volume, summed over the 3 perp 5-minute klines ending at C', is at least 0.50.
  2. **Reclaim.** The Coinbase 5-minute close at C' is at least L + 0.5 x ATR_arm.
  3. **No new low.** Every 1-minute low in (C' - 15 min, C'] is above L, so L was set at or before C' - 15 min.

  Then, with E_est = the close at C', stop S = L - 0.25 x ATR_arm and the configuration's target T:
  4. **Geometry.** T - E_est must be at least 1.0 x (E_est - S). Otherwise the ARM ends as SKIPPED (counted).
- **Expiry and cooldown.**
  - No trigger by C + 4 h: the ARM ends as EXPIRED.
  - After an ARM ends (trigger, skip or expiry), no new ARM on that coin for 6 hours, nor while its position is open.
  - BTC and ETH may hold positions at the same time.

### 2.5 Execution, sizing and exits (primary model: every fill is taker)

Symbols: h = half-spread, e = adverse slippage on entry / target / time fills, s = adverse slippage on stop fills, f = taker fee. Values are in 2.6.

- **Entry.** A market buy at D = C' + 60 s.
  - Fill E = (open of the Coinbase 1-minute bar starting at C' + 1 min) x (1 + h + e).
  - If E <= S, the trade is skipped (NO_ROOM). Entry fee = f x E x qty.
- **Sizing** (fixed dollar risk, no compounding):
  - Starting equity is $10,000. S_x = S x (1 - h - s) is the stop's fill price.
  - Planned loss per unit PLU = (E - S_x) + f x E + f x S_x.
  - qty = $100 / PLU: 1% of starting equity at risk, costs included.
  - Notional (qty x E) is capped at $10,000 minus the other coin's open notional. If the cap binds, qty is reduced (counted).
  - **R_net = net P&L / (qty x PLU)**, so 1R = the planned loss including costs. A gap can make a loss worse than -1R.
- **Exits,** checked on every Coinbase 1-minute bar from the entry bar onward (after its open):
  - **Stop:** a bar's low <= S. Exit X = min(S, that bar's open) x (1 - h - s).
  - **Target:** a bar's high >= T x (1 + h), meaning the bid reached T. Exit X = T x (1 - e), a market sell (all-taker).
  - A bar touching both counts as the **stop**.
  - **Time stop:** the first bar starting at or after the fill + 12 h. Exit X = its open x (1 - h - e).
  - Exit fee = f x X x qty.
  - Missing 1-minute bars: the next present bar's open is used, with the gap-through rule. A trade is never dropped once entered.
- **Targets** (the only difference between the two configurations):
  - **A:** T = L + 0.5 x (H - L), the 50% retrace of the flush.
  - **B:** T = H, where the cascade started.
- **Stop ratchet: not in the primary model.**
  - In SignalDesk the ratchet (ratchet.js) is *offered*, and the user applies it with one click. It is not automatic.
  - For reference only, a "ratchet taken at first touch" variant is reported, never as a verdict, using the app's exact rule (R_px = E - S, triggers at the bid, applied from the next bar):
    - step A at E + 1.0 R_px moves the stop to the fee break-even E x (1 + f) / (1 - f), plus 0.05 R_px;
    - step B at E + 1.5 R_px moves the stop to max(E + 0.5 R_px, step A's stop + 0.1 R_px).
- **Maker-entry variant (reported only, cannot rescue a failed primary):**
  - A post-only buy at the trigger close, filled only when a later 1-minute bar trades strictly below it by at least 0.01% within 30 minutes; otherwise unfilled.
  - Maker fee, all other legs unchanged. Its fill rate and the missed trades' outcomes are reported.

### 2.6 Costs

**Fee provenance:** verified 2026-10-04 / 05 from authenticated read-only account fee responses. Evidence: `docs/research/phase92-fee-verification.md`, added by the fee / routing PR. All four OKX BTC / ETH books, USDC and USDT, are in fee group 12.

| Venue | Maker / taker |
|---|---|
| OKX US BTC-USDC / ETH-USDC, Lv1 | 0.20% / 0.35% |
| Kraken | 0.40% / 0.80% |
| Coinbase Intro | 0.50% / 0.90% |

The rates are re-read immediately before the replay. Any change is recorded, and the then-verified OKX taker becomes f.

| Scenario | f per fill | Fees on a round trip | h | e | s | Role |
|---|---|---|---|---|---|---|
| **Primary (base)** | **0.35%** | about **0.70%** | 0.01% | 0.02% | 0.05% | pass / fail |
| **Stress** | **0.525%** (1.5x) | about 1.05% | 0.05% | 0.05% | 0.15% | must stay PF > 1.0 |
| Kraken, all-taker | 0.80% | about 1.60% | 0.01% | 0.02% | 0.05% | reported only |
| Coinbase Intro, all-taker | 0.90% | about 1.80% | 0.01% | 0.02% | 0.05% | reported only |

**All-in round-trip cost of a stopped trade** = fees + 2h + e + s:
- primary: about 0.70 + 0.02 + 0.02 + 0.05 = **0.79%**;
- stress: about 1.05 + 0.10 + 0.05 + 0.15 = **1.35%**.

With R typically 1-2% of price, that is 0.4-0.8R (primary). **This hurdle is the main reason the hypothesis may fail.**

**What the earlier "0.62%" meant.** It was the previous draft's maker-entry trade: 0.20% maker entry + 0.35% taker stop + 2 x 0.01% half-spread + 0.05% stop slippage. That model is now only the reported maker variant. The primary all-taker figures above replace it.

### 2.7 Deliberately left out

Recorded for possible future tests, each with its own frozen protocol:
- funding-extreme filters;
- the spot-vs-perp CVD divergence;
- a weekend / Asia-session filter;
- short squeezes (no shorting on spot);
- alts;
- any order-book signal;
- machine learning and parameter searches.

---

## Part 3: Frozen validation protocol

### 3.1 What counts as seen

- Crypto **price** windows this project has already examined:
  - 2022-01 to 2023-12 (protocol 2B);
  - 2024-10 to 2026-10 (the Phase 89 15-coin diagnostic);
  - 2026-03 to 2026-09 (Moonshots);
  - Phase 78's 2 x 90 days.
- **No OI or funding data has ever been downloaded or examined.**
- Never examined: 2020-09 to 2021-12, and 2024-01 to 2024-09 (kept unseen in phase89-results section 11).

### 3.2 Windows, per coin, with warm-ups

**No-leak rule:** no computation for a development trade may read data from a validation window, warm-ups included. Validation warm-ups may read development data.

| Window | Role | Coin | Warm-up (thresholds + ATR, no trades) | Trade window | Trade months |
|---|---|---|---|---|---|
| D1 | development | BTC, ETH | 2022-01-01 .. 2022-03-31 | 2022-04-01 .. 2023-12-31 | 21 |
| D2 | development | BTC, ETH | 2024-10-01 .. 2024-12-29 | 2024-12-30 .. 2026-09-30 | 21 |
| V1 | **validation** | **BTC only** | 2020-09-01 .. 2020-11-29 (Binance OI starts 2020-09-01) | 2020-11-30 .. 2021-12-31 | 13 |
| V2 | **validation** | BTC, ETH | 2023-10-03 .. 2023-12-31 (D1 data: allowed) | 2024-01-01 .. 2024-09-30 | 9 |

**Holdout per coin:**
- **BTC 22 months** (V1 + V2).
- **ETH 9 months** (V2 only). ETH's OI starts 2021-12-01, so a 90-day warm-up ends 2022-03-01, inside D1. No ETH data before 2022-01-01 is read.
- ETH falls short of the 12-month minimum, so **BTC is the primary historical validation asset and ETH is exploratory** (3.5). ETH can qualify only through the forward test (3.7 X2), over at least 12 months of forward data.

**Ends of windows:**
- Development trades never read beyond their window's end: no ARM later than end - 17 h.
- Validation trades may exit into the following days. Those belong to seen development data, so that is allowed.

### 3.3 Stage 0 checks (before any outcome is computed)

1. **Coverage, per coin and window.**
   - At least 98% of Coinbase 1-minute bars, Binance perp 5-minute klines and OI rows must be present.
   - A UTC day under 95% (any source) allows no new ARM, but open trades continue.
   - Duplicate OI rows are dropped (the first per `create_time` kept).
2. **OI data health.** Count 5-minute OI jumps over 10% that reverse within 15 minutes. If they occur on more than 0.1% of bars, the study stops as untrustworthy data.
3. **Event count on DEVELOPMENT only**, counting ARMs and TRIGGERs, never their outcomes.
   - Fewer than 60 triggers across D1 + D2: both ARM percentiles switch to the **5th**. This is the only fallback, decided by the count alone.
   - Still fewer than 60: **INCONCLUSIVE**.
4. **Fees and hashes.** Re-read the venue fees. Record the script and data hashes before stage 1 runs.

### 3.4 Configurations and selection

- **Two configurations, A and B** (2.5). Nothing else varies. Bonferroni: one-sided alpha 0.05 / 2 in development.
- Both run on development.
  - If **both** pass every development row in 3.5, select the higher bootstrap lower bound of mean R_net.
  - If the bounds are within 0.005R, take the higher PF. If still tied, take A.
  - If **one** passes, it is selected. If **none** passes, the study is FAILED.
- **Only the selected configuration** is run on validation, once. The other is never run on V1 / V2.

### 3.5 Pass / fail thresholds: the economic standard (primary costs unless stated; every row must pass)

**Which asset is judged where:**
- **Development** pools BTC and ETH (42 trade-months each) and also requires each coin to pass on its own.
- **Validation is judged on BTC only.** BTC is the primary historical validation asset: 22 holdout months.
- **ETH validation is exploratory.** It is V2 only, 9 months. It is computed and reported with every metric below, but it is never a verdict.
  - ETH can qualify only through the forward test (3.7 X2).
  - That forward test must also meet the original requirement of **at least 12 months of genuinely unseen validation**: 12 months of forward data, not counting the 9 historical months.
- **Combined BTC + ETH portfolio results are descriptive only,** until both assets have met the full standard.

| Metric | Development (D1 + D2, BTC + ETH) | Validation (V1 + V2, **BTC**, run once) |
|---|---|---|
| Trades | at least 60 | at least 30 BTC trades (fewer: INCONCLUSIVE, which counts as a fail) |
| Profit factor (sum of winning R_net / sum of losing R_net) | at least 1.25 | at least 1.25 |
| Mean R_net per trade | at least +0.10R | at least +0.10R |
| Day-block bootstrap lower bound of mean R_net | > 0 at one-sided 0.025 | > 0 at one-sided 0.05 |
| Random-entry control C1 | mean above its 95th percentile | the same |
| Price-only control C2 | mean R_net above C2's | the same |
| Per coin | PF > 1.0 on BTC and on ETH | BTC is the verdict; ETH exploratory, reported |
| Per segment | PF > 1.0 in D1 and in D2 | PF > 1.0 in V1 and in V2 |
| Stress costs (2.6) | PF > 1.0 | PF > 1.0 |
| Max drawdown (cumulative R_net, in close order) | at most 12R | at most 12R |
| Concentration | no single trade over 25% of total net R; PF > 1.0 without the 3 best trades | the same |

The validation column is the **economic standard**. 3.7 reuses it unchanged for the OKX re-simulation, and per asset for forward qualification.

**Reported, never a verdict:**
- the maker variant and the ratchet variant;
- Kraken and Coinbase fees;
- ETH's validation metrics and the combined portfolio;
- per session (Asia 00-08, Europe 08-13:30, US 13:30-21, late 21-24 UTC; weekend vs weekday) and per year;
- exit reasons, hold times and R in % of price;
- skipped / expired / NO_ROOM / cap-reduced counts;
- notional vs the entry bar's 1-minute dollar volume;
- BTC-ETH overlap;
- % equity drawdown ($100 per R on $10,000).

### 3.6 Controls and statistics

- **C1, random entry.** For every actual trade, 50 seeded draws (seed 92).
  - Each takes a random 5-minute close of the same coin and UTC month, outside that coin's actual holding periods.
  - Entry as in 2.5 (taker at the next 1-minute open). Stop and target at the actual trade's planned distances, as fractions of E.
  - Same costs and 12 h time stop.
  - Statistic: the mean R_net of each of the 50 sets. The actual mean must exceed the 48th smallest.
- **C2, price-only.** The identical rules and costs without ARM condition 2 (OI). This is the mechanism test.
- **Bootstrap.**
  - UTC-day blocks over every day of the trade windows, including days with no trades. 10,000 resamples, seed 92.
  - Statistic: the mean R_net of the resampled trades. Resamples with no trades are dropped and counted.
- In validation, C1, C2 and the bootstrap use the **BTC** trades; ETH's are computed the same way and reported.

### 3.7 Screening label, OKX re-simulation (X1) and forward qualification (X2)

- **Everything in 3.5 is labelled "PRELIMINARY SCREENING (Coinbase prices, verified OKX US fees)".** A screening pass is not a claim that LFR is executable on OKX.

**X1: OKX historical re-simulation.** Run once, right after a screening validation pass, on the frozen selected configuration.

- **A complete re-run of the rules on OKX's price path, not a repricing of the screening trades.**
  - Every price input comes from OKX 1-minute candles: r60, ATR, H, L, the reclaim, the entry fill, stops, targets, time exits and the gap-through rule.
  - The Binance OI and taker-flow inputs are unchanged.
  - The OKX run therefore makes its own trades, which may differ from the screening ones.
- **Unchanged from screening:** costs (0.35% / stress 0.525% per fill, the same h / e / s), windows, warm-ups, the no-leak rule, the Stage 0 coverage rules (applied to the OKX candles), and controls C1 / C2 (re-run on the OKX path).
- **Markets:** BTC-USDT and ETH-USDT, labelled **"USDT PROXY for the intended BTC-USDC / ETH-USDC markets"**. The USDC books' candle history starts about 2025-08-21, so they cannot cover V1 / V2.
- **Pass:** the **full economic standard of 3.5's validation column, unchanged, on BTC.** ETH is reported, exploratory.
- **Reported only, never a substitute for the economic standard:**
  - matching against screening: the share of screening trades the OKX run also took, and the R_net correlation of matched trades;
  - the USDC-vs-USDT gap (median and 99th percentile of the 1-minute close difference) over 2025-08-21 .. 2026-09-30;
  - the selected configuration re-run on the real BTC-USDC / ETH-USDC books over that same period. It is development-era data, so this is descriptive only.

**X2: OKX forward paper test.** After a separately approved radar build.

- **Recording.** OKX US BTC-USDC / ETH-USDC best bid / ask every 5 s from the public market-data API.
- **Shadow outcomes.**
  - Every alert the radar raises gets a shadow paper outcome under the 2.5 rules, filled on the recorded quotes: buy at the ask at D, sell at the bid when an exit triggers, plus 0.35% per fill.
  - This applies whether or not the user approves it, so the test measures the strategy rather than the user's choices.
  - The approved trades are reported separately.
- **Operational checkpoint at 6 months AND 20 trades (pooled). It is not a profitability test.** It checks:
  - the data feeds were up at least 99% of the time;
  - every alert was recorded with its quotes;
  - the live signals match an offline recomputation of the same rules on at least 95% of alerts;
  - median realized slippage vs the 2.5 model is within the stress allowances;
  - no rule was violated.

  Failing the checkpoint pauses the forward test for repair, and the trade count restarts.
- **Qualification, for each asset separately (no pooling).** All of these must hold:
  - at least **40 forward trades** for that asset (shadow outcomes, every alert);
  - PF at least 1.25 and mean R_net at least +0.10R;
  - day-block bootstrap lower bound of mean R_net > 0 at one-sided 0.05;
  - PF > 1.0 at stress costs re-applied to the recorded quotes (0.525% per fill + stress slippage);
  - max drawdown at most 12R, and the 3.5 concentration rule;
  - median realized entry / exit slippage within the stress allowances.

  If 40 trades are not reached within 24 months of the radar's start, that asset is **INCONCLUSIVE**.
- **What qualifies each asset:**
  - **BTC:** screening validation pass + X1 pass + X2 qualification.
  - **ETH:** development pass + X2 qualification over **at least 12 months of forward data** (genuinely unseen). The 9 exploratory historical months do not count toward the 12. So ETH cannot qualify sooner than 12 months after the radar starts, even with 40 trades; with fewer than 40 trades by 24 months it is INCONCLUSIVE.
- **Claims and trading.** The combined portfolio stays descriptive until both assets qualify. "Executable on OKX US" may be claimed only for a qualified asset. Trading stays paper (`risk/paper-lock.js`) until a separate decision.

### 3.8 After the verdict

- **Fail** at any stage:
  - LFR is not built.
  - No re-tuning on these windows.
  - Crypto stays manual-only.
  - A new idea needs its own protocol and data this test did not touch.
- **BTC passes screening validation and X1:** the next step is a separately approved radar-alert scanner (paper, manual approval), which X2 then runs on. Its evidence labels:
  - BTC "Screened · OKX forward test pending";
  - ETH "Exploratory · forward test pending".

### 3.9 Known risks, stated now

- **Live OI source.** Binance's futures API is blocked from the US (HTTP 451, checked 2026-10-04). OKX (global), Kraken Futures and Deribit public endpoints answered.
  - Before any build: a 30-day side-by-side record of the live source vs Binance's published files.
  - The 2nd-percentile ARM events must agree on at least 80% of days with an event.
- **Rare events.** About 60 trades means wide confidence bands. The bootstrap bound and the concentration rule exist for that reason.
- **Knowledge contamination.** I know 2020-21's broad history (e.g. 2021-05-19) as general knowledge. The rules were fixed before any OI value or count was seen.
- **Model limits.**
  - Candles are not the book, and cascades can slip more than the stress allowance.
  - USDC is treated as USD in screening.
  - Hence X1 (a full re-simulation on OKX prices, USDT proxy) and X2 (forward, real USDC quotes).
