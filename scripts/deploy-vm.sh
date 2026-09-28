#!/usr/bin/env bash
# Update SignalDesk on the Compute Engine VM to GitHub's main and restart it under pm2.
#
#   bash scripts/deploy-vm.sh              # the pm2 app running from this folder (auto-detected)
#   bash scripts/deploy-vm.sh signaldesk   # or name the pm2 app
#   FORCE=1 bash scripts/deploy-vm.sh      # discard local edits to TRACKED files on the VM
#
# Steps: fetch origin -> refuse if tracked files were edited on the VM (unless FORCE=1) ->
# reset to origin/main -> npm ci (exactly package-lock.json) -> syntax / line-limit check ->
# list any venue keys missing from .env (names only, never values) -> pm2 restart + save ->
# the last log lines. .env and server/data/ (the ledger) are untracked: never touched.
set -euo pipefail

cd "$(dirname "$0")/.."
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
git reset --hard --quiet origin/main
echo "== code: $BEFORE -> $(git rev-parse --short HEAD) ($(git log -1 --pretty=%s))"

echo "== npm ci"
npm ci --no-audit --no-fund --loglevel=error
npm run --silent check:limits

# Venue keys the crypto waterfall needs (names only).
MISSING=""
for k in COINBASE_API_KEY COINBASE_API_SECRET OKX_API_KEY OKX_API_SECRET OKX_API_PASSPHRASE KRAKEN_API_KEY KRAKEN_API_SECRET; do
  grep -qE "^${k}=.+" .env 2>/dev/null || MISSING="$MISSING $k"
done
[ -n "$MISSING" ] && echo "== note: not set in .env (that venue stays off):$MISSING"

echo "== pm2 restart $APP"
pm2 restart "$APP" --update-env >/dev/null
pm2 save >/dev/null
sleep 6
pm2 logs "$APP" --lines 30 --nostream
echo "== deployed $(git rev-parse --short HEAD). If crypto is LIVE here, keep every other SignalDesk server on PAPER (one live server per set of keys)."
