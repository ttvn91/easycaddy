#!/usr/bin/env bash
# easycaddy uninstaller (keeps Caddy + /etc/caddy intact)
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Must run as root: sudo $0"; exit 1; }

systemctl disable --now easycaddy 2>/dev/null || true
rm -f /etc/systemd/system/easycaddy.service
systemctl daemon-reload
rm -rf /opt/easycaddy

echo "[easycaddy] Removed easycaddy. Caddy and /etc/caddy are untouched."
echo "To fully remove Caddy: apt purge caddy && rm -rf /etc/caddy /var/log/caddy"
