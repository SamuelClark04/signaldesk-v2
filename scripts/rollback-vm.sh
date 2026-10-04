#!/usr/bin/env bash
# Roll the VM back to the commit a deploy started from (Phase 89c). Usage:
#   bash scripts/rollback-vm.sh server/data/backups/deploy-<time>-<from>-to-<to>        # keep the CURRENT ledger (default)
#   RESTORE_LEDGER=1 bash scripts/rollback-vm.sh <backup dir>                            # also put the pre-deploy data files back
# Default keeps today's ledger: restoring the backup would ERASE every trade recorded since the deploy (while the broker still
# holds those positions). Instead, the strategy switches are made safe for the old code: versions before Phase 89 reject a switch map
# that names "options-quickflips" and would fall back to their own defaults (most scanners ON), so that key is removed and every
# remaining switch is set OFF before the old code starts. Refused while a Quick Flip is open (old code has no deadline exits).
# The current data files are backed up first. This script re-runs itself from /tmp (the reset below removes it from the checkout).
set -euo pipefail
if [ "${ROLLBACK_FROM_TMP:-0}" != "1" ]; then
  TMP="$(mktemp /tmp/sd-rollback-XXXXXX.sh)"; cp "$0" "$TMP"; chmod +x "$TMP"
  cd "$(dirname "$0")/.."; ROLLBACK_FROM_TMP=1 ROLLBACK_ROOT="$(pwd)" exec bash "$TMP" "$@"
fi
cd "$ROLLBACK_ROOT"
BACKUP="${1:?usage: bash scripts/rollback-vm.sh <backup dir from deploy-vm.sh>}"
[ -f "$BACKUP/meta.txt" ] || { echo "No $BACKUP/meta.txt: not a deploy-vm.sh backup"; exit 1; }
BEFORE="$(grep '^before=' "$BACKUP/meta.txt" | cut -d= -f2)"; APP="$(grep '^app=' "$BACKUP/meta.txt" | cut -d= -f2)"
LEDGER="server/data/ledger-state.json"
echo "== rollback to $BEFORE (pm2 app '$APP'), now at $(git rev-parse --short HEAD)"
node -e '
  const L = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const qf = (L.activePositions || []).filter((p) => p.strategyId === "options-quickflips");
  if (qf.length && process.env.FORCE !== "1") { console.error(`REFUSED: ${qf.length} Quick Flip position(s) open (${qf.map((p) => p.asset).join(", ")}); close them first (or FORCE=1)`); process.exit(1); }
' "$LEDGER"

pm2 stop "$APP" >/dev/null
SAFE="server/data/backups/rollback-$(date -u +%Y%m%dT%H%M%SZ)-current"
mkdir -p "$SAFE"; cp -p server/data/*.json "$SAFE/" 2>/dev/null || true; cp -p server/data/credentials.enc.json "$SAFE/" 2>/dev/null || true
echo "== current data backed up: $SAFE"
if [ "${RESTORE_LEDGER:-0}" = "1" ]; then
  echo "== RESTORE_LEDGER=1: putting the pre-deploy data files back (trades recorded since the deploy are removed from the ledger)"
  for f in "$BACKUP"/*.json "$BACKUP"/credentials.enc.json; do [ -f "$f" ] && cp -p "$f" server/data/; done
fi
DEPS_CHANGED=0; git diff --quiet HEAD "$BEFORE" -- package.json package-lock.json || DEPS_CHANGED=1
git reset --hard --quiet "$BEFORE"
if [ "$DEPS_CHANGED" = 1 ]; then npm ci --no-audit --no-fund --loglevel=error; else echo "== dependencies unchanged: npm ci skipped (shorter stop)"; fi
if [ "${RESTORE_LEDGER:-0}" != "1" ]; then
  # Every scanner the OLD code knows, written explicitly OFF (a missing or partial map falls back to that version's defaults: mostly ON).
  node -e '
    const fs = require("fs"); const f = process.argv[1]; const L = JSON.parse(fs.readFileSync(f, "utf8"));
    let ids = []; try { ids = require(process.cwd() + "/server/strategies/strategy-toggles").IDS; } catch { console.log("== this version has no strategy switches (before Phase 78): nothing to set"); process.exit(0); }
    const s = L.settings || {}; L.settings = { ...s, strategiesEnabled: Object.fromEntries(ids.map((id) => [id, false])) };
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(L, null, 2)); fs.renameSync(`${f}.tmp`, f);
    console.log(`== switches for the old code: every scanner OFF (${ids.join(", ")})`);
  ' "$LEDGER"
fi
pm2 restart "$APP" --update-env >/dev/null; pm2 save >/dev/null
sleep 8
pm2 logs "$APP" --lines 30 --nostream || true
echo "== rolled back to $(git rev-parse --short HEAD). Check Settings > Strategies: every scanner should be Off."
