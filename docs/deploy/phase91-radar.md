# Deploying Phase 91 (radar mode)

SignalDesk becomes an alerts-only radar: scanners stage setups into Approvals for your click, everything executes on paper only
(`risk/paper-lock.js`), and crypto is manual-only (charts + the Manual Trade Ticket; no crypto scanner ever runs).
Spec: docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md.

## What the first boot does (once per ledger)

- Modes stay paper. A ledger saved with `stockMode` / `cryptoMode` = `live` loads as `paper` (logged `[ledger] ignoring saved setting: PAPER_ONLY_LOCK ...`);
  saving a live mode is refused. Nothing is sold or canceled by the migration: open LIVE records and external holdings stay in the ledger as they were
  (SignalDesk sends no new real order for them).
- Log line `[ledger] Phase 91 radar mode: equity-day, equity-swing, options-system, options-quickflips switched on (setups wait in
  Approvals, paper only); crypto scanners manual-only`: the four stock / options scanners are ON (each setup carries its failed test
  record), the three crypto scanners are OFF whatever a saved switch says. `settings.radarVersion` = 1 is then saved; a scanner you
  switch off afterwards stays off. `quickFlipsAutoPaper` is dropped from the saved settings (Quick Flips no longer execute on their own).
- `scripts/deploy-vm.sh` prints this line (with the `research pause` one) after the version check.

## How to verify

1. `GET /api/version` (signed in): `paperOnly: true`, `radarVersion: 1`, `stockMode` / `cryptoMode` `paper`, `strategiesEnabled` with the four
   radar ids `true` and the crypto ids `false`.
2. Settings > Strategies shows "Radar (alerts only)" / "Manual-only" notes; Settings > Accounts shows the paper-only lock.
3. Read-only audit before or after the deploy: `bash scripts/vm-audit.sh <commit>`. Its switch table applies the same radar migration the
   running code applies, so a run right after deploying shows what the server uses (`radarVersion` is printed with the modes).
4. Wait for a setup: it must stay pending in Approvals until you click Approve (no position opens by itself).

## Rollback quirk

`scripts/rollback-vm.sh` keeps the ledger and writes every scanner OFF for the older code (it rejects unknown ids and would fall back to
mostly-ON defaults). If the older code never saves the ledger before you deploy Phase 91 again, `radarVersion` 1 is still in the file and
the radar migration will NOT run again: the scanners stay OFF. Switch the four radar scanners on in Settings > Strategies (crypto stays
manual-only).

## External holdings

Holdings that live at a broker outside SignalDesk (adopted / synced, Pilot sell and trim actions) are never sold by SignalDesk now: the
action fails with `BROKER_PAPER_MODE: SignalDesk is paper-only, so it sends no real order; sell it in <broker>'s own app.` Sell them in the
broker's own app; the ledger follows on the next sync.
