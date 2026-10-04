# Phase 89 results: diagnosis, research, changes

Protocol: `docs/research/phase89-protocol.md`, frozen and committed (e76aeb5) before any replay ran.
SHA-256 `3b6cab2a4f2dc02563f3172a75aae269bc311577564980fe74c38cb4ef08a2cd`. Every result below is **PRELIMINARY**: no historical
option bid / ask quotes exist in the data (Alpaca serves option trade bars only, from February 2024).

## 1. Diagnosis (plain language)

**What was audited.** The ledger on this PC (`server/data/ledger-state.json`, read from a copy, never modified): 40 closed
records and 13 open positions, 25-28 September 2026. **The VM's ledger (everything after 28 September, including the
loss-making paper runs) was not available to this session.** The audit tool now ships in the repo so it can be run there
(section 6). Conclusions about the most recent losses are therefore uncertain until that output is seen.

| Finding | Evidence | Confidence / what is uncertain |
|---|---|---|
| **Paper option P&L was overstated by the fill model.** Internal paper spreads were bought at net mid + 0.15 x the legs' bid/ask and sold at mid - 0.15 x, i.e. 35% of the spread better than a real order on each side. | The 18 paper spreads booked **+$354**. Re-priced at natural bid / ask they come to about **-$198**, with 6 winners instead of 17 (`scripts/trade-audit.js`). | High for the direction; the exit-side legs' widths were assumed equal to entry's. |
| **Exit values above any real print.** Booked exits came from Alpaca's free *indicative* feed, which Alpaca says are not real OPRA quotes. | TSLA booked 2.72 vs the best synchronous leg print 2.48; AMZN 3.16 vs 3.01; ORCL 3.95 vs 3.73; INTC 3.81 vs 3.74. Underlying flat in several of those (TSLA 370.69 -> 370.64). Some quotes were 479 s and 700 s old at the signal. | High that indicative quotes are unreliable for fills; the size of the error per trade is uncertain (option prints are sparse). |
| **The paper "wins" were discretionary early closes.** | All 18 option exits were MANUAL_CLOSE within minutes to 3 days, at +0.02R to +0.74R. No strategy exit fired. Phase 87's scorecard already found the same pattern on the VM (43 manual closes; its own stops lost). | High. "It turned green briefly" was not shown to be capturable: the green came from the fill model and the indicative quotes. |
| **Options signals carry no edge** (Phase 87). | 2-year replay: PF 0.75 in both halves; direction no better than chance. | High (prior phase). |
| **Paper crypto fills were optimistic.** Paper filled at once at the last price but charged the MAKER fee; live places a post-only limit at the bid that may never fill (canceled after 30 min). | Code: `order-router.js` paper branch; `coinbase/okx/kraken-orders.js` post-only at the bid. | High (code fact); effect size small per trade but systematic. |
| **Moonshots: strategy exits lose, manual exits are small wins.** | LIVE: 8 system exits PF 0.82 (-$1.30), 8 manual closes all small wins (+$2.98). Sample is tiny. | Low (17 trades). |
| **Live stop slippage / fees.** | 5 system stops filled worse than -1.1R (-1.16 to -1.27R) on thin coins; fees were 50%+ of the gross on 11 trades (live ~$20 crypto positions, and paper option closes that gained only a few dollars). | Medium. |
| **Held past the setup window.** | Moonshots held 33-54 h on "minutes to hours" setups (no time exit by design). | Medium: whether this costs money is not measurable on 3 trades. |
| **App vs broker records.** | LIVE P&L source was broker fills on every LIVE record; one CLOSED_EXTERNALLY; one UNARMORED stop at Kraken (insufficient funds when re-placing). A real gap was found in code: an Alpaca Paper entry canceled after a PARTIAL fill kept the ordered size (fixed). | Medium; the VM data is needed for a full reconciliation. |

Best / worst price reached: reconstructed from 1-minute trade prints where data exists (most small Coinbase coins have no public
Exchange candles). These are print ranges, not executable prices: e.g. FARM-USD best print +2.64R vs 1.99R booked; ARB-USD
+0.19R / -0.19R vs +0.01R booked.

