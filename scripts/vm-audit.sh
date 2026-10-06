#!/usr/bin/env bash
# Read-only VM audit (Phase 89d). Captures, WITHOUT touching the running server (no restart, no request to it, no ledger write):
#   1. the CHECKOUT: the commit on disk now, tracked edits, when HEAD last moved (reflog);
#   2. the RUNNING PROCESS: its pm2 app, pid, start time, and the commit it LOADED = the reflog entry checked out when it started
#      (plus the tracked files changed on disk since then: Node loads modules lazily, so those may be mixed in until a restart);
#   3. what can trade: the strategy switches as the LOADED code reads them, the books' modes, open positions, Approvals;
#   4. the full trade-history audit (scripts/trade-audit.js + audit-attribution.js of the pinned commit) on a COPY of the ledger.
# Usage on the VM, from the app folder (pinned: the tools come from the commit you name, not from the checkout):
#   git fetch -q origin && git show <commit>:scripts/vm-audit.sh > /tmp/vm-audit.sh && bash /tmp/vm-audit.sh <commit>
# Output: ~/sd-audit-<time>/ and ~/sd-audit-<time>.tgz (download it). It holds a ledger COPY: keep it private. No .env, no vault.
set -uo pipefail
C="${1:?usage: bash /tmp/vm-audit.sh <commit to take the audit tools from>}"
ROOT="${SIGNALDESK_ROOT:-$PWD}"; cd "$ROOT"
[ -f server/server.js ] || { echo "Run this from the SignalDesk app folder (no server/server.js in $ROOT)"; exit 1; }
git rev-parse --verify --quiet "$C^{commit}" >/dev/null || { echo "Unknown commit $C: run git fetch origin first"; exit 1; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$HOME/sd-audit-$STAMP"; mkdir -p "$OUT/tools"

# Audit tools from the pinned commit, and proof they carry the Phase 89c fixes (reconciliation bridge + input fingerprint).
for f in trade-audit.js audit-attribution.js quickflips-forward-report.js vm-audit-settings.js; do git show "$C:scripts/$f" > "$OUT/tools/$f" 2>/dev/null || rm -f "$OUT/tools/$f"; done
FIX=ok
grep -q 'AA.bridge' "$OUT/tools/trade-audit.js" && grep -q 'Input file unchanged' "$OUT/tools/trade-audit.js" || FIX=MISSING
grep -q 'archivedRuns' "$OUT/tools/trade-audit.js" || FIX=MISSING # Phase 89d fix: archived paper runs were read from the wrong key (counted 0)
grep -q 'reconcile, attribute, bridge' "$OUT/tools/audit-attribution.js" || FIX=MISSING
[ -f "$OUT/tools/vm-audit-settings.js" ] || FIX=MISSING
[ "$FIX" = ok ] || { echo "The audit tools of $C lack the Phase 89c reconciliation / fingerprint, the archived-runs fix or vm-audit-settings.js: use a later commit"; exit 1; }

# 1. Checkout.
HEAD_FULL="$(git rev-parse HEAD)"; HEAD_S="$(git rev-parse --short HEAD)"
{
  echo "checkout HEAD   $(git log -1 --format='%h %cI %s')"
  echo "origin/main     $(git log -1 --format='%h %cI %s' origin/main 2>/dev/null)"
  echo "audit tools     $(git log -1 --format='%h %s' "$C")"
  echo "tracked edits:"; git status --porcelain --untracked-files=no | sed 's/^/  /'; echo "  (end)"
  echo "HEAD moves (reflog, newest first):"; git log -g -12 --date=iso --format='  %gd %h %gs' HEAD
} > "$OUT/checkout.txt" 2>&1

# 2. Running process (pm2 fields only: never the env, which can hold secrets).
APP="${PM2_APP:-}"; PID=""
if command -v pm2 >/dev/null; then
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let list = []; try { list = JSON.parse(s); } catch { /* not JSON */ }
      for (const p of list) { const e = p.pm2_env || {};
        console.log([p.name, p.pid, e.status, e.pm_cwd, e.pm_exec_path, e.restart_time, e.unstable_restarts, e.pm_uptime ? new Date(e.pm_uptime).toISOString() : "-", e.created_at ? new Date(e.created_at).toISOString() : "-", e.node_version].join("\t")); }
    });' > "$OUT/pm2-apps.tsv"
  [ -z "$APP" ] && APP="$(awk -F'\t' -v r="$ROOT" '$4 == r && $3 == "online" { print $1; exit }' "$OUT/pm2-apps.tsv")"
  [ -n "$APP" ] && PID="$(awk -F'\t' -v a="$APP" '$1 == a { print $2; exit }' "$OUT/pm2-apps.tsv")"
