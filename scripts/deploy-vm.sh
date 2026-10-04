#!/usr/bin/env bash
# Update SignalDesk on the Compute Engine VM to a reviewed commit and restart it under pm2.
#
#   TARGET=<commit> bash scripts/deploy-vm.sh   # RECOMMENDED: the exact commit that was reviewed (Phase 89c+)
#   bash scripts/deploy-vm.sh                   # whatever origin/main is right now (not pinned)
#   bash scripts/deploy-vm.sh signaldesk        # or name the pm2 app
#   FORCE=1 ...                                 # discard local edits to TRACKED files on the VM
#   First deploy from a version without this script: git show <commit>:scripts/deploy-vm.sh > /tmp/deploy-vm.sh, then
#   SIGNALDESK_ROOT="$PWD" TARGET=<commit> bash /tmp/deploy-vm.sh   (see docs/deploy/phase85b-to-89c.md)
#
# Steps: fetch origin -> refuse if tracked files were edited on the VM (unless FORCE=1) -> read-only pre-flight (running commit, open
# positions, waiting setups) -> BACK UP server/data (ledger, holdings, paper runs, radar, vault) to server/data/backups/deploy-<time>/
# -> syntax / line-limit check of TARGET in a temporary worktree -> reset to TARGET -> pm2 restart + save -> confirm the commit the server
# REPORTS at boot ("[version] running <commit>", Phase 89c+) -> print the rollback command. .env and server/data/ are untracked: never
# overwritten. Phase 89d: the running server keeps its exits until the restart: the check runs BEFORE the live checkout changes (the old
# process loads modules lazily, so a changed tree under it is a mixed version), and npm ci runs only when package-lock.json changed, then
# with the app STOPPED for the install (it deletes node_modules under a running process); the reset is followed at once by the restart.
set -euo pipefail

cd "${SIGNALDESK_ROOT:-$(dirname "$0")/..}" # SIGNALDESK_ROOT: run a copy of this script from elsewhere (the first deploy from an old version)
ROOT="$(pwd)"
command -v pm2 >/dev/null || { echo "pm2 is not installed (npm i -g pm2)"; exit 1; }

# The pm2 app: the argument / PM2_APP, else the one whose working directory is this folder.
APP="${1:-${PM2_APP:-}}"
if [ -z "$APP" ]; then
  APP="$(pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let list = []; try { list = JSON.parse(s); } catch { /* not JSON */ }
      const hit = list.filter((p) => p.pm2_env && p.pm2_env.pm_cwd === process.argv[1]);
      process.stdout.write(hit.length === 1 ? hit[0].name : "");
    });' "$ROOT")"
fi
if [ -z "$APP" ] || ! pm2 describe "$APP" >/dev/null 2>&1; then
  echo "Could not find the pm2 app for $ROOT. Running apps:"; pm2 ls
  echo "Re-run with its name: bash scripts/deploy-vm.sh <name>"; exit 1
fi
echo "== SignalDesk deploy: $ROOT (pm2 app '$APP')"

BEFORE="$(git rev-parse --short HEAD)"
git fetch --quiet origin
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked files were edited on this VM:"; git status --short --untracked-files=no
  if [ "${FORCE:-0}" != "1" ]; then echo "Nothing changed. Commit them from your PC instead, or re-run with FORCE=1 to discard them."; exit 1; fi
fi
REF="${TARGET:-origin/main}"
git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || { echo "Unknown TARGET '$REF' (after git fetch)"; exit 1; }
AFTER="$(git rev-parse --short "$REF^{commit}")"
[ -z "${TARGET:-}" ] && echo "== note: no TARGET given: deploying origin/main ($AFTER), not a pinned reviewed commit"

