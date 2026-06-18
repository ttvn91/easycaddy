#!/usr/bin/env bash
# easycaddy installer — Caddy server + easycaddy web editor
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ttvn91/easycaddy/main/install.sh | sudo bash
#   OR
#   sudo ./install.sh
#
# Env vars (optional — when unset, the installer prompts interactively):
#   EASYCADDY_USER       — admin username (no default; prompted if unset)
#   EASYCADDY_PASS       — admin password (default: random 16-byte hex)
#   EASYCADDY_PORT       — listen port (default: 8091)
#   SKIP_CADDY_INSTALL   — set to 1 if Caddy is already installed
#   SKIP_BUN_INSTALL     — set to 1 if Bun is already installed

set -euo pipefail

PORT="${EASYCADDY_PORT:-8091}"
INSTALL_DIR="/opt/easycaddy"

log() { echo -e "\033[1;34m[easycaddy]\033[0m $*"; }
err() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Must run as root: sudo $0"

# Read a value interactively from the controlling terminal, even when this
# script is piped from curl (in which case stdin is not the user's terminal).
read_tty() {
  local prompt="$1" default="${2:-}" var
  if [[ -r /dev/tty ]]; then
    if [[ -n "$default" ]]; then
      read -r -p "$prompt [$default]: " var </dev/tty || true
    else
      read -r -p "$prompt: " var </dev/tty || true
    fi
    echo "${var:-$default}"
  else
    echo "$default"
  fi
}

# Admin username — prompt if not provided via env var.
if [[ -n "${EASYCADDY_USER:-}" ]]; then
  USER_NAME="$EASYCADDY_USER"
else
  USER_NAME="$(read_tty 'Admin username for easycaddy' '')"
  while [[ -z "$USER_NAME" || ! "$USER_NAME" =~ ^[A-Za-z0-9_.-]+$ ]]; do
    [[ -r /dev/tty ]] || err "EASYCADDY_USER is required when no TTY is available (e.g. piped install). Re-run with: sudo EASYCADDY_USER=<name> bash install.sh"
    echo "Username must be non-empty and only contain letters, digits, _ . -"
    USER_NAME="$(read_tty 'Admin username for easycaddy' '')"
  done
fi

# Admin password — env var wins; otherwise prompt interactively (silent input,
# with confirmation). An empty answer falls back to a random password.
if [[ -n "${EASYCADDY_PASS:-}" ]]; then
  PASS="$EASYCADDY_PASS"
elif [[ -r /dev/tty ]]; then
  read -r -s -p "Admin password for easycaddy (leave blank to auto-generate): " PASS </dev/tty || true
  echo >/dev/tty
  if [[ -n "${PASS:-}" ]]; then
    read -r -s -p "Confirm password: " PASS2 </dev/tty || true
    echo >/dev/tty
    [[ "$PASS" == "${PASS2:-}" ]] || err "Passwords do not match — re-run the installer."
  fi
fi
# Fall back to a random 16-byte hex password when none was provided.
if [[ -z "${PASS:-}" ]]; then
  PASS="$(openssl rand -hex 16 2>/dev/null || tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
  GENERATED_PASS=1
fi

OS_ID="$(. /etc/os-release && echo "$ID")"
case "$OS_ID" in
  debian|ubuntu) ;;
  *) err "Only Debian/Ubuntu are supported. Detected: $OS_ID" ;;
esac

if [[ "${SKIP_CADDY_INSTALL:-0}" != "1" ]] && ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy..."
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg openssl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  log "Caddy installed: $(caddy version | awk '{print $1}')"
else
  log "Caddy already installed: $(caddy version | awk '{print $1}')"
fi

if [[ "${SKIP_BUN_INSTALL:-0}" != "1" ]] && ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
  log "Bun installed: $(bun --version)"
else
  log "Bun already installed: $(bun --version 2>/dev/null || echo 'unknown')"
fi

log "Setting up /etc/caddy..."
mkdir -p /etc/caddy/snippets /etc/caddy/sites