fi
[ -z "$PID" ] || [ "$PID" = 0 ] && PID="$(pgrep -f 'node .*server/server\.js' | head -1 || true)"
{
  echo "pm2 apps (name pid status cwd script restarts unstable last-start created node):"; sed 's/^/  /' "$OUT/pm2-apps.tsv" 2>/dev/null
  if [ -n "$PID" ] && [ -d "/proc/$PID" ]; then
    START="$(date -d "$(ps -o lstart= -p "$PID")" +%s)"
    echo "process         app '${APP:-?}' pid $PID cwd $(readlink "/proc/$PID/cwd") started $(date -u -d "@$START" +%FT%TZ)"
    LOADED="$(git log -g --date=unix --format='%gd %H' HEAD | sed -E 's/^HEAD@\{([0-9]+)\} /\1 /' | awk -v s="$START" '$1 <= s { print $2; exit }')"
    CHANGED="$(git ls-files -z server client | xargs -0 stat -c '%Y %n' 2>/dev/null | awk -v s="$START" '$1 > s { print $2 }')"
    NCH="$(printf '%s' "$CHANGED" | grep -c . || true)"
    if [ -n "$LOADED" ]; then echo "LOADED at start $(git log -1 --format='%h %cI %s' "$LOADED")"; else echo "LOADED at start unknown (the reflog does not reach back to the start time)"; fi
    echo "CHECKOUT now    $(git log -1 --format='%h %cI %s' HEAD)"
    echo "tracked server / client files changed on disk since the start: $NCH"; printf '%s\n' "$CHANGED" | head -20 | sed '/^$/d; s/^/  /'
    if [ "$LOADED" = "$HEAD_FULL" ] && [ "$NCH" = 0 ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then echo "VERDICT: SAME. The running process loaded the checked-out commit $HEAD_S."
    elif [ -n "$LOADED" ] && [ "$LOADED" != "$HEAD_FULL" ]; then echo "VERDICT: DIFFERENT. The process runs $(git rev-parse --short "$LOADED") (loaded at start); the checkout moved to $HEAD_S afterwards and is NOT running until a restart (lazily loaded modules may come from the newer files)."
    else echo "VERDICT: UNCERTAIN. See the edits / changed files above (the process may run a mix)."; fi
    echo "${LOADED:-}" > "$OUT/loaded-commit.txt"
  else echo "process         NOT FOUND (no pm2 app for $ROOT and no 'node server/server.js'): nothing is running this checkout"; fi
  echo "server's own version line (Phase 89c+ logs it at boot; none = older code):"
  [ -n "$APP" ] && pm2 logs "$APP" --lines 2000 --nostream 2>/dev/null | grep -o '\[version\] running .*' | tail -3 | sed 's/^/  /'
} > "$OUT/process.txt" 2>&1
[ -n "$APP" ] && pm2 logs "$APP" --lines 400 --nostream > "$OUT/pm2-logs.txt" 2>&1

# 3 + 4. Ledger COPY (the server writes it by atomic rename, so a copy is one consistent save), switches, modes, audit.
L=server/data/ledger-state.json
H0="$(sha256sum "$L" | cut -c1-64)"; cp -p "$L" "$OUT/ledger-snapshot.json"; H1="$(sha256sum "$L" | cut -c1-64)"
for f in paper-runs.json external-holdings.json; do [ -f "server/data/$f" ] && cp -p "server/data/$f" "$OUT/$f"; done
# Phase 93: the decision recorder's files (last 35 days; read-only copies) + its log warnings, for tools/decision-review on the PC.
DD="${DECISIONS_DIR:-$(dirname "$L")}"; mkdir -p "$OUT/decisions" # the recorder writes next to the ledger unless DECISIONS_DIR is set
find "$DD" -maxdepth 1 -name 'decisions-*.jsonl' -mtime -35 -exec cp -p {} "$OUT/decisions/" \; 2>/dev/null
[ -n "$APP" ] && pm2 logs "$APP" --lines 5000 --nostream 2>/dev/null | grep 'decision-recorder' > "$OUT/decisions/recorder-log.txt"
echo "decision recorder files: $(ls "$OUT/decisions"/decisions-*.jsonl 2>/dev/null | wc -l) day(s), $(cat "$OUT/decisions"/decisions-*.jsonl 2>/dev/null | wc -l) lines; warnings logged: $(wc -l < "$OUT/decisions/recorder-log.txt" 2>/dev/null || echo 0)"
# Phase 94: the event capture files (last 35 days; read-only copies), the news cursor, and the saved watchlist (the universe-v1 freeze).
ED="${EVENTS_DIR:-$(dirname "$L")}" # pm2 env vars are not visible to this shell: set them here if the app overrides them
find "$ED" -maxdepth 1 -name 'events-*.jsonl' -mtime -35 -exec cp -p {} "$OUT/decisions/" \; 2>/dev/null
[ -f "$ED/news-cursor.json" ] && cp -p "$ED/news-cursor.json" "$OUT/decisions/news-cursor.json"
[ -f server/data/watchlist.json ] && cp -p server/data/watchlist.json "$OUT/watchlist.json"
echo "event capture files: $(ls "$OUT/decisions"/events-*.jsonl 2>/dev/null | wc -l) day(s), $(cat "$OUT/decisions"/events-*.jsonl 2>/dev/null | wc -l) lines; watchlist copied: $([ -f "$OUT/watchlist.json" ] && echo yes || echo no)"
{ echo "original before copy $H0"; echo "original after copy  $H1"; echo "copy                 $(sha256sum "$OUT/ledger-snapshot.json" | cut -c1-64)"
  [ "$H0" = "$H1" ] || echo "(the server saved between the two hashes: the copy is still one consistent save)"; } > "$OUT/fingerprint.txt"
LC="$(cat "$OUT/loaded-commit.txt" 2>/dev/null)"; LC="${LC:-$HEAD_FULL}"
git show "$LC:server/strategies/strategy-toggles.js" > "$OUT/tools/toggles-loaded.js" 2>/dev/null
node "$OUT/tools/vm-audit-settings.js" "$OUT/ledger-snapshot.json" "$OUT/tools/toggles-loaded.js" > "$OUT/settings.txt" 2>&1
node "$OUT/tools/trade-audit.js" "$OUT/ledger-snapshot.json" --csv "$OUT/audit.csv" > "$OUT/audit.txt" 2>&1

tar czf "$OUT.tgz" -C "$HOME" "$(basename "$OUT")"
cat "$OUT/process.txt" | grep -E '^(process|LOADED|CHECKOUT|VERDICT|tracked server)'; echo
cat "$OUT/settings.txt" | head -14; echo
head -3 "$OUT/audit.txt"; grep -A12 '^A\. ACCOUNTING' "$OUT/audit.txt"; tail -1 "$OUT/audit.txt"
echo; echo "== done: $OUT.tgz  (download it; nothing on this VM was changed except this folder and the archive)"
