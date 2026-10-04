# Deployment review: VM upgrade from its verified version to Phase 89c

**Target:** the commit that adds this file (named in the Phase 89c report). **Starting point:** NOT verified from here (no VM access);
the last recorded deploy is `b57b376` (Phase 85b). Step 1 below verifies it; if the VM is on another commit, re-read section 2 for the
phases between that commit and the target (`git log --oneline <running>..<target>` on the VM).

## 1. Before the deploy (read-only)

Outside US market hours (after 4:15 PM ET or a weekend), with no order being submitted from the app:
1. Run the read-only steps in `docs/research/phase89-results.md` section 15 (running commit, `pm2 ls`, the settings that decide what can
   trade, the audit of a ledger COPY). Keep the output: it is the "before" picture.
2. Note the open positions and the setups waiting in Approvals (the new deploy script prints them again).
3. Decide what to do with setups waiting in Approvals from strategies that will be paused: they stay approvable after the deploy. Reject
   them first if you do not want them (they also expire on their own: 8-30 minutes).

## 2. What changes between 85b and the target, and what it does to a running ledger

| Phase | Change | Effect on the running state |
|---|---|---|
| 86 | AI Analyst model fallback | none on trading |
| 87 | Options Spreads off by default (saved choices kept); options 200-day history fix; option entry pacing (2 a day); backtest loader fix; scorecard "who closed it" | new automated option entries limited; open positions unchanged |
| 88 | Paper runs archive (`paper-runs.json` next to the ledger, created only on a reset); the old paper reset refuses while Alpaca Paper positions are open | none until used |
| 89 | **One-time research pause** (Crypto Intraday, Equity Day, Equity Swing, Options Spreads, Crypto Swing switched OFF once); Quick Flips added (OFF, paper only); paper crypto buys at the ask + taker fee (new entries); **internal paper option spreads valued at the natural bid** (was mid - 0.15 x the legs' bid/ask); daily profit target (OFF); combined paper risk cap + max positions (0 = off); Alpaca Paper partial-fill sizing | open INTERNAL paper spreads show a lower value and their premium targets are harder to reach (stops still use the mid); LIVE positions unchanged |
| 89b | Moonshots paused (pause 90); Quick Flips IEX completeness, automatic paper execution, 1 contract, entry deadline, deadline re-pricing; a partial CLOSING fill books only the part sold | no automated scanner runs after the deploy |
| 89c | Version reporting (`[version] running <commit>` at boot, `GET /api/version`); Quick Flips deadline carried over + failure alerts; deploy backup / rollback scripts | none on open positions |

**Migrations on the first boot (in memory, saved with the next ledger write; repeated safely if the server restarts before that):**
- New settings get their defaults: `dailyProfitTargetOn false`, `dailyProfitTarget 200`, `maxOpenPositions 0`, `quickFlipsAutoPaper true`,
  `maxOptionEntriesPerDay 2`, `strategyPauseVersion 90`.
- Pauses 89 and 90 switch every scanner OFF once (`[ledger] Phase 89 research pause: ...` in the log). Any you switch back on stays on.
- Nothing rewrites open positions, the journal or pending setups; the Phase 58 options migration is unchanged.

**Existing positions:**
- LIVE crypto: exits are unchanged; venue-side stops (OKX OCO, Kraken / Coinbase stops) keep working during the restart. Kraken T1 is
  app-side: it is checked again within seconds of the restart.
- Alpaca Paper (stocks / options): working orders stay at Alpaca and are picked up by the reconciler after the restart.
- Internal paper option spreads: marked at the natural bid from the first pass (section above).
- Adopted / Pilot / external holdings: unchanged.

## 3. The deploy

The VM's own `scripts/deploy-vm.sh` is the OLD one (no pinned commit, no backup) until the reset, so run the NEW script from the target:
```bash
cd ~/SignalDesk-V2                                            # the app folder
git fetch origin
git show <target>:scripts/deploy-vm.sh > /tmp/deploy-vm.sh
SIGNALDESK_ROOT="$PWD" TARGET=<target> bash /tmp/deploy-vm.sh
```
It prints the pre-flight (open positions, working orders, switches), backs up `server/data` to `server/data/backups/deploy-<time>-<from>-to-<to>/`,
resets to `<target>`, runs `npm ci` and the syntax / line check, restarts pm2, and prints `VERIFIED: the server reports it is running <target>`
or a CHECK line, then the rollback command.

## 4. After the deploy (confirm what is running)

1. The script's `VERIFIED` line; `pm2 logs <app> --lines 100 --nostream | grep -E "\[version\]|research pause"`.
2. Signed in, open `/api/version`: `commit` = target, `strategyPauseVersion` 90, every `strategiesEnabled` value `false`.
3. Settings > Strategies: every scanner Off; open positions and their counts as in the pre-flight.
4. Watch the log for 30 minutes (no repeated errors), then run the read-only audit again on a copy.

## 5. Rollback

`bash scripts/rollback-vm.sh server/data/backups/deploy-<time>-<from>-to-<to>` (from the target checkout):
- refuses while a Quick Flip position is open (the old code has no deadline exits);
- backs up the current data, stops the app, resets to `<from>`, `npm ci`;
- keeps the CURRENT ledger and writes every scanner the old code knows explicitly OFF. Reason: versions before Phase 89 reject the switch
  map that names `options-quickflips` and fall back to their own defaults, which in 85b means every scanner except Crypto Swing ON;
- `RESTORE_LEDGER=1` instead puts the pre-deploy files back, which ERASES every trade recorded since the deploy: only if nothing traded.

## 6. Risks that remain

- The starting commit is unverified until step 1 runs.
- The first boot runs every pause at once; strategies you had on stay off until you switch them back on.
- Internal paper option spreads re-marked lower can look like a sudden loss: the old marks overstated them.
