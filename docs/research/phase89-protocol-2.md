# Phase 89 protocol 2 (FROZEN before the tests it describes were run)

Frozen 2026-10-04, after the Phase 89 development results (`phase89-results.md`) and BEFORE any of the tests below. The commit
that adds this file is the freeze record. The protocol-1 validation window for Quick Flips (2025-06-02 to 2026-10-01) stays
UNTOUCHED by everything here.

## A. Options Quick Flips: forward paper test

**Configuration under test (fixed for the whole test).** S1 (ORB + VWAP) with V1 exits, exactly as implemented in
`server/strategies/7-options-quickflips.js` at the commit that ENDS this phase ("Phase 89b"; its hash is the configuration id):
- SPY and QQQ; IEX 1-minute bars (our Alpaca plan has no real-time SIP: HTTP 403), IEX history for the 20-session RelVol baseline;
  completeness = >= 95% of the bars Alpaca's REST IEX history reports for the minutes completed so far (no REST = no entry).
- Signal on the 5-minute close 9:50-11:30 ET; decision at bar end + 60 s; confirmation as in protocol 1.
- Contract: 3-7 DTE closest to 5 (ties shorter), call = highest $1 strike <= spot, put = lowest >= spot; indicative quote <= 30 s old,
  bid >= $0.50, bid/ask <= 5% of mid. **1 contract.**
- Entry: automatic paper execution (settings.quickFlipsAutoPaper) at **Alpaca Paper** (Settings > Paper broker: Alpaca Paper), a limit at
  the natural ask, capped by spread-entry.maxDebit; must fill by decision + 3 min, else canceled (no re-pricing).
- Exits: premium -30% (2 confirmations on the mark) / +45% (resting limit); setup failure (5-minute close back through VWAP); 60 min
  max hold; 3:40 PM deadline, escalated 3:42 / 3:50 PM until filled. Same day, always.
- Book limits: existing settings; Quick Flips rules (2 open, 3 / symbol / day, 15-min cooldown, no same direction after a stop,
  -2R day). **The daily profit target must be OFF during the test** (it would truncate the daily distribution being measured).

**Known differences from the historical replay (disclosed, not fixed):** live uses indicative option quotes for the stop trigger
and the limits (the replay used option trade prints and modelled spreads); Alpaca Paper fills are simulated against its quotes, not
exchange fills; the replay closed at 3:45 PM, live from 3:40 PM.

**Reference expectation (development window, the IEX version of the same rules):** 190 trades, PF 1.10 at base costs ($0.03
half-spread), 0.90 under stress costs: about break-even. The forward test measures; it is not expected to "prove" an edge.

**Observation period.** From the first regular session after Quick Flips is switched on with Alpaca Paper as the paper broker, until
150 completed trades or 12 calendar months, whichever comes first. Trades filled internally (no Alpaca Paper) are logged but excluded.

**Checkpoints (decided in advance):**
1. **40 trades: execution checkpoint only, no profitability verdict.** Continue only if: 0 overnight holds; 0 real-money orders; >= 95%
   of exits by a rule (not manual); every entry filled within decision + 3 min or canceled; average entry fill - ask at the signal
   <= $0.05; average exit fill vs the natural bid at the trigger <= $0.05 worse. A failure here is a mechanics bug to fix (and the count
   restarts), not a strategy result.
2. **100 trades: futility.** Stop (strategy off) if PF < 0.80 or mean R < -0.15.
3. **Final (150 trades or 12 months).** Success requires ALL of: PF >= 1.15 on actual Alpaca Paper fills + $0.65 per contract per fill;
   mean R > 0 with a day-block bootstrap one-sided 95% lower bound > 0; max drawdown < 15R; PF > 0.9 on SPY and on QQQ separately;
   average round-trip cost no worse than the replay's base scenario ($0.06 per share). Fewer than 60 trades in 12 months: inconclusive.