# Read-only pre-flight: what is open / waiting right now (the ledger is only READ here).
LEDGER="server/data/ledger-state.json"
if [ -f "$LEDGER" ]; then
  node -e '
    const L = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const by = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
    const pos = L.activePositions || [];
    console.log(`== pre-flight: ${pos.length} open (${JSON.stringify(by(pos, (p) => `${p.execution}/${p.market}`))}), ${(L.pendingOrders || []).length} waiting in Approvals`);
    const qf = pos.filter((p) => p.strategyId === "options-quickflips"); if (qf.length) console.log(`== WARNING: ${qf.length} Quick Flip position(s) open: deploy after they close`);
    const work = pos.filter((p) => p.fillEstimated || p.paperExitOrderId); if (work.length) console.log(`== note: ${work.length} position(s) with a working broker order (entry / exit): they resume after the restart`);
    const s = L.settings || {}; console.log(`== settings now: stockMode ${s.stockMode}, cryptoMode ${s.cryptoMode}, pauseVersion ${s.strategyPauseVersion ?? "none"}, switches ${JSON.stringify(s.strategiesEnabled || {})}`);
  ' "$LEDGER"
fi

# The target must pass the syntax / line check before the live checkout is touched.
CHECK_DIR="$(mktemp -d /tmp/sd-check-XXXXXX)"
git worktree add --quiet --detach "$CHECK_DIR" "$AFTER"
if ! (cd "$CHECK_DIR" && node scripts/check-limits.js); then git worktree remove --force "$CHECK_DIR"; echo "== $AFTER fails the syntax / line check: nothing changed"; exit 1; fi
git worktree remove --force "$CHECK_DIR"
DEPS_CHANGED=0; git diff --quiet "$BEFORE" "$AFTER" -- package.json package-lock.json || DEPS_CHANGED=1

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="server/data/backups/deploy-$STAMP-$BEFORE-to-$AFTER"
mkdir -p "$BACKUP"
for f in ledger-state.json external-holdings.json paper-runs.json moonshot-radar.json catalysts.json watchlist.json credentials.enc.json; do
  [ -f "server/data/$f" ] && cp -p "server/data/$f" "$BACKUP/"
done
printf 'before=%s\nafter=%s\ntime=%s\napp=%s\n' "$BEFORE" "$AFTER" "$STAMP" "$APP" > "$BACKUP/meta.txt"
echo "== backup: $BACKUP ($(ls "$BACKUP" | wc -l) files)"

if [ "$DEPS_CHANGED" = 1 ]; then
  echo "== dependencies changed: stopping $APP for npm ci (exits pause until the restart; venue-side stops stay at the venues)"
  pm2 stop "$APP" >/dev/null
fi
git reset --hard --quiet "$REF"
echo "== code: $BEFORE -> $(git rev-parse --short HEAD) ($(git log -1 --pretty=%s))"
if [ "$DEPS_CHANGED" = 1 ]; then echo "== npm ci"; npm ci --no-audit --no-fund --loglevel=error; else echo "== dependencies unchanged: npm ci skipped"; fi

echo "== pm2 restart $APP"
pm2 restart "$APP" --update-env >/dev/null
pm2 save >/dev/null

# Venue keys the crypto waterfall needs (names only).
MISSING=""
for k in COINBASE_API_KEY COINBASE_API_SECRET OKX_API_KEY OKX_API_SECRET OKX_API_PASSPHRASE KRAKEN_API_KEY KRAKEN_API_SECRET; do
  grep -qE "^${k}=.+" .env 2>/dev/null || MISSING="$MISSING $k"
done
[ -n "$MISSING" ] && echo "== note: not set in .env (that venue stays off):$MISSING"

RUNNING=""
for _ in $(seq 1 30); do # the boot takes a while on an e2-micro: wait up to 90 s for the version line
  sleep 3; LOG="$(pm2 logs "$APP" --lines 80 --nostream 2>&1 || true)"
  echo "$LOG" | grep -qF "[version] running $AFTER" && break
done
echo "$LOG" | tail -30
RUNNING="$(echo "$LOG" | grep -o '\[version\] running [0-9a-f]*' | tail -1 | awk '{print $3}')"
if [ "$RUNNING" = "$AFTER" ]; then echo "== VERIFIED: the server reports it is running $RUNNING"; else echo "== CHECK: expected $AFTER, the server log reports '${RUNNING:-nothing}' (versions before Phase 89c do not log it)"; fi
echo "$LOG" | grep -E 'research pause' | tail -1 || true
echo "$LOG" | grep -E 'Phase 91 radar mode' | tail -1 || true
echo "== rollback (if needed): bash scripts/rollback-vm.sh $BACKUP"
echo "== deployed $AFTER. If crypto is LIVE here, keep every other SignalDesk server on PAPER (one live server per set of keys)."
