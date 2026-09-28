#!/usr/bin/env bash
# SignalDesk one-line installer for a free Google Cloud e2-micro VM (Debian / Ubuntu).
#
#   curl -fsSL https://raw.githubusercontent.com/SamuelClark04/signaldesk-v2/main/scripts/install-free-vm.sh | bash
#
# Safe to run again (every step checks first): it never replaces an existing .env or ledger.
#   1. a 2 GB /swapfile when no swap is active (the e2-micro has 1 GB of RAM)
#   2. git, curl, Node.js 20, pm2 and cloudflared when missing
#   3. clones (or fast-forwards) the repo into ~/signaldesk-v2 and runs npm ci
#   4. a new .env (only if there is none): a random 32-character access token, LAN access on, the
#      Cloudflare tunnel on (the names the server reads: LAN_ACCESS_TOKEN, LAN_ACCESS, TUNNEL)
#   5. starts SignalDesk under pm2 (IPv4-first DNS, 768 MB heap), saves it and enables start on boot
#   6. waits for the tunnel and prints the sign-in link + what to do next
# Options (environment): APP_DIR (~/signaldesk-v2), APP_NAME (signaldesk), REPO_URL, LAN=0 (listen on
# 127.0.0.1 only: the tunnel reaches it there anyway).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/SamuelClark04/signaldesk-v2.git}"
APP_DIR="${APP_DIR:-$HOME/signaldesk-v2}"
APP_NAME="${APP_NAME:-signaldesk}"
LAN="${LAN:-1}"
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
say() { printf '\n== %s\n' "$*"; }
missing() { ! command -v "$1" >/dev/null 2>&1; }

# ---------- 1. swap ----------
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  say "Creating a 2 GB swap file (the e2-micro has 1 GB of RAM)"
  [ -f /swapfile ] || $SUDO fallocate -l 2G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
else
  say "Swap already active: $(swapon --show --noheadings | awk '{print $1" "$3}' | head -1)"
fi

# ---------- 2. packages ----------
if missing git || missing curl || missing openssl; then
  say "Installing git, curl and openssl"
  $SUDO apt-get update -y -qq
  $SUDO apt-get install -y -qq git curl ca-certificates openssl >/dev/null
fi
NODE_MAJOR="$(node -v 2>/dev/null || echo v0)"
NODE_MAJOR="${NODE_MAJOR#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  say "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs >/dev/null
fi
if missing pm2; then say "Installing pm2"; $SUDO npm install -g pm2 --silent >/dev/null; fi
if missing cloudflared; then
  say "Installing cloudflared (the free Cloudflare tunnel: an https link, no open ports)"
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  $SUDO dpkg -i /tmp/cloudflared.deb >/dev/null
  rm -f /tmp/cloudflared.deb
fi
echo "node $(node -v) · pm2 $(pm2 -v) · $(cloudflared --version 2>&1 | head -1)"

# ---------- 3. code ----------
if [ -d "$APP_DIR/.git" ]; then
  say "Updating $APP_DIR"
  git -C "$APP_DIR" pull --ff-only --quiet || { echo "Could not fast-forward $APP_DIR (local edits?). Fix or remove it, then run this again."; exit 1; }
else
  say "Downloading SignalDesk into $APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
say "Installing dependencies (npm ci)"
npm ci --no-audit --no-fund --loglevel=error

# ---------- 4. .env ----------
if [ ! -f .env ]; then
  say "Creating .env with a new private access token"
  TOKEN="$(openssl rand -hex 16)" # 32 random characters
  umask 077
  cat > .env <<EOF
# SignalDesk settings (created by scripts/install-free-vm.sh on $(date -u +%Y-%m-%d)).
# Your private access token: anyone who has it can open your SignalDesk. Never share it.
# It also encrypts the broker keys you save in Settings > Accounts & Connections: changing it
# means entering those keys again.
LAN_ACCESS_TOKEN=${TOKEN}
LAN_ACCESS=$([ "$LAN" = "1" ] && echo true || echo false)
TUNNEL=on
PORT=3000
EOF
  umask 022
else
  say ".env already exists: kept as it is"
fi
TOKEN="$(grep -E '^(LAN_ACCESS_TOKEN|ACCESS_TOKEN)=' .env | head -1 | cut -d= -f2- | tr -d '\r')"

# ---------- 5. pm2 ----------
export NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=768"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  say "Restarting SignalDesk (pm2 app '$APP_NAME')"
  pm2 flush "$APP_NAME" >/dev/null 2>&1 || true
  pm2 restart "$APP_NAME" --update-env >/dev/null
else
  say "Starting SignalDesk under pm2 (app '$APP_NAME')"
  pm2 start server/server.js --name "$APP_NAME" --cwd "$APP_DIR" --time >/dev/null
fi
pm2 save >/dev/null
$SUDO env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$(id -un)" --hp "$HOME" >/dev/null 2>&1 || echo "(pm2 startup could not be enabled; run: pm2 startup)"
pm2 save >/dev/null

# ---------- 6. the link ----------
say "Waiting for the Cloudflare tunnel (up to 2 minutes)"
URL=""
for _ in $(seq 1 60); do
  URL="$(pm2 logs "$APP_NAME" --nostream --lines 300 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
  [ -n "$URL" ] && break
  sleep 2
done

LINK="${URL:+$URL/?token=$TOKEN}"
line() { printf '| %-74s |\n' "$1"; }
bar="+$(printf '%*s' 76 '' | tr ' ' '-')+"
echo
echo "$bar"
line "SignalDesk is running"
line ""
if [ -n "$URL" ]; then
  line "Open this link (it signs you in; keep it private, it contains your token):"
  echo "  $LINK"
else
  line "The tunnel link is not up yet. Show it with:"
  line "  pm2 logs $APP_NAME --lines 300 | grep trycloudflare"
  line "then open  <that address>/?token=<LAN_ACCESS_TOKEN from $APP_DIR/.env>"
fi
line ""
line "Next steps:"
line " 1. Open the link on your computer or phone."
line " 2. Settings > Accounts & Connections > Alpaca Paper: paste your PK... API key"
line "    and secret (app.alpaca.markets > Paper Trading > API Keys) > Test & Save."
line " 3. Optional, any time: Alpaca Live, Coinbase, Kraken, OKX, Gmail (for links)."
line " 4. Trades start on PAPER (virtual money). Nothing is live until you choose it."
line ""
line "The link changes when the VM restarts: run the pm2 logs command above."
line "Update later: bash $APP_DIR/scripts/deploy-vm.sh"
echo "$bar"