**After a success:** still no real money by default. Next steps would be: run the untouched protocol-1 validation window ONCE on the IEX
version, consider an OPRA data plan, and a separate real-money decision by the user. **After a failure:** Quick Flips stays off; any new
idea needs a new protocol and unseen data.

## B. Crypto: revised rules from the diagnosed failure mechanisms

**Mechanisms found (phase89-results.md section 3):** (M1) 75% of trades hit the stop and the 2.3R / 3R targets do not pay for a 25%
win rate; (M2) the range-failure archetype is the worst (PF 0.19); (M3) the 3.2% minimum chart stop, written for Coinbase's fees,
removes almost every BTC / ETH setup although the cost gates (fee drag <= 0.30R, T1 net >= 1.5 : 1 at the venue's fees) already
protect against fee drag; (M4) long entries are taken whatever the higher-timeframe trend; (M5) failed setups are held for many hours.

**Revised rule set R (declared once; no other variants):** the live Crypto Intraday detectors and gates, with exactly these changes:
1. SQUEEZE and SWEEP only (RANGEFAIL and PULLBACK removed: M2; PULLBACK had 7 trades, PF 0.60).
2. Regime filter (M4): long only when the last completed daily close > its EMA50 AND the 4-hour EMA21 > EMA50 (4-hour = 1-hour bars
   regrouped, UTC).
3. Minimum chart stop = the venue's fee floor (cost-authority minStopPct at OKX fees), not 3.2% (M3); every cost gate unchanged.
4. Targets unchanged (T1 2.3R 50%, T2 3R).
- **Variant RT** = R + a time stop (M5): if a position has not traded at entry + 0.5R within 8 bars (15m: 2 h; 1h: 8 h), it is sold at
  the next bar's open (taker). **Variant R0** = R without it.
- Configurations: R0 and RT on the 15m and 1h paths = 4. Bonferroni alpha 0.05 / 4.

**Universe and windows (never examined by any earlier phase):** BTC-USD, ETH-USD, SOL-USD (Coinbase candles). **Development**
2022-01-01 to 2023-12-31; **validation** 2024-01-01 to 2024-09-30, run ONCE, only for configurations that pass development.

**Execution (unchanged from protocol 1 section 2.3):** post-only buy at the next open - half-spread, filled only when traded strictly
through by 0.01% within 2 bars (15m) / 1 bar (1h); stops taker at the stop or the gap open; targets maker, traded through by 0.01%; a
bar touching both counts as the stop. Fees: OKX 0.08 / 0.10% (base), Kraken 0.25 / 0.40% (stress fees). Half-spread 0.01% base,
0.05% stress. One position per symbol per path; no new entries after -3R realized in a New York day; spot, no leverage.

**Controls and statistics:** random-entry control (20 seeded draws, same symbol / month, same stop and target distances); the same rules
without the regime filter (to see whether the filter carries the result); day-block bootstrap.

**Pass, development (OKX, base spread):** >= 60 trades; PF >= 1.20; bootstrap lower bound > 0 at alpha 0.05 / 4; mean R above the
random control's 95th percentile; PF > 1.0 on at least 2 of the 3 coins; PF > 1.0 at Kraken fees; PF > 1.0 in both halves.
**Pass, validation:** PF >= 1.10 (base), PF > 1.0 (stress spread), mean R > 0. **Fail:** Crypto Intraday stays paused; no re-tuning
on these windows.

## C. Moonshots: out-of-sample check of the Phase 79 rules

Rules: `strategies/moonshot-entry.js` + `backtest/rules-moonshots.js` exactly as committed (Phase 79), Coinbase fees (and Kraken / OKX
reported). Universe: the same 62 coins as Phase 79 (selection bias disclosed: they were chosen while already active). Window: the 90
days immediately BEFORE the Phase 79 window (never used to design or judge the rules). Pass: >= 40 trades; PF >= 1.20 at Coinbase
fees; PF > 1.0 at Kraken fees; day-block bootstrap one-sided 95% lower bound of mean R > 0. Fail or too few trades: Moonshots stays
paused. A pass would justify forward PAPER testing only, not live trading.
