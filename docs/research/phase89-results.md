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

---

# Phase 89b review (2026-10-04)

Protocol 2 (`phase89-protocol-2.md`, SHA-256 `417257ad6cfd0d9b70d859c32878296935bb49606bd1cda67382ad5629955092`) was frozen and committed
(9d05c41) before the crypto revised-rules and Moonshots out-of-sample tests ran. The protocol-1 validation window stays untouched.

## 7. VM status and the full-history audit

- **This session has no access to the VM** (no gcloud CLI, no SSH key on this PC), and the project rule forbids sending messages to the
  live server, so the VM ledger (everything after 28 September) is **still not audited**. Every conclusion about the recent losses below
  is limited to the local copy (25-28 September).
- **The VM is very likely NOT running Phase 89 / 89b.** The last recorded deploy is b57b376 (Phase 85b); Phases 86-89b are pushed to
  GitHub but not deployed. Check on the VM with `git log -1 --oneline` in the app folder and `pm2 ls`.
- **Read-only audit on the VM without deploying or restarting** (copies the ledger first; the original is never opened for writing):
  see "VM runbook" in section 13.
- The audit now separates **RECORDED** results (the ledger's netPnl) from **RECONSTRUCTED ESTIMATES** (`scripts/audit-attribution.js`):
  signal (the plan's result at its own stop / target), execution (slippage past the level and fees), discretion (manual / external
  closes), contract bid/ask cost, booked-minus-natural (accounting), and trades held past their window. On the local copy:

| Strategy / book | Recorded net | Signal at plan (est.) | Execution incl. fees (est.) | Manual closes (gross) | Booked minus natural (est.) |
|---|---|---|---|---|---|
| Moonshots LIVE (17) | +$1.63 | +$1.04 | -$4.87 | +$5.47 | n/a |
| Options Spreads PAPER (18) | +$354.18 | $0 (no system exit) | -$49.40 | +$403.58 | +$552.30 overstated |
| Manual LIVE (4) | -$3.71 | -$3.18 | -$1.72 | +$1.19 | n/a |

## 8. Data access, corrected wording

| Data | Offered by Alpaca | Available to OUR account (paper keys, free data plan; tested 2026-10-04) |
|---|---|---|
| Real-time consolidated (SIP) stock data | yes (paid plan) | **no** (HTTP 403 "subscription does not permit querying recent SIP data") |
| SIP stock data older than 15 minutes | yes | yes |
| IEX stock data, real time | yes | yes |
| OPRA option quotes (real NBBO) | yes (paid plan + signed OPRA agreement) | **no** (HTTP 403 "OPRA agreement is not signed") |
| Indicative option quotes (a derived, non-NBBO feed) | yes (free) | yes |
| Historical option trades and 1-minute bars | yes, from February 2024 (no feed parameter) | yes |
| Historical option bid / ask quotes | **not offered** (the endpoint does not exist: HTTP 404) | no |

**How each result is labelled:** Quick Flips replays = option TRADE prints + MODELLED spreads (no quotes exist); the paper audit's
natural-price re-marks = the INDICATIVE quotes stored in the ledger at the time; every internal paper option fill / mark = INDICATIVE
quotes; Alpaca Paper fills = Alpaca's simulator against its own quotes (not exchange fills). Section 0 of protocol 1 is frozen and
kept as written; this table supersedes its wording.

## 9. Quick Flips: implementation vs the frozen protocol

| Item | Replay (protocol 1) | Live before 89b | Live now | Status |
|---|---|---|---|---|
| Bars / volume | SIP 1-minute | IEX | IEX (no real-time SIP on our plan) | **difference measured; removable only with a paid data plan** |
| Completeness | session >= 370 / 390 bars | 95% of elapsed minutes (fails on IEX silence; edge case at the minute boundary) | >= 95% of the bars REST IEX reports for minutes completed so far; REST merged each minute (restart recovery); no REST = no entry | fixed |
| Entry timing | decision = bar end + 60 s, fill within 3 min | manual approval (unknown delay), 3 min after placement | automatic paper execution (your choice, quickFlipsAutoPaper), must fill by decision + 3 min | fixed |
| Size | 1 contract | risk engine (could be > 1) | 1 contract (maxContracts) | fixed |
| Liquidity filter | trade activity proxy (no quotes) | indicative quote <= 30 s, bid >= $0.50, bid/ask <= 5% | unchanged | difference (unavoidable: no historical quotes) |
| Costs | $0.65 / contract / fill + modelled half-spread | $0.65 + paper fills | unchanged | consistent; the forward test measures the actual spread cost |
| Stop / target | option trade-bar close / VWAP | indicative mark (2 confirmations) / resting limit | unchanged | difference (documented) |
| Setup failure, 60-min hold | as protocol | as protocol | as protocol (+ REST bars after a restart) | consistent |
| Deadline | 3:45 PM bar open | 3:40 PM; could rest unfilled overnight (no quote / unfilled ladder) | 3:40 PM; re-priced 25% under the best bid (fresh, else last known, else model) at 3:42 PM, 50% at 3:50 PM, every 20 s; 89c: carried over + alerted | improved: a fill is likely, NOT guaranteed (section 17) |
| Partial fills | n/a | entry partial fixed in 89; a partial CLOSE booked the whole position | the sold part is booked, the rest stays open and is retried | fixed |

**SIP vs IEX (development window only):** IEX publishes a minute bar only when IEX traded (median 370 / 390 a session, 5% of
sessions <= 293). Only 50% of the S1 signals are identical on IEX. The selected configuration on IEX signals: **190 trades, PF 1.10 at
base costs, 0.90 under stress costs** (SIP: 193 trades, 1.41 / 1.09). On the feed our plan allows live, the configuration is about
break-even before any forward evidence. Real-time SIP needs a paid Alpaca plan; that is your decision.

**$200 target:** it only stops new automated entries (realized P/L, per book). No strategy, the risk engine or the sizing reads it;
the forward-test protocol requires it OFF during the test so the daily results are not truncated.

## 10. One evidence standard for every strategy

| Strategy | Evidence | Verdict |
|---|---|---|
| Equity Day (ORB) | Phase 88: 167 trades, PF 1.08, not significant | paused |
| Equity Swing | Phase 88: PF 0.81 | paused |
| Options Spreads | Phase 87: PF 0.75 in both halves, no directional information | paused |
| Crypto Swing | Phase 78: PF 0.82-0.96 | paused |
| Crypto Intraday | Phase 89: BTC / ETH 2 trades; 15-coin list PF 0.81 / 0.57; revised rules failed on unseen 2022-23 data | paused |
| **Moonshots** | Phase 79 "validation" used the SAME 90 days that inspired the rule change (not independent); coins chosen while hot; live strategy exits PF 0.82 (8 trades); out-of-sample (section 12): PF 0.58 at Coinbase fees, 0.74 Kraken, 0.82 OKX | **paused (pause 90)** |
| Options Quick Flips | did not pass protocol 1; the IEX version is about break-even | off; forward paper test only (protocol 2A) |
| Portfolio Pilot | not a scanner: every Pilot buy / sell waits for your approval | not an automated entry |

All automated scanners are now off by default; open positions, stops, targets, time exits and closes keep working.

## 11. Crypto: revised rules on unseen data (protocol 2B)

Development 2022-01-01 to 2023-12-31, BTC / ETH / SOL, OKX fees. **All four configurations failed; the validation window was not run.**

| Config | Trades | Win % | PF | Mean R | Notes |
|---|---|---|---|---|---|
| 15m R0 | 23 | 17 | 1.00 | +0.00 | too few trades; bootstrap lower bound -1.18 |
| 15m RT (time stop) | 24 | 17 | 0.82 | -0.15 | |
| 1h R0 / RT | 0 | - | - | - | the trend filter + resistance rules leave nothing |
| 15m R0 without the trend filter (control) | 208 | 16 | 0.66 | -0.33 | removing the 3.2% stop floor alone would have lost heavily |

Mechanism check: the 3.2% minimum stop was not the cause of the losses (without it the signals lose more); the trend filter avoids
the falling market of 2022-23 (BTC -9%, ETH -38%, SOL -40%) but leaves too few trades to judge. Crypto Intraday stays paused. A next
idea needs its own frozen protocol and data none of these tests touched (2024-01..09 stays unseen).

## 12. Moonshots out-of-sample (protocol 2C)

The SHIPPED Phase 79 rules, unchanged, on the 90 days before the Phase 79 window (2026-03-31 to 2026-06-29), 56 of the 62 coins with
data (5 had no candles that far back). **FAIL.**

| Fees | Trades | Win % | PF | Total R | Mean R | Halves PF | Bootstrap lower (95%) |
|---|---|---|---|---|---|---|---|
| Coinbase | 63 | 25 | **0.58** | -25.3 | -0.40 | 0.52 / 0.59 | -0.84 |
| Kraken | 123 | 28 | 0.74 | -26.2 | -0.21 | 0.56 / 0.85 | -0.50 |
| OKX | 123 | 28 | 0.82 | -16.6 | -0.14 | 0.63 / 0.94 | -0.42 |

(The trade count differs by venue because the cost gates admit more setups at lower fees.) The Phase 79 result (PF 1.40) did not hold
on data it was not designed on, which matches the live strategy exits (PF 0.82). Moonshots stays paused.

## 13. VM runbook (read-only; no deploy, no restart)

Run in the app folder on the VM (it downloads the two audit scripts from GitHub without changing the running code, audits a COPY of
the ledger, and prints the running version):

    git fetch origin
    git show origin/main:scripts/trade-audit.js > /tmp/trade-audit.js
    git show origin/main:scripts/audit-attribution.js > /tmp/audit-attribution.js
    cp server/data/ledger-state.json /tmp/ledger-snapshot.json
    node /tmp/trade-audit.js /tmp/ledger-snapshot.json --csv /tmp/audit.csv > /tmp/audit.txt
    git log -1 --oneline; pm2 ls

Then copy /tmp/audit.txt and /tmp/audit.csv off the VM (for example the Cloud Console SSH window's "Download file").

## 14. What remains uncertain

- The VM's trades after 28 September (not audited).
- Whether Alpaca Paper's simulated option fills resemble real fills; indicative quotes are not NBBO.
- Quick Flips on IEX bars is about break-even in the replay; only the forward test can show how real fills compare.
- Every historical option result rests on trade prints and modelled spreads.

---

# Phase 89c: operations and the full audit (2026-10-04)

## 15. VM version, enabled strategies, full audit: still blocked (no access), steps for you

This PC still has no gcloud CLI and no SSH key, and the project rule forbids messaging the live server, so neither the VM's running commit
nor its enabled strategies were verified. **What is known is LOCAL only:** this PC's ledger copy (last saved 2026-09-28) has no saved
strategy switches, which on 85b means every scanner except Crypto Swing ON, and cryptoMode live. The VM may differ.

**CORRECTED (Phase 89d):** the steps first written here took `trade-audit.js` / `audit-attribution.js` from 3998693, which lack the
accounting reconciliation (section A) and the input sha256 before / after added in 25b02f3. They are replaced by one pinned, read-only
script that also separates the checked-out commit from the commit the running process loaded, and reads the strategy switches the way the
loaded code does: `scripts/vm-audit.sh`, steps in `docs/deploy/phase85b-to-89c.md` section 1:

    cd ~/signaldesk-v2 && git fetch -q origin
    git show <C>:scripts/vm-audit.sh > /tmp/vm-audit.sh && bash /tmp/vm-audit.sh <C>    # <C> = the Phase 89d commit

Download `~/sd-audit-<time>.tgz` and say so; the reconciliation of the VM's trades (section 16 for the local copy) is then redone on it.

## 16. Accounting reconciliation vs hypotheses (local copy; the VM's trades are still missing)

**A. Accounting reconciliation** (`node scripts/trade-audit.js <copy>`, section A): recorded = the ledger, untouched; the rest are estimates.

| Book | Recorded | - paper overstatement | + LIVE fee difference | = Reconciled (est.) | bid/ask cost C | of which booked | missing (= overstatement) |
|---|---|---|---|---|---|---|---|
| Options Spreads PAPER (18) | +$354.18 | -$552.30 | $0.00 | **-$198.12** | $789.00 | $236.70 | $552.30 |
| Moonshots LIVE (17) | +$1.63 | 0 | $0.00 | +$1.63 | 0 | 0 | 0 |
| Manual LIVE (4) / PAPER (1) | -$3.71 / +$1.02 | 0 | 0 | -$3.71 / +$1.02 | 0 | 0 | 0 |

**The $552 and the $789 overlap; they must not be added.** The $789 is the whole round-trip bid/ask cost of the chosen contracts at natural
prices (legs' combined bid/ask x 100, exit width assumed equal to entry). The old paper model charged 30% of it ($236.70); the other 70%
($552.30) is exactly the overstatement. The reconciliation subtracts only that $552.30. LIVE fee difference: 0 here (the broker-reported fees
matched the ledger on every LIVE record that has them). Input file sha256 `442e51fa...` unchanged after the run.

**B. Hypotheses (why, not accounting),** summing to the reconciled net: Options Spreads -$198.12 = $0 at the plan's own levels (no strategy
exit ever fired) - $49.40 fees - $148.72 from the manual closes; Moonshots +$1.63 = +$1.04 at plan - $4.87 slippage and fees + $5.47 manual
closes. These are reconstructions, not records.

## 17. Deadline exits beyond 3:45 PM (verified in tests/ph89cunit.js)

- A Quick Flips deadline close is not gated by the 9:35-3:45 options window: a close first sent at 3:47 PM goes out and books the fill.
- Escalation is timed from the 3:40 PM deadline of the day the position opened: 25% under the best bid from 3:42 PM, 50% from 3:50 PM,
  re-priced every 20 s only when lower. Best bid = fresh quote, else the last known quote, else the model value.
- A restart near the close (all in-memory state lost) resumes from the persisted close and re-prices it.
- A rejected or unfilled close: the failure is recorded, the position stays monitored, the banner and an email say so ("not closed by its
  deadline" from 3:45 PM; "held overnight" once the session ends), and it is due at once the next session (the 50% tier).
- A partial closing fill books only the part sold; the rest stays open, alerted, and is closed next.
- **A re-priced limit order makes a fill likely; it does not guarantee a same-day close.** Protocol 2's "Same day, always" (frozen) is
  corrected by `phase89-protocol-2a-clarification.md`: an overnight hold is a protocol violation that is reported, not something that
  cannot happen.

## 18. What better data would and would not resolve

- **Would resolve (measurement):** real-time SIP would let live Quick Flips use the exact bars the replay used (removing the 50% signal
  mismatch); OPRA quotes would replace indicative quotes for stops, limits and paper marks; historical quotes (from a vendor, not Alpaca)
  would let replays price real bid / ask instead of modelled spreads.
- **Would NOT resolve (evidence):** none of it creates an edge. No tested strategy passed its pre-registered test on unseen data. Better
  data would only make the next test's verdict more trustworthy; it is not a profitability fix and is not recommended as one.
- **Strategy evidence still missing:** a strategy that passes a frozen protocol on unseen data, then a forward paper test with enough
  trades (150 for Quick Flips). Today only Quick Flips (S1, IEX version, about break-even in replay) is eligible for an isolated paper
  test, and only as a measurement exercise under protocol 2A.