**Paused during the investigation** (open positions, stops, targets and closes keep working): Crypto Intraday, Equity Day (ORB),
Equity Swing (unvalidated), Options Spreads and Crypto Swing (lost in their replays), once per ledger; each can be switched back
on in Settings > Strategies. Moonshots stays on (its Phase 79 replay is the only one that passed).

## 2. Options Quick Flips (SPY / QQQ, 3-7 DTE singles, same-day exits)

Development window 2024-02-05 to 2025-05-30, 328 sessions, base costs ($0.03 half-spread, $0.65 / contract / fill), 1 contract.

| Config | Trades | Win % | PF | Mean R | Net $ | Stress PF | Bootstrap lower (alpha 0.05/6) | Random-entry 95th pct | Pass |
|---|---|---|---|---|---|---|---|---|---|
| S1 ORB, V1 (-30% / +45%, 60 min) | 193 | 49 | **1.41** | 0.083 | +2,609 | 1.09 | **-0.055** | 0.071 | no |
| S1, V2 (-20% / +30%, 30 min) | 193 | 50 | 1.23 | 0.029 | +1,240 | 0.94 | -0.135 | 0.037 | no |
| S1, V3 (90 min, no failure exit) | 191 | 48 | 0.99 | -0.009 | -113 | 0.78 | -0.176 | 0.182 | no |
| S2 VWAP pullback, V1 | 640 | 42 | 0.95 | -0.026 | -1,045 | 0.80 | -0.095 | 0.066 | no |
| S2, V2 | 670 | 42 | 0.83 | -0.072 | -2,986 | 0.71 | -0.141 | 0.030 | no |
| S2, V3 | 561 | 41 | 0.94 | -0.036 | -1,380 | 0.81 | -0.124 | 0.201 | no |

**Verdict: no configuration passed.** Per the protocol the validation window (2025-06-02 to 2026-10-01) was **not run** and stays
unseen, and nothing was re-tuned. The closest, S1-V1, misses on significance (even at an unadjusted alpha of 0.05 its lower bound
is -0.014R) and is fragile to costs (PF 1.09 under stress). S2 loses under base costs in every variant.

S1-V1 detail (description only, not evidence of an edge): exits MAX_HOLD 97 (82% wins), SETUP_FAILED 80 (4% wins, -0.50R
average), TARGET 12, STOP 4; SPY PF 1.47, QQQ PF 1.35; halves PF 1.35 / 1.46; puts PF 1.52 vs calls 1.23; "trend days" PF 3.26 vs
"range days" 0.89 (classified after the fact, so not tradable as a filter); 11 of 16 months positive.
Daily P&L at 1 contract: 185 of 328 days had no trade; median day $0; worst -$291; best +$536; **only 11 days (3%) reached +$200**.
Average premium $4.39 ($439 per contract); an $850+ contract is refused by the existing 6%-of-bankroll cap on $10,000.

Live implementation vs the replay: the live signal module reproduces the replay's signals exactly (1,748 of 1,748 development
signals). Known differences: live uses IEX volume (the replay used consolidated SIP volume) on both sides of RelVol; live entries
wait for your approval (3-minute window; the replay assumed 1-2 minutes); live closes from 3:40 PM (replay 3:45 PM).

## 3. Crypto

**Frozen test (BTC / ETH, live Crypto Intraday rules, 15m and 1h, development 2024-10-01 to 2025-09-30): FAIL, not enough trades.**
The rules' 3.2% minimum chart stop rejects almost every BTC / ETH signal: 15m 3,444 rejections, 2 trades (both -1.07R); 1h 667
rejections, 0 trades. Buy-and-hold over the same year: BTC +79%, ETH +57%.

**Diagnostic, declared after that result (not a pass / fail test, nothing adopted):** the same unchanged rules on their whole
15-coin universe, 2024-10-01 to 2026-10-01, post-only entries filled only when traded through, the venue's fees:

