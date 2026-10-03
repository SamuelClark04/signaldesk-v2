# Phase 89 research protocol (FROZEN before any replay was run)

Frozen: 2026-10-03, before any Quick Flips or BTC / ETH crypto replay was run. The file's SHA-256 is written in
`phase89-results.md` and in the commit that adds it. Any rule changed after a result was seen needs a NEW, unseen window.
Results are labelled **PRELIMINARY**: no historical option bid / ask quotes exist in our data (see Data).

## 0. Data availability (checked 2026-10-03, before the protocol was written)

| Need | Source | Available? |
|---|---|---|
| SPY / QQQ 1-minute bars, consolidated volume | Alpaca `/v2/stocks/bars?feed=sip` | yes, 2016+ (the last 15 minutes are not served on the free plan) |
| Option 1-minute bars (trade prints: o/h/l/c, volume, VWAP, trade count) | Alpaca `/v1beta1/options/bars` | yes, from **February 2024** only |
| Historical option bid / ask quotes | Alpaca `/v1beta1/options/quotes` | **no** (HTTP 404). Only the latest quote / snapshot |
| Live option quotes used by the app | Alpaca `indicative` feed | yes, but **not** OPRA NBBO: Alpaca describes it as a free derivative of OPRA; trades delayed 15 min. A deep-ITM SPY call showed a $4.61-wide indicative spread on 2026-10-02 |
| BTC-USD / ETH-USD 15m and 1h candles | Coinbase Exchange public candles | yes, years back |
| Historical crypto order books / spreads | none free | **no**: spreads are cost scenarios |

Consequences: option P&L is computed from trade prints plus predefined spread scenarios, never from bar highs / lows;
crypto maker fills are modelled conservatively (below). Every result is PRELIMINARY until forward paper trading with
real fills confirms it.

## 1. Options "Quick Flips" (intraday, single-leg, paper only)

### 1.1 Universe, windows, timestamps
- Symbols: SPY, QQQ. Nothing else in this phase.
- Development (in-sample) window: sessions 2024-02-05 to 2025-05-30. **Validation (unseen)**: 2025-06-02 to 2026-10-01,
  run ONCE, and only for configurations that pass development.
- Times are New York time (DST-aware). A bar is stamped with its START; it is known at its END (start + duration).
- Regular session only (09:30-16:00). Half-days (no bar after 13:05) and sessions with fewer than 370 of 390 underlying
  1-minute bars are skipped entirely (missing data).

### 1.2 Calculations (from SIP 1-minute bars)
- 5-minute bars: 09:30-09:35, ... aggregated from 1-minute bars (open of the first, close of the last, max / min, summed volume).
- VWAP: session-cumulative sum(typical x volume) / sum(volume) from 09:30, typical = (h + l + c) / 3, on 1-minute bars.
- EMA20: 20-period EMA of 5-minute closes, continuous across sessions (needs 20 prior bars).
- Opening range (OR): high / low of 09:30-09:45 (first three 5-minute bars).
- Relative volume (RelVol) of a 5-minute bar = its volume / the mean volume of the SAME time-of-day slot over the prior
  20 sessions (fewer than 20 prior sessions: no signal).
