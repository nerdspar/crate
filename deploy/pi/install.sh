#!/usr/bin/env bash
#
# Crate — Raspberry Pi appliance installer (Debian / Raspberry Pi OS Bookworm).
#
# Installs Node, builds Crate, and runs the server natively under systemd with
# CRATE_APPLIANCE=1 so it can drive the touchscreen's brightness/sleep and reboot.
# Run from a checked-out Crate repo:
#
#   sudo bash deploy/pi/install.sh              # server only
#   sudo bash deploy/pi/install.sh --kiosk      # also set up the fullscreen browser
#
# Music Assistant itself is NOT installed here — point MA_URL at your MA (e.g. a NAS),
# or run it in Docker with the co-hosted compose profile (see INSTALL.md).

set -euo pipefail

WITH_KIOSK=0
[[ "${1:-}" == "--kiosk" ]] && WITH_KIOSK=1

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash deploy/pi/install.sh ${*:-}" >&2
  exit 1
fi
command -v apt-get >/dev/null || { echo "This installer targets Debian / Raspberry Pi OS (apt)." >&2; exit 1; }

# The repo root = two levels up from this script.
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# The non-root user that owns the checkout / will run the kiosk.
RUN_USER="${SUDO_USER:-$(id -un)}"
DATA_DIR="/var/lib/crate"
ENV_FILE="$REPO_DIR/.env"
NODE_MAJOR=22

echo "==> Crate appliance install"
echo "    repo:  $REPO_DIR"
echo "    user:  $RUN_USER"
echo "    data:  $DATA_DIR"

# ---- Node ----
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  echo "==> Installing Node $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v)"

# ---- Build (as the repo owner, not root) ----
echo "==> Installing dependencies + building (this takes a while on a Pi)"
sudo -u "$RUN_USER" bash -lc "cd '$REPO_DIR' && npm ci && npm run build"

# ---- Data dir ----
install -d -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR"

# ---- Config (.env) ----
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE"
  read -rp "    Music Assistant URL [http://homeassistant.local:8095]: " MA_URL
  MA_URL="${MA_URL:-http://homeassistant.local:8095}"
  read -rp "    Music Assistant long-lived token (blank to add later in the admin): " MA_TOKEN
  cat > "$ENV_FILE" <<EOF
MA_URL=$MA_URL
MA_TOKEN=$MA_TOKEN
CRATE_PORT=8080
CRATE_HOST=0.0.0.0
CRATE_DATA_DIR=$DATA_DIR
CRATE_APPLIANCE=1
CRATE_MANAGES_MA=0
EOF
  chown "$RUN_USER:$RUN_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  echo "==> Keeping existing $ENV_FILE"
fi

# ---- systemd service (the server) ----
echo "==> Installing systemd service: crate.service"
cat > /etc/systemd/system/crate.service <<EOF
[Unit]
Description=Crate music-shelf server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Runs as root so appliance mode can drive the backlight (/sys/class/backlight),
# vcgencmd display power, and systemctl reboot without extra udev/polkit rules.
# It's a single-purpose LAN device; keep the admin off the public internet.
User=root
WorkingDirectory=$REPO_DIR/apps/server
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now crate.service

# ---- Optional: fullscreen kiosk browser ----
if [[ $WITH_KIOSK -eq 1 ]]; then
  echo "==> Setting up the kiosk browser (best-effort; Wayland/labwc on Pi OS Bookworm)"
  apt-get install -y cage chromium || apt-get install -y cage chromium-browser
  CHROMIUM="$(command -v chromium || command -v chromium-browser)"
  cat > /etc/systemd/system/crate-kiosk.service <<EOF
[Unit]
Description=Crate kiosk (fullscreen Chromium)
After=crate.service systemd-user-sessions.service
Wants=crate.service

[Service]
User=$RUN_USER
PAMName=login
TTYPath=/dev/tty1
Environment=XDG_RUNTIME_DIR=/run/user/%U
ExecStartPre=/bin/sh -c 'until curl -sf http://localhost:8080 >/dev/null; do sleep 1; done'
ExecStart=/usr/bin/cage -- $CHROMIUM --kiosk --noerrdialogs --disable-infobars --incognito --check-for-update-interval=31536000 http://localhost:8080
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
EOF
  systemctl daemon-reload
  systemctl enable crate-kiosk.service
  echo "    Kiosk installed. If the screen stays blank, this Pi's display stack may differ —"
  echo "    see the notes in INSTALL.md (X11 vs Wayland, seat/DRM access)."
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "==> Done."
echo "    Wall:  http://${IP:-<pi-ip>}:8080"
echo "    Admin: http://${IP:-<pi-ip>}:8080/admin/"
echo "    Logs:  journalctl -u crate -f"
[[ $WITH_KIOSK -eq 1 ]] && echo "    Reboot to launch the kiosk: sudo reboot"
