# Deploying Phase 93 (decision recorder)

**Record-only.** Trading rules, safeguards, approvals, exits, the paper-only lock and automation are unchanged. The server writes down
every decision it makes about a setup, so the Decision Review (`tools/decision-review`, run on the PC) can compare it with what the chart
did afterwards.

## What it records

- **Every decision path:**
  - strategy blocks, including filters that drop a signal that already fired;
  - pipeline rejections;
  - setups staged into Approvals;
  - approval holds, refusals and approvals;
  - execution refused;
  - your rejections;
  - expiries;
  - positions opened, filled, voided and closed.
- **The inputs each radar strategy actually used:** the full bar history it read and its signal values. They are kept beside the setup,
  never in the ledger or the browser.
- **Lifecycle events are kept in full.** Only a setup re-proposed every 60 s with the same outcome is counted (a `repeats` line) instead
  of re-written.

## Files and size

- `server/data/decisions-YYYY-MM-DD.jsonl` (New York date), next to the ledger. Git-ignored; `DECISIONS_DIR` overrides the folder.
- Each distinct bar series is written once per day. The harness wrote about 300 KB for its first 16 decisions; a full day on the VM should
  be a few MB at most.
- Files older than 180 days are deleted at boot.
- Off switch: `DECISIONS_RECORDER=off` in `.env`, then a restart.

## Non-blocking by design

- The trading path only copies references into a bounded queue of 5,000. Overflow drops the oldest and is counted.
- Serialization and the disk write run on a 5-second background timer, in 10 ms slices, with one write at a time. A failed write is retried
  and counted.
- A stuck disk never delays a decision.

## How to verify after the deploy

1. `GET /api/version` (signed in) has `decisionRecorder`: `enabled: true`, `recordedToday`, `dropped: 0`, `writeErrors: 0`, `lastWriteAt`.
2. **Settings > Strategies** footer: "Decision recorder: N today · 0 dropped · 0 write errors · last write HH:MM". It turns amber on drops,
   write errors or decisions recorded without their inputs.
3. After a market session, the audit script prints `decision recorder files: N day(s), M lines; warnings logged: 0`, and the archive has a
   `decisions/` folder:

       cd ~/signaldesk-v2 && git show <commit>:scripts/vm-audit.sh > /tmp/vm-audit.sh && bash /tmp/vm-audit.sh <commit>

4. On the PC: `node tools/decision-review/run.js <extracted archive folder>` writes the local report to `reports/`.

## Rollback

Older code never reads the decision files. `scripts/rollback-vm.sh` works as before, and the files simply stop growing.
