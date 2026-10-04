# Deployment review: VM upgrade from its verified version to Phase 89c / 89d

**Target:** the Phase 89d commit (named in its report; on the VM: `git log origin/main -1 --format=%h -- scripts/vm-audit.sh`). Its
`server/` and `client/` are identical to 25b02f3 (Phase 89c): 89d changes only the audit / deploy / rollback scripts and docs, so the
running code is 89c's and the Quick Flips forward test configuration is unchanged (`git diff --stat 25b02f3 <target> -- server client`
prints nothing). **Starting point: b24e750 (Phase 88), possibly 73b3192 (Phase 87); NOT 85b.** Evidence from the VM ledger itself (audit
of 2026-10-04 04:30 UTC): its saved settings include `maxOptionEntriesPerDay` (added in 73b3192, Phase 87) and lack
`strategyPauseVersion` and an `options-quickflips` switch (added in b5e9ace, Phase 89), so the code that last wrote it was 87 or 88.
The exact commit is the reflog in the archive's `checkout.txt` (or the `<from>` in `server/data/backups/deploy-*-<from>-to-*`).
Phases 86-88 in section 2 are therefore already on the VM; only 89, 89b, 89c and 89d change anything.

**Status (2026-10-04):** the audit ran, but its result reached us only as two AI summaries that CONTRADICT each other (one: LOADED and
CHECKOUT 6381a58, process started 19 s before the archive, every scanner off by the pause; the other: b24e750, five scanners ON). The
archive's `checkout.txt` / `process.txt` decide which is true. If 6381a58 is already running, the deploy has happened: go to section 4.
If b24e750 is running, five scanners are ON (paper books): switch them Off in Settings > Strategies before anything else.

## 1. Before the deploy: read-only audit (no restart, no request to the server, no ledger write)

From the app folder on the VM (`<C>` = the target commit above):
```bash
cd ~/signaldesk-v2 && git fetch -q origin
git show <C>:scripts/vm-audit.sh > /tmp/vm-audit.sh && bash /tmp/vm-audit.sh <C>
```
Then download `~/sd-audit-<time>.tgz` (Cloud Console SSH window: gear menu > Download file). It holds a ledger COPY (keep it private;
no `.env`, no vault). The script refuses to run if the audit tools of `<C>` lack the Phase 89c reconciliation bridge and input fingerprint.

**Why not the old commands:** the earlier runbook (phase89-results.md section 15) took `trade-audit.js` / `audit-attribution.js` from
3998693. Those versions have no accounting reconciliation (section A: recorded - paper overstatement + LIVE fee difference) and no input
sha256 before / after; both were added in 25b02f3 and are unchanged since. Use `<C>`, never 3998693.

What it captures (files in the archive):