- FOMC days (2024: Jan 31, Mar 20, May 1, Jun 12, Jul 31, Sep 18, Nov 7, Dec 18; 2025: Jan 29, Mar 19, May 7, Jun 18,
  Jul 30, Sep 17, Oct 29, Dec 10; 2026: the app's macro-events list): no entries from 13:30.

### 1.3 Setups (both directions: calls for long, puts for short), checked on each 5-minute close
- **S1 ORB + VWAP.** Bars closing 09:50-11:30. Long: close > OR high, close > VWAP, RelVol >= 1.2, and it is the
  first 5-minute close above the OR high today. Short: mirrored (close < OR low, < VWAP). Skip the day's S1 when the OR
  width > 1.0% of the 09:30 open. One S1 long and one S1 short per symbol per day at most.
  Trigger level: OR high (long) / OR low (short).
- **S2 VWAP-trend pullback.** Bars closing 10:00-14:30. Long: EMA20 > VWAP, EMA20 now > EMA20 three bars ago, one of
  the last 3 bars (this one included) traded at or below EMA20 x 1.0005, this bar closes above EMA20, above the prior
  bar's high and above VWAP, RelVol >= 1.0. Short: mirrored. Trigger level: EMA20.
- Same bar fires S1 and S2: S1 wins.
- **Confirmation (decision time D = signal bar end + 60 s):** the underlying's last 1-minute close at D must still be
  beyond the trigger level (long: above), else skip ("confirmation failed").
- **Setup failure** (exit rule): a 5-minute close back through the session VWAP (long: below VWAP; short: above).

### 1.4 Contract selection and liquidity
- Expiration: listed expirations with 3 to 7 calendar days to expiry (DTE counted from the trade date); the one closest to
  5 DTE, ties to the shorter. Never 0-2 DTE.
- Strike ($1 strikes): call = highest strike <= spot at D; put = lowest strike >= spot at D (at / slightly in the money).
- A candidate contract with no 1-minute bars that day is replaced by the next candidate expiration; none: skip.
- Liquidity proxy (no historical quotes): at least 5 one-minute bars with trades in the 10 minutes before D and at least
  100 contracts traded in the 30 minutes before D; premium >= $0.50. Else skip.

### 1.5 Execution model (matches the intended live implementation)
- Entry: a buy at D. Fill = VWAP of the first option 1-minute bar starting at or after D, plus the half-spread H.
  No bar within 3 minutes: entry timed out and canceled, no retry of that signal ("unfilled").
- Exits are decided on completed 1-minute bars (never on a high / low):
  - **Stop**: option bar CLOSE <= fill x (1 - stop%) -> sold at the NEXT bar's open - H (a gap fills worse; a -30% stop
    is not a guaranteed maximum loss).
  - **Target**: a resting sell at fill x (1 + target%), counted as filled only when a later bar's VWAP >= the target
    (filled at the target). A bar that triggers the stop (close) and the target (VWAP) counts as the stop.
  - **Setup failure** (S1 / S2 rule above): sold at the next option bar's open - H.
  - **Max hold**: sold at the open of the first bar at or after fill + max-hold minutes, - H.
  - **Deadline 15:45**: anything open is sold at the 15:45 bar's open - H. Never held overnight.
  - Missing option bars: the next available bar is used (the delay is the gap); no bar until 15:59: sold at the last
    trade price - 2H, flagged "illiquid exit".
