# Phase 90 results (protocol docs/research/phase90-protocol.md, frozen in da77f3c before any replay)

## A. Equity Swing and Equity Day (ORB) on unseen data: both FAIL

Window 2022-10-03 .. 2024-10-01 (never used for these rules; Phase 88 used 2024-10-02 .. 2026-10-02). The live rules unchanged
(the in-app backtest engine), Alpaca IEX split-adjusted bars, 41 daily / 25 five-minute symbols, none dropped for coverage (502
sessions). Base costs 0.05% a leg; stress 0.10% a leg (applied after the fact: +0.05% on each leg priced at the entry, since the engine
does not export exit legs; exits sit within a few % of the entry, so the approximation is small). R = the planned stop distance.

| | Trades | Win % | PF | Mean R | Total R | Max DD | H1 PF / mean R | H2 PF / mean R | Control mean R H1 / H2 | Bootstrap lower (a 0.025) | Stress PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Equity Swing | 93 | 34 | 0.86 | -0.127 | -11.8 | 26.7R | 0.74 / -0.249 | 0.95 / -0.038 | -0.008 / +0.037 | -0.582 | 0.75 |
| ORB day trades | 298 | 36 | 1.11 | +0.085 | +25.4 | 24.7R | 1.19 / +0.142 | 1.04 / +0.033 | -0.045 / +0.068 | -0.157 | 0.94 |

**Protocol A.3 verdict:**
- **Equity Swing: FAIL** on every criterion but the trade count (PF 0.86; loses in both halves; below its own entry-removed control).
- **ORB: FAIL**: PF 1.11 < 1.20; beats the control in the first half only (H2 +0.033R vs the control's +0.068R); bootstrap lower
  bound -0.157R; under stress costs PF 0.94; max drawdown 24.7R (limit 20R). Its result comes from 79 T2 winners (+3.0R each)
  against 219 stops (-0.98R): a long-tailed payoff that a 0.05% cost change turns negative.

**Four years combined (2022-10 .. 2026-10; description only, NOT a verdict: half of it is the seen Phase 88 window):**
Equity Swing 199 trades, PF 0.83, -0.163R a trade. ORB 465 trades, PF 1.10, +0.076R a trade, fading by year: +0.32R (2022 Q4, 42
trades), +0.04 (2023), +0.10 (2024), +0.02 (2025), +0.01 (2026 to date).

Both stay paused. Nothing was tuned. Limitations: the universe was chosen in 2026 (survivorship); IEX volume, not consolidated.

## B. New Quick Flips entry signals (N1 noise-area momentum, N2 five-minute ORB): all FAIL stage 1

**Calibration first (declared; description only).** The stage 1 option model (Black-Scholes, IV = 1.10 x 20-session realized vol)
against the REAL option prints of the 193 Phase 89 S1-V1 trades: same entry / exit minutes, correlation 0.985 (mean premium change per
share +$0.061 modelled vs +$0.031 real); full re-simulation P&L correlation 0.968, total $2,824 modelled vs $2,609 real, PF 1.49 vs 1.41,
same exit reason 183 / 193. The model tracks real prints closely but is slightly OPTIMISTIC (about +$0.03 a share a trade): a stage 1
PF is an upper-side estimate.

**Stage 1: SPY / QQQ 2019-01-02 .. 2023-11-30** (1,238 sessions, 18 skipped for missing data; signals N1 6,652, N2 2,143; after the
portfolio rules, base costs H $0.03 + $0.65 a fill, 1 contract; R = 30% of the fill):

| Config | Trades | Win % | PF | Mean R | Net $ | Opt. PF (H $0.01) | Stress PF | H1 / H2 PF | Bootstrap lower (a 0.0125) | Control 95th | Max DD | Pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N1-A trail exit | 1,783 | 34 | 1.15 | +0.048 | +7,838 | 1.31 | 0.92 | 0.99 / 1.27 | -0.012 | 0.025 | 56.0R | no |
| N1-B + stop / target | 1,989 | 36 | 1.11 | +0.033 | +6,633 | 1.26 | 0.90 | 0.93 / 1.26 | -0.014 | 0.085 | 56.5R | no |
| N2-A ORB stop | 2,138 | 26 | 0.94 | -0.008 | -5,210 | 1.09 | 0.76 | 0.84 / 1.01 | -0.077 | -0.017 | 43.2R | no |
| N2-B + stop / target | 2,138 | 28 | 0.82 | -0.065 | -15,670 | 0.95 | 0.66 | 0.82 / 0.83 | -0.114 | -0.065 | 152.3R | no |

**Verdict: no configuration passed stage 1** (PF >= 1.20, bootstrap lower bound > 0, both halves, stress and drawdown all failed for
all four). Per the protocol, stages 2 and 3 were NOT run: the validation window 2025-06-02 .. 2026-10-01 stays unseen (its option bars
were never downloaded), and nothing was re-tuned.

What the numbers say (description, not evidence for a variant):
- **N1 has some information but not enough to pay its costs.** It beats its random-entry control (+0.048R vs the controls' 95th
  percentile +0.025R; N1-A), consistent with the published effect, but the edge is about the size of the bid / ask: PF 1.31 at a $0.01
  half-spread, 1.15 at $0.03, 0.92 at $0.06. And the model is slightly optimistic, so real prints would likely be lower still. By year:
  2019 PF 0.76, 2020 0.99, 2021 1.27, 2022 1.24, 2023 1.34. Its profit comes from the trades still open at the 15:45 deadline (528,
  +519R); the trail exits that cut the rest (1,255) lose -433R.
- **N2 (five-minute ORB) has no edge here**: PF 0.94 at base costs (SPY 0.96, QQQ 0.92), losing in 3 of 5 years (2019 0.79, 2020
  0.75, 2021 1.02, 2022 1.12, 2023 0.91). It edges past its random-direction control (-0.008R vs the controls' 95th percentile -0.017R)
  only in the sense that both lose.

Quick Flips stays OFF. The forward paper test of protocol 2A (S1-V1, about break-even in replay) remains the only Quick Flips
measurement exercise allowed; it is not evidence of an edge.

## C. Where this leaves the automated strategies

No automated strategy in SignalDesk has passed a pre-registered test on unseen data: Equity Swing, Equity Day (ORB), Options Spreads,
Crypto Swing, Crypto Intraday, Moonshots, Quick Flips S1 / S2, and now N1 / N2. All stay off. Research scripts and data: session
scratchpad `ph90/` (a-run.js, b-*.js; a/ and b/ caches), reusing the Phase 88 runner and the Phase 89 Quick Flips machinery.