| File | Contents |
|---|---|
| `checkout.txt` | the commit on disk (HEAD), origin/main, tracked edits on the VM, the last 12 HEAD moves with times (reflog) |
| `process.txt` | pm2 apps (name, pid, status, cwd, restarts, last start; never the env), the process start time, **LOADED** vs **CHECKOUT**, files changed since the start, the server's own `[version]` line (89c+ only), a VERDICT |
| `settings.txt` | the strategy switches **as the loaded code reads them** (saved map + that version's defaults; 85b with no saved map = every scanner but Crypto Swing ON), stockMode / cryptoMode / paper broker, Quick Flips auto-paper, the daily profit target, limits, open positions, Approvals |
| `audit.txt`, `audit.csv` | the full trade-history audit of the copy: by strategy x execution x who closed it, exit reasons, A. accounting reconciliation, B. hypotheses, flags; input unchanged line |
| `fingerprint.txt`, `ledger-snapshot.json`, `paper-runs.json`, `pm2-logs.txt` | sha256 of the original before / after the copy and of the copy; the copy; the last 400 log lines |

**Checkout vs running process.** `git log -1` is only what is on disk. The process runs what was on disk when it STARTED: the script
takes the process start time (`ps`) and picks the reflog entry checked out at that moment (LOADED). VERDICT SAME = LOADED is HEAD, no
tracked edits, no server / client file changed since the start. DIFFERENT = the checkout moved after the start (a `git pull` without a
restart): the old commit is running. UNCERTAIN = edits or later file changes: Node loads modules lazily, so the process may run a mix
until a restart. From 89c on the server also states it: `[version] running <commit>` at boot and `GET /api/version` (signed-in).

## 1b. Gate before the deploy (decided on the audit)

**What the relayed audit shows (recorded P&L from the ledger; to be re-checked on the archive itself):** 29 closed records, first close
09/25 10:17 ET (the same LIVE PRCL record that opens the local copy), last 10/02 15:26 ET; recorded total -$12.49, no paper overstatement
(no closed paper option spreads), LIVE fee difference $0. By book: Moonshots LIVE 22 (-$4.13), manual LIVE 5 (-$5.17), Crypto Swing LIVE 1
(-$1.17), Equity Swing PAPER 1 (-$2.02). Compared with the local copy (40 records to 09/28): the LIVE history continues (21 -> 28 records:
+5 Moonshots -$5.76, +1 manual -$1.46, +1 Crypto Swing -$1.17, if the first 21 match by id), but the local copy's 19 closed PAPER records
(18 Options Spreads, recorded +$354.18 / reconciled about -$198.12, and 1 manual) and 7 of its 9 open paper spreads are NOT in the VM
snapshot, and there is no archived paper run (`paper runs archived: 0`). So that paper history is MISSING from this ledger, not archived
by the Phase 88 reset (which writes paper-runs.json first). Those spreads were internal paper (no Alpaca Paper orders), so nothing is left
working at a broker. Where it went is open: the pre-88 Danger-zone paper reset (no archive), or the VM ledger started from a different copy;
`ls -la server/data server/data/backups` on the VM shows any older ledger files. Settings now: stocks PAPER, crypto PAPER,
paperStockBroker internal; 4 open: 2 LIVE ETH at Coinbase (Pilot rotation, adopted hold), 2 PAPER Options Spreads.

**LIVE crypto under cryptoMode paper:** paper mode stops new LIVE entries and stops the live balance display (broker-state queries a venue
only in live mode), but NOT the monitoring of open LIVE positions: the reconciler and external-close query the venue whatever the mode. The
adopted hold is skipped by design (your coins, no SignalDesk stop). Check both against Coinbase itself (ETH balance >= the two positions'
size; open stop orders) until the archive is read.

Gate items:

1. **Loss reconciliation:** the VM archive's section A per strategy / book (recorded, reconciled, overstatement, LIVE fee difference)
   for the whole history, compared with the local copy's 40 records (to 2026-09-28: recorded +$353.12, reconciled -$199.18). Every LIVE
   loss traced to a record; any LIVE fee difference explained. Reported as recorded vs estimated, never mixed.
2. **What can trade now:** if `settings.txt` shows any scanner ON on the VM, switch them Off now in Settings > Strategies (85b has the
   switches): pausing entries does not need the deploy. Open positions keep their stops / targets either way.
3. **Open positions / Approvals:** note them (the deploy pre-flight prints them again). Reject waiting setups from paused strategies if
   you do not want them (they stay approvable after the deploy; they also expire in 8-30 minutes). No Quick Flips open (none can be on
   85b).
4. Deploy outside US market hours (after 4:15 PM ET or a weekend), with no order being submitted from the app.

## 2. What changes between 85b and the target, and what it does to a running ledger

| Phase | Change | Effect on the running state |
|---|---|---|
| 86 (already on the VM) | AI Analyst model fallback | none on trading |
| 87 (already on the VM) | Options Spreads off by default (saved choices kept); options 200-day history fix; option entry pacing (2 a day); backtest loader fix; scorecard "who closed it" | new automated option entries limited; open positions unchanged |
| 88 (already on the VM if it ran b24e750) | Paper runs archive (`paper-runs.json` next to the ledger, created only on a reset); the old paper reset refuses while Alpaca Paper positions are open | none until used |
| 89 | **One-time research pause** (Crypto Intraday, Equity Day, Equity Swing, Options Spreads, Crypto Swing switched OFF once); Quick Flips added (OFF, paper only); paper crypto buys at the ask + taker fee (new entries); **internal paper option spreads valued at the natural bid** (was mid - 0.15 x the legs' bid/ask); daily profit target (OFF); combined paper risk cap + max positions (0 = off); Alpaca Paper partial-fill sizing | open INTERNAL paper spreads show a lower value and their premium targets are harder to reach (stops still use the mid); LIVE positions unchanged |
| 89b | Moonshots paused (pause 90); Quick Flips IEX completeness, automatic paper execution, 1 contract, entry deadline, deadline re-pricing; a partial CLOSING fill books only the part sold | no automated scanner runs after the deploy |
| 89c | Version reporting (`[version] running <commit>` at boot, `GET /api/version`); Quick Flips deadline carried over + failure alerts; deploy backup / rollback scripts | none on open positions |
| 89d | Scripts / docs only: pinned read-only VM audit (`scripts/vm-audit.sh`); deploy checks the target BEFORE touching the live checkout and skips `npm ci` when the lockfile is unchanged; forward-test benchmarks labelled "vs indicative quotes" | none (server / client identical to 89c) |

**Migrations on the first boot (in memory, saved with the next ledger write; repeated safely if the server restarts before that):**
- New settings get their defaults: `dailyProfitTargetOn false`, `dailyProfitTarget 200`, `maxOpenPositions 0`, `quickFlipsAutoPaper true`,
  `maxOptionEntriesPerDay 2`, `strategyPauseVersion 90`.
- Pauses 89 and 90 switch every scanner OFF once (`[ledger] Phase 89 research pause: ...` in the log). Any you switch back on stays on.
- Nothing rewrites open positions, the journal or pending setups; the Phase 58 options migration is unchanged.

**Existing positions (monitoring and exits are preserved):** the strategy switches gate only scans and triggers
(strategy-runner, watch-triggers, trigger-proximity); every exit path (exit-pass: reconcile, stops / targets, ratchet, time-exits,
quickflip-exits, Alpaca Paper exits, the 5 s fast loop) runs whatever the switches say.
- LIVE crypto: exits unchanged; venue-side stops (OKX OCO, Kraken / Coinbase stops) keep working during the restart. Kraken T1 is
  app-side: checked again within seconds of the restart.
- Alpaca Paper (stocks / options): working orders stay at Alpaca and are picked up by the reconciler after the restart.
- Internal paper option spreads: marked at the natural bid from the first pass (section above).
- Adopted / Pilot / external holdings: unchanged. Pilot proposals still wait in Approvals (never executed automatically).

## 3. The deploy

The VM's own `scripts/deploy-vm.sh` is the OLD one (no pinned commit, no backup), so run the script of the target:
```bash
cd ~/signaldesk-v2 && git fetch -q origin
git show <C>:scripts/deploy-vm.sh > /tmp/deploy-vm.sh
SIGNALDESK_ROOT="$PWD" TARGET=<C> bash /tmp/deploy-vm.sh
```
Order (89d): pre-flight (open positions, working orders, switches) -> syntax / line check of `<C>` in a temporary worktree (a failure
changes nothing) -> backup of `server/data` to `server/data/backups/deploy-<time>-<from>-to-<to>/` -> reset to `<C>` -> restart at once
(85b -> 89d: the lockfile is unchanged, so no `npm ci`; if it ever changes, the app is stopped for the install and says so) -> waits up to
90 s for `VERIFIED: the server reports it is running <C>` (or a CHECK line) -> the rollback command. The old process keeps running its
exits until the restart; the code under it changes only for the seconds between the reset and the restart.

## 4. After the deploy (confirm what is running)

1. The script's `VERIFIED` line; `pm2 logs <app> --lines 100 --nostream | grep -E "\[version\]|research pause"`.
2. Run the audit again (`bash /tmp/vm-audit.sh <C>`): VERDICT SAME, LOADED = `<C>`, every switch off.
3. Signed in, `/api/version`: `commit` = `<C>`, `dirty` false, `strategyPauseVersion` 90, every `strategiesEnabled` value `false`,
   `dailyProfitTargetOn` false.
4. Settings > Strategies: every scanner Off; open positions and their counts as in the pre-flight.
5. Watch the log for 30 minutes (no repeated errors).

## 5. Operating rules during testing

- **Automated entries stay paused.** Every scanner stays Off; none is switched on without a strategy that passed its frozen test on
  unseen data. The only exception is a deliberate Quick Flips forward paper test (below).
- **Quick Flips: paper only.** Start it only with `stockMode paper` and `paperStockBroker alpaca` (Settings), then switch Options Quick
  Flips on and note the start date. The code refuses a live Quick Flip (order-router QUICKFLIPS_PAPER_ONLY) and never auto-executes
  when stockMode is live. Report: `node scripts/quickflips-forward-report.js <ledger copy> --start <date>` on a copy.
- **The $200 daily profit target stays OFF** (`dailyProfitTargetOn false`) for the whole test (protocol 2A section 7).
- **The $0.05 / $0.06 benchmarks** compare Alpaca Paper fills with Alpaca's INDICATIVE option quotes. They are not verified
  real-market slippage (no OPRA NBBO; simulated fills); the report and the protocol say so.
- No new strategy variants and no paid-data recommendation until this operational work (audit, reconciliation, deploy, checks) is done.

## 6. Rollback

`bash scripts/rollback-vm.sh server/data/backups/deploy-<time>-<from>-to-<to>` (from the target checkout):
- refuses while a Quick Flip position is open (the old code has no deadline exits);
- backs up the current data, stops the app, resets to `<from>` (`npm ci` only if the lockfile differs), restarts;
- keeps the CURRENT ledger and writes every scanner the old code knows explicitly OFF. Reason: versions before Phase 89 reject the switch
  map that names `options-quickflips` and fall back to their own defaults, which in 85b means every scanner except Crypto Swing ON;
- `RESTORE_LEDGER=1` instead puts the pre-deploy files back, which ERASES every trade recorded since the deploy: only if nothing traded.

## 7. Risks that remain

- The starting commit, the VM's switches and its full trade history are unverified until step 1 runs.
- The first boot runs every pause at once; strategies you had on stay off until you switch them back on.
- Internal paper option spreads re-marked lower can look like a sudden loss: the old marks overstated them.
- A Quick Flips close is a re-priced limit order: a fill is likely, a same-day close is not guaranteed (alerts report it).