- Costs: $0.65 per contract per fill (the app's options commission model) plus H on each fill.
- Cost scenarios (H = half the bid / ask spread, per contract-share):
  **O** optimistic H = $0.01 · **B** base H = $0.03 · **S** stress H = $0.06 and an extra 60 s delay (D + 120 s).
- One open Quick Flip per symbol; at most 2 open (SPY + QQQ are highly correlated: see statistics). At most 3 entries per
  symbol per day; 15-minute cooldown after any exit on a symbol; after a stop-out no new entry in that direction on that
  symbol that day. Daily loss: no new entries after -2R realized in the day. Zero-trade days are normal.
- Sizing in the replay: 1 contract. R = the planned stop loss of that configuration (stop% x fill x 100).

### 1.6 Exit configurations (declared; V1 is the user's candidate)
- **V1**: stop -30%, target +45%, max hold 60 min, setup-failure exit on.
- **V2**: stop -20%, target +30%, max hold 30 min, setup-failure exit on.
- **V3**: stop -30%, target +45%, max hold 90 min, setup-failure exit OFF (does the failure exit help?).
Six configurations (S1, S2 x V1-V3) are judged on development; reported also with S1 + S2 combined.

### 1.7 Controls and statistics
- **Random-entry control**: for every real trade, 20 seeded draws (seed 89) of an entry at a random 5-minute close inside
  the same setup's window, same symbol / day / direction, same contract rule, costs and exits. The real mean must exceed
  the control distribution's 95th percentile.
- **Reversed control**: the same signal times with the opposite option type.
- Bootstrap: 5,000 resamples of whole DAYS (SPY and QQQ trades of a day move together: correlation kept), one-sided lower
  bound of mean R. Bonferroni over the 6 development configurations (alpha 0.05 / 6).
- Reported: trades, win %, average winner / loser, PF, mean and total R and $, max drawdown, holding time, results by
  symbol, setup, month, exit reason and market condition (gap terciles; prior 20-day realized vol terciles; trend vs
  range day), the daily P&L distribution and the share of zero-trade days, unfilled / skipped counts by reason.

### 1.8 Pass criteria (base costs B)
- Development: >= 80 trades; PF >= 1.20; bootstrap lower bound of mean R > 0 at alpha 0.05 / 6; beats the random control's
  95th percentile; PF > 1.0 on SPY and on QQQ separately; max drawdown < 15R; PF > 1.0 under stress costs S.
- Validation (only configurations that passed): PF >= 1.15 (B), PF > 1.0 (S), mean R > 0, PF > 1.0 in both halves.
- Fail anywhere: Quick Flips stays OFF by default. No re-tuning on these windows. A new idea needs new, unseen data
  (forward paper trading counts as new data).

## 2. Crypto (BTC-USD, ETH-USD), spot, no leverage

### 2.1 Data, windows
- Coinbase Exchange candles, 15m and 1h. Development 2024-10-01 to 2025-09-30; **validation (unseen)** 2025-10-01 to
  2026-10-01, run once, only for configurations that pass development. Warm-up bars before each window.

### 2.2 Strategy under test
- The live **Crypto Intraday** rules, unchanged: `crypto-intraday-signals.detectAll` (squeeze, sweep, range failure,
  EMA21 / 24h-VWAP reclaim, priority in that order) on completed bars, the live gates (chart stop under structure, the
  routed venue's fee floor, T1 2.3R 50% / T2 3R, hourly then daily resistance snap, 1x daily-ATR cap, the risk engine's
  fee-drag and T1 net R:R gates). Paths **P15** (15m) and **P1h** (1h) replayed separately.
- (Crypto Swing 4h is already OFF after the Phase 78 replay and is not retested here.)

### 2.3 Execution model
- Decision at the signal bar's close + 60 s. Live places a POST-ONLY buy at the best bid (capped at the zone top):
  modelled as a limit at the next bar's open - half-spread; **filled only if a later bar trades STRICTLY below the limit
  by at least 0.01%** within 2 bars (15m) / 1 bar (1h) (~30 min, the reconciler's cancel); else **unfilled** (counted).
  A filled post-only entry pays the maker fee. (Variant check: market entry at the next open + half-spread, taker fee.)
- Stop: taker, at the stop or the bar's open when it gapped through, minus half-spread. Targets: resting maker limits,
  filled only when a bar trades STRICTLY above the target by 0.01%. A bar touching stop and target counts as the stop.
- Venue fee scenarios (maker / taker): **OKX US 0.08% / 0.10%** (the router's first venue), **Kraken 0.25% / 0.40%**,
  **Coinbase Intro 0.60% / 1.20%**. Half-spread: base 0.01%, stress 0.05% (+ the 60 s delay on every leg).
- Holding rules (declared): **H0** the live rule (no time exit: stop / targets only); **H1** time exit after 24 bars
  (6 h on 15m, 24 h on 1h) at taker.
- One position per symbol per path; daily risk reset at 00:00 New York: no new entries after -3R realized that day.

### 2.4 Controls, statistics, pass criteria
- Random-entry control (same count per symbol / path / month, same stop and target distances in R, seed 89); buy-and-hold.
- Day-block bootstrap as above; Bonferroni over 4 development configurations (P15 / P1h x H0 / H1).
- Development pass (OKX fees, base spread): >= 40 trades; PF >= 1.20; bootstrap lower bound > 0 at alpha 0.05 / 4; beats the
  random control's 95th percentile; PF > 1.0 on BTC and ETH separately; PF > 1.0 at Kraken fees.
- Validation: PF >= 1.10 (OKX, base), PF > 1.0 (stress), both halves PF > 1.0. Fail: the strategy stays paused / off.

## 3. Forward paper validation (after any historical pass)
Paper only, real quotes and fills (Alpaca Paper for options; the crypto paper fill uses the ask and the taker fee). At least
40 trades / 4 weeks before any discussion of real money; compare live paper fills with the replay's cost scenario.
