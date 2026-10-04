# Protocol 2A clarification: Quick Flips forward paper test (FROZEN before the test starts)

Written 2026-10-04, before any forward trade (Quick Flips is OFF; no forward data exists). It clarifies `phase89-protocol-2.md`
section A. Nothing is loosened. One rule is made STRICTER at the user's request: a PASS requires the full 150 trades.
The protocol-1 validation window (2025-06-02 to 2026-10-01) stays untouched.

## 1. Configuration id

- Trading rules: exactly as in commit **3998693** (signals, contract choice, liquidity filters, 1 contract, automatic paper execution,
  entry deadline, -30% / +45%, setup failure, 60-minute hold, 3:40 PM deadline).
- The test runs on the commit that adds this file (Phase 89c). Its only Quick Flips differences from 3998693 are exit safety and
  measurement: the deadline is anchored to the day the position opened (a position still open the next day is due at once); the
  escalation is timed from the deadline (the same clock times on the day: 25% at 3:42 PM, 50% at 3:50 PM); failure alerts; the first
  exit-trigger quote is kept (exitWork.q0) for the slippage measures below. If the trading rules change, the test restarts from zero.

## 2. Units, sources

- **Units: US dollars per share of option premium** (1 contract = 100 shares: $0.05 per share = $5 per contract, per side).
- **Quote source: Alpaca's INDICATIVE option feed as stored by SignalDesk** (not the OPRA NBBO; our plan has no OPRA). **Fill source:
  the Alpaca Paper average fill** (simulated by Alpaca, not an exchange fill). Every measure below inherits both limitations.

## 3. Per-trade measures (scripts/quickflips-forward-report.js computes exactly these)

| Measure | Definition | Sign |
|---|---|---|
| E1 entry slippage | entry fill - the ask of the signal's quote (optionsData.plannedDebit: the quote <= 30 s old used to build the setup) | + = paid more |
| X1 exit slippage | stop / setup failure / max hold / deadline / manual exits: natural bid of the FIRST exit-trigger quote (exitWork.q0.bid) - exit fill; resting take-profit: target limit - fill | + = received less |
| RT round-trip cost vs mid | (entry fill - signal quote mid) + (first-trigger quote mid - exit fill); a take-profit exit counts 0 on the exit side (the replay filled targets at the target) | + = cost |
| Q quote age | signal time - the signal quote's own timestamp, seconds | |

A trade without the quote a measure needs is counted as "missing" for that measure and listed.

## 4. Trades counted

Alpaca Paper fills only (internal paper fills are listed, excluded). An entry canceled unfilled is not a trade (counted separately). A
trade with partial fills counts once. An overnight hold (closed on a later New York day than it opened) is a protocol VIOLATION.

## 5. Checkpoint at 40 trades (execution only; never a profitability verdict)

All must hold, else the mechanics are fixed and the count restarts from zero:
- 0 overnight holds; 0 real-money orders; >= 95% of exits by a rule (not manual).
- **Mean E1 <= $0.05 and mean X1 <= $0.05 per share** (the MEAN over the 40 trades). The median and the maximum are reported for
  information only; they are not pass / fail.
- Missing quotes for E1 or X1 on at most 10% of the trades.

## 6. Verdicts (decided in advance)

- **FAIL (futility) at 100 trades:** PF < 0.80 or mean R < -0.15.
- **PASS: only at 150 trades**, and only if ALL hold: PF >= 1.15 on Alpaca Paper fills + $0.65 per contract per fill; mean R > 0 with a
  day-block bootstrap (5,000 resamples, seed 89) one-sided 95% lower bound > 0; max drawdown < 15R; PF > 0.9 on SPY and on QQQ separately;
  mean RT <= $0.06 per share.
- **FAIL at 150 trades** if any PASS condition is not met.
- **INCONCLUSIVE:** 12 calendar months elapse with fewer than 150 trades (and no futility stop). No PASS is possible then, whatever the PF.
- R per trade = the trade's net P/L / its recorded dollarRisk (the risk engine's expected exit risk).

## 7. Fixed for the whole test

Paper only (Alpaca Paper); 1 contract; at most 2 open; -2R a day for Quick Flips; the daily profit target OFF; the account's existing
book limits unchanged. The $200 target never selects or sizes a trade (it can only block entries, and it is off here).
