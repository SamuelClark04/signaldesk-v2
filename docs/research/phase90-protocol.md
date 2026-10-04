# Phase 90 research protocol (FROZEN before any replay was run)

Frozen: 2026-10-04, before any data of the windows below was evaluated (only an availability probe: bar counts for one day). The
commit that adds this file is the proof of the freeze. Any rule changed after a result is seen needs a NEW, unseen window.

## A. Equity Swing and Equity Day (ORB): the live rules on UNSEEN data

### A.1 Why a new window
Phase 88 replayed both on 2024-10-02 .. 2026-10-02 (Equity Swing PF 0.81; ORB PF 1.08, not significant). That window has been seen:
running it again only repeats those numbers. The strict test is the same rules on the two years BEFORE it.

### A.2 Rules, data, window
- Rules: the live rules exactly as the in-app backtest replays them (server/backtest/engine.js + rules-stocks.js, unchanged since
  b24e750: `git diff b24e750 HEAD -- server/backtest server/strategies/1-equity-day.js server/strategies/3-equity-swing.js server/risk`
  is empty), Moderate strictness, long only, stop / two targets, nothing closes on time, one trade per symbol at a time. The Phase 88
  runner (scratchpad ph88exp.js) is reused with ONLY the window and the statistics below changed.
- Universe: the same lists (rules-stocks equitySwing.symbols(): 41 stocks; equityDay.symbols(): SPY + 25 optionable). Limitation:
  chosen in 2026 (survivorship). A symbol with bars on < 95% of the window's sessions is dropped and listed.