| Path | Venue | Trades | Win % | PF | Mean R | Total R |
|---|---|---|---|---|---|---|
| 15m | OKX | 126 | 25 | 0.81 | -0.147 | -18.6 |
| 15m | Kraken | 83 | 24 | 0.70 | -0.280 | -23.3 |
| 1h | OKX | 40 | 25 | 0.57 | -0.342 | -13.7 |
| 1h | Kraken | 30 | 20 | 0.34 | -0.629 | -18.9 |
| either | Coinbase Intro fees | 0 | - | - | - | - |

Why it loses: 75% of trades hit the stop (-100R on the 15m path) and the 2.3R / 3R targets (+81R) do not pay for that win rate;
the range-failure archetype is the worst (PF 0.19); the post-only entry fills almost always (so the maker fee is earned, but on the
trades that keep falling); at Coinbase's fees no setup passes the cost gates at all. Crypto Intraday stays paused.

## 4. What changed (code)

- **Research pause** (`strategy-toggles.js`, `ledger-store.js`): the five strategies above switched off once per existing ledger
  (`strategyPauseVersion` 89); off by default for new ledgers. Re-enabling is never undone.
- **Options Quick Flips mode** (off by default, paper only): `strategies/7-options-quickflips.js`, `quickflips-signals.js`,
  `risk/quickflip-rules.js` (paper only, window, 1 per symbol, 2 open, 3 a symbol a day, 15-min cooldown, no same direction after a
  stop, -2R day), `execution/quickflip-exits.js` (3:40 PM deadline, 60-min max hold, setup failure: the only time exits besides
  the 2-DTE rule), 3-minute approval window, 3-minute entry timeout with no re-pricing, stale quotes refused (> 30 s at the signal;
  no fresh quote at the fill). Configured as S1 + V1 for forward paper testing only.
- **Daily profit target** (optional, off; $200 default): per book, realized P&L; stops new automated entries for the day only.
- **Combined exposure / max positions** (`risk/exposure-limits.js`): paper options + crypto open risk capped at the existing
  `maxOpenRiskPct` of the combined paper bankrolls; `maxOpenPositions` per book (0 = off until limits are agreed).
- **Realistic paper fills** (`execution/paper-fills.js`, `option-marks.js`): paper crypto buys at the ask with the taker fee; paper
  option spreads bought and sold at natural prices.
- **Partial fills** (`alpaca-paper.js`): a partially filled Alpaca Paper entry stays a working order; canceled with a partial fill, the
  position becomes the filled quantity (size, 1R, notional); a close cancels the unfilled rest first.
- **Audit tool** `scripts/trade-audit.js` (read-only; safe on the VM).

## 5. How it was verified

- `tests/ph89unit.js`: 41 checks (pause once / re-enable sticks, S1 signal + confirmation, sizing by the existing risk engine,
  every Quick Flip rule, pacing exemption, profit target on / off / release / no mutation, combined risk and position caps, ask +
  taker crypto fills, natural spread fills and sale values, stale-quote refusal, max-hold / deadline / setup-failure exits, a real
  3:41 PM deadline close, entry timeout, cancel races, partial fills, duplicate staging, paper-only routing).
- Every earlier suite re-run; five old suites updated where they encoded the old fill model or the old defaults (ph57, ph58, ph59,
  ph70, ph78).
- Signal equivalence: live module vs replay, 1,748 / 1,748 identical. Settings UI checked in the port-3999 harness (scratch ledger).

## 6. Next steps (forward validation before any real money)

1. Run `node scripts/trade-audit.js server/data/ledger-state.json --csv audit.csv` on the VM and share the output: it covers the
   period this session could not see.
2. If you want to forward-test Quick Flips: switch it on (paper), ideally with Paper broker = Alpaca Paper (real NBBO fills, not
   indicative quotes). Pre-declared forward test: S1 + V1 only, at least 40 trades / 4 weeks, compared with the replay's cost
   scenarios; the untouched 2025-06 to 2026-10 window can serve as a second unseen check if forward results warrant it.
3. Agree account-specific limits (max positions, combined risk, daily loss / target) before any change to them.
4. Consider an OPRA data subscription before trusting any option quote-based paper result.