if [[ ! -f /etc/caddy/Caddyfile ]] || ! grep -q "import sites" /etc/caddy/Caddyfile; then
  cat > /etc/caddy/Caddyfile <<'EOF'
{
	admin 127.0.0.1:2019
	log {
		output file /var/log/caddy/access.log {
			roll_size 100mb
			roll_keep 5
		}
	}
}

import snippets/*.caddy
import sites/*.caddy
EOF
  log "Created default /etc/caddy/Caddyfile"
fi

[[ -f /etc/caddy/snippets/default_headers.caddy ]] || cat > /etc/caddy/snippets/default_headers.caddy <<'EOF'
(default_headers) {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
}
EOF

mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/log.conf <<'EOF'
[Service]
ReadWritePaths=/var/log/caddy
EOF

log "Installing easycaddy to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

REPO="ttvn91/easycaddy"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /nonexistent)"

if [[ -f "$SCRIPT_DIR/server.ts" && -f "$SCRIPT_DIR/hosts.js" ]]; then
  # Running from a cloned repo — copy local files.
  log "Installing easycaddy from local files..."
  cp "$SCRIPT_DIR/server.ts" "$INSTALL_DIR/server.ts"
  cp "$SCRIPT_DIR/hosts.js"  "$INSTALL_DIR/hosts.js"
  [[ -f "$SCRIPT_DIR/favicon.png" ]] && cp "$SCRIPT_DIR/favicon.png" "$INSTALL_DIR/favicon.png"
else
  # Piped install (curl | bash) — download runtime files from GitHub. Pin to the
  # latest release tag for stability; override with EASYCADDY_REF (tag/branch).
  REF="${EASYCADDY_REF:-}"
  if [[ -z "$REF" ]]; then
    REF="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
            | grep -o '"tag_name"[^,]*' | head -1 | cut -d'"' -f4)" || true
    [[ -z "$REF" ]] && REF="main"
  fi
  log "Downloading easycaddy ($REF) from GitHub..."
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/server.ts" -o "$INSTALL_DIR/server.ts" || err "download server.ts failed"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/hosts.js"  -o "$INSTALL_DIR/hosts.js"  || err "download hosts.js failed"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/favicon.png" -o "$INSTALL_DIR/favicon.png" || log "warning: favicon download failed (non-fatal)"
fi

cat > /etc/systemd/system/easycaddy.service <<EOF
[Unit]
Description=easycaddy — minimal web editor for Caddyfile/snippets/sites
After=network.target caddy.service

[Service]
Type=simple
Environment=USER_NAME=$USER_NAME
Environment=PASS=$PASS
Environment=PORT=$PORT
ExecStart=/usr/local/bin/bun run $INSTALL_DIR/server.ts
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl restart caddy
systemctl enable --now easycaddy

sleep 2

if systemctl is-active --quiet easycaddy; then
  IP=$(hostname -I | awk '{print $1}')
  if [[ "${GENERATED_PASS:-0}" == "1" ]]; then
    PASS_DISPLAY="$PASS  (auto-generated — save it now!)"
  else
    PASS_DISPLAY="(the password you entered)"
  fi
  cat <<EOF

\033[1;32m============================================\033[0m
\033[1;32m  easycaddy is running!\033[0m
\033[1;32m============================================\033[0m

  URL (LAN):      http://$IP:$PORT
  Username:       $USER_NAME
  Password:       $PASS_DISPLAY

  Service:        systemctl {status|restart|stop} easycaddy
  Logs:           journalctl -u easycaddy -f
  Server source:  $INSTALL_DIR/server.ts
  Caddy config:   /etc/caddy/Caddyfile + snippets/ + sites/

  Change password: edit /etc/systemd/system/easycaddy.service
                   systemctl daemon-reload && systemctl restart easycaddy

  Public HTTPS:    add sites/easycaddy.caddy with reverse_proxy localhost:$PORT

EOF
else
  err "easycaddy failed to start. Check: journalctl -u easycaddy -n 50"
fi