- Data: Alpaca IEX bars, split-adjusted (the app's loader settings), daily and 5-minute, with an explicit end.
- **Window: signals from 2022-10-03, data ending 2024-10-01 (inclusive).** Warm-up before it: daily 250 calendar days, 5-minute
  25 calendar days. Halves split at 2023-10-02. Trades still open at the end are excluded (as in Phase 88).
- Costs: base = the live cost model (0.05% a leg); stress = 0.10% a leg.

### A.3 Controls, statistics, pass criteria (per strategy, base costs)
- Control: the Phase 88 controls unchanged (same stop / target construction with the entry signal removed).
- Pass needs ALL: closed trades >= 60 (Equity Swing) / >= 80 (ORB); PF >= 1.20; PF > 1.0 in both halves; mean R above the
  control's mean R in both halves; day-block bootstrap (5,000 resamples of whole days, seed 90) one-sided lower bound of mean R > 0
  at alpha 0.05 / 2; PF > 1.0 under stress costs; max drawdown < 20R.
- Pass: eligible for a forward PAPER test only (its own protocol, later); never live from this. Fail: stays paused. No re-tuning.
- Reported also, description only (not a verdict): the four years 2022-10 .. 2026-10 combined.

## B. A new Quick Flips entry signal for SPY / QQQ

### B.1 Constraint from Phase 89
Protocol 89 section 1.8: after a failure "a new idea needs new, unseen data". The development window 2024-02-05 .. 2025-05-30 was
used for S1 / S2 (and its breakdown showed trend days did well): it cannot judge a new idea. The validation window 2025-06-02 ..
2026-10-01 has never been run (its option bars were never downloaded) and can be used ONCE. Option trade bars exist only from
February 2024, so a three-stage funnel is used:

| Stage | Window | Option prices | Role |
|---|---|---|---|
| 1 discovery | 2019-01-02 .. 2023-11-30 (SPY / QQQ SIP 1-minute, never used in this project) | MODELLED (B.4) | can the idea survive costs? |
| 2 translation | 2024-02-05 .. 2025-05-30 (seen) | real option 1-minute trade bars | does the model translate to real prints? (not evidence of edge) |
| 3 validation | 2025-06-02 .. 2026-10-01 (unseen) | real option 1-minute trade bars | the verdict; ONE configuration, run once |

### B.2 Hypotheses (declared; both from published research, not from our data)
- **N1 noise-area momentum** (Zarattini, Aziz, Barbon 2024, "Beat the Market: An Effective Intraday Momentum Strategy for S&P500
  ETF (SPY)"). For minute-of-day m: move_d(m) = |close_d(m) / open_d - 1| (open_d = the 09:30 bar's open); sigma(m) = the mean of
  move(m) over the prior 14 sessions (fewer: no signal). Upper band UB(m) = max(open_d, prior close) x (1 + sigma(m)); lower band
  LB(m) = min(open_d, prior close) x (1 - sigma(m)). Checked only at half-hour marks 10:00, 10:30, ..., 14:30 (the close of the
  1-minute bar ending at the mark). Long (call): close > UB; short (put): close < LB. Trigger level = the band.
  Exit signal (N1 trail), at each later half-hour mark: long when close < max(UB(m), VWAP); short when close > min(LB(m), VWAP).
  After an exit the symbol may enter again at a later mark (portfolio rules B.5).
- **N2 five-minute opening range** (Zarattini and Aziz 2023, "Can Day Trading Really Be Profitable? Evidence of Sustainable
  Long-term Profits from Opening Range Breakout (ORB) Day Trading Strategy vs. Benchmark in the US Stock Market"). The 09:30-09:35
  bar: close > open -> long (call), close < open -> short (put), doji (close = open) -> none. Signal at 09:35. Exit signal (N2 stop):
  a 1-minute close of the underlying beyond the first bar's opposite extreme (long: below its low). No target; deadline.
- Common: VWAP = session-cumulative sum(typical x volume) / sum(volume) on 1-minute bars (typical = (h + l + c) / 3). Decision time
  D = signal + 60 s; confirmation: the last 1-minute close at D still beyond the trigger level (N1: the band; N2: the first bar's close
  vs its open in the signal's direction), else skipped. FOMC days: no entries from 13:30 (2019-2026 scheduled dates, list in the
  script; plus 2020-03-03 from 10:00). Half-days and sessions with < 370 of 390 bars: skipped.

### B.3 Configurations (4; Bonferroni alpha 0.05 / 4)
- **N1-A**: N1 trail exit + deadline. **N1-B**: N1-A plus premium stop -30% and target +45% (Phase 89 V1 mechanics).
- **N2-A**: N2 stop + deadline. **N2-B**: N2-A plus premium stop -30% and target +45%.
- Deadline 15:45 (the Phase 89 replay deadline). R = 30% of the entry fill x 100 for every configuration (one unit across configs).

### B.4 Execution model
- Contract (Phase 89 1.4): expiry 3-7 calendar days, closest to 5 (stage 1 model: T = 5 calendar days at entry); call = highest $1
  strike <= spot at D, put = lowest $1 strike >= spot. Stages 2-3 add the Phase 89 liquidity proxy and premium >= $0.50.
- **Stage 1 option model**: Black-Scholes, r = 0, no dividends, implied vol = 1.10 x the prior 20 sessions' close-to-close realized
  volatility (annualized), floor 10%, held constant through the day (no vega, no smile: a declared weakness; stage 2 checks it).
  Premium of a 1-minute bar = the model at its close (stops), at its VWAP (targets; the bar's `vw`, else typical price) and at its
  open (fills). Time to expiry falls minute by minute.
- Fills and exits: Phase 89 1.5 exactly (entry at the first 1-minute bar at / after D at its VWAP + H; stop on a bar CLOSE -> next
  open - H; target when a later bar's VWAP >= target, at the target; a bar with both counts as the stop; signal exits (N1 trail, N2
  stop) -> next bar open - H; deadline 15:45 open - H). $0.65 per contract per fill.
- Costs: **O** H $0.01, **B** H $0.03, **S** H $0.06 + 60 s extra delay. **N2 entries (09:36) pay 2H** (opening spreads are wider).
- Stage 2-3: real option 1-minute trade bars through the Phase 89 machinery (qf-options / qf-sim), same rules.

### B.5 Portfolio rules (Phase 89 1.5)
One open Quick Flip per symbol, at most 2 open; at most 3 entries per symbol per day; 15-minute cooldown after an exit; no new entry
in a direction that was stopped (premium stop or N2 stop) on that symbol that day; no new entries after -2R realized in a day.
1 contract.

### B.6 Controls and statistics
- Random control, 20 seeded draws (seed 90) per real trade: N1 = an entry at a random half-hour mark 10:00-14:30 the same day, same
  symbol and direction; N2 = the same 09:36 entry with a random direction. Same contract rule, costs, exits. The real mean R must
  exceed the controls' 95th percentile.
- Day-block bootstrap, 5,000 resamples, seed 90, one-sided lower bound of mean R.
- Calibration (description only, decided before any N1 / N2 result): the stage 1 model applied to the 193 S1-V1 development trades
  of Phase 89, compared with their real-print P&L (correlation, mean difference).

### B.7 Pass criteria
- Stage 1 (base costs, model), per configuration: >= 150 trades; PF >= 1.20; bootstrap lower bound > 0 at alpha 0.05 / 4; above the
  random control's 95th percentile; PF > 1.0 on SPY and on QQQ; PF > 1.0 in both halves (split 2021-06-01); PF > 1.0 under stress;
  max drawdown < 25R.
- Stage 2 (only stage 1 passers): PF >= 1.15 (B), PF > 1.0 (S), mean R > 0.
- Stage 3: ONE configuration, the stage 1 + 2 passer with the highest stage 1 bootstrap lower bound. Pass needs: PF >= 1.15 (B),
  PF > 1.0 (S), mean R > 0, PF > 1.0 in both halves (split 2026-02-01), bootstrap lower bound > 0 at alpha 0.05 (one-sided).
- Pass: candidate for the forward PAPER test of protocol 2A (this configuration replaces S1 there; the count starts at 0; paper only;
  the daily profit target off). Fail at any stage: Quick Flips stays off; nothing is re-tuned on these windows.
