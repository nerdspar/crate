#!/usr/bin/env bash
#
# Crate — Raspberry Pi appliance installer (Debian / Raspberry Pi OS Bookworm).
#
# Installs Node, builds Crate, and runs the server natively under systemd with
# CRATE_APPLIANCE=1 so it can drive the touchscreen's brightness/sleep and reboot.
# Interactive on first run: asks whether you already run Music Assistant (else it
# installs MA in Docker), and whether to set up the fullscreen kiosk display.
#
#   sudo bash deploy/pi/install.sh                 # asks the questions
#   sudo bash deploy/pi/install.sh --kiosk         # preset: yes kiosk
#   sudo bash deploy/pi/install.sh --no-kiosk      # preset: no kiosk

set -euo pipefail

KIOSK_PRESET=""
case "${1:-}" in
  --kiosk) KIOSK_PRESET=1 ;;
  --no-kiosk) KIOSK_PRESET=0 ;;
esac

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash deploy/pi/install.sh ${*:-}" >&2
  exit 1
fi
command -v apt-get >/dev/null || { echo "This installer targets Debian / Raspberry Pi OS (apt)." >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
DATA_DIR="/var/lib/crate"
ENV_FILE="$REPO_DIR/.env"
NODE_MAJOR=22
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

ensure_docker() {
  if ! command -v docker >/dev/null; then
    echo "==> Installing Docker"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
  fi
  usermod -aG docker "$RUN_USER" 2>/dev/null || true
}

echo "==> Crate appliance install"
echo "    repo:  $REPO_DIR"
echo "    user:  $RUN_USER"

# ---- Decisions (asked up front, before the long build) ----
EXISTING_MA=0
MA_URL=""
MA_TOKEN=""
if [[ ! -f "$ENV_FILE" ]]; then
  read -rp "==> Will you be using an existing Music Assistant installation? [y/N]: " USE_EXISTING
  if [[ "${USE_EXISTING:-}" =~ ^[Yy] ]]; then
    EXISTING_MA=1
    read -rp "    Music Assistant URL [http://homeassistant.local:8095]: " MA_URL
    MA_URL="${MA_URL:-http://homeassistant.local:8095}"
    read -rp "    Long-lived token (optional — leave blank to sign in from Crate later): " MA_TOKEN
  fi
fi

if [[ -n "$KIOSK_PRESET" ]]; then
  WITH_KIOSK=$KIOSK_PRESET
else
  read -rp "==> Set up the fullscreen kiosk display on this Pi (drive the touchscreen)? [Y/n]: " K
  [[ "${K:-Y}" =~ ^[Nn] ]] && WITH_KIOSK=0 || WITH_KIOSK=1
fi

# ---- Node ----
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  echo "==> Installing Node $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v)"

# ---- Build (as the login user, not root, so node_modules isn't root-owned) ----
# The build runs as $RUN_USER, so the checkout must be writable by them. A repo cloned
# via sudo is root-owned and `npm ci` would fail with EACCES creating node_modules — fix it.
if [[ "$(stat -c '%U' "$REPO_DIR")" != "$RUN_USER" ]]; then
  echo "==> Fixing checkout ownership ($REPO_DIR -> $RUN_USER)"
  chown -R "$RUN_USER:$RUN_USER" "$REPO_DIR"
fi
echo "==> Installing dependencies + building (this takes a while on a Pi)"
sudo -u "$RUN_USER" bash -lc "cd '$REPO_DIR' && npm ci && npm run build"

# ---- Music Assistant container (co-hosted only) ----
if [[ ! -f "$ENV_FILE" && $EXISTING_MA -eq 0 ]]; then
  ensure_docker
  echo "==> Starting the Music Assistant container"
  docker rm -f music-assistant >/dev/null 2>&1 || true
  docker run -d --name music-assistant --restart unless-stopped --network host \
    -v music-assistant-data:/data ghcr.io/music-assistant/server:latest
fi

# ---- Data dir ----
install -d -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR"

# ---- Config (.env) ----
MA_NOTE=""
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE"
  if [[ $EXISTING_MA -eq 1 ]]; then
    MANAGES_MA=0
    [[ -z "$MA_TOKEN" ]] && MA_NOTE="No MA token yet — open Crate's admin and the setup wizard will sign you in (or paste a token). You can also do it later in Settings → Music Assistant."
  else
    MA_URL="http://localhost:8095"
    MA_TOKEN=""
    MANAGES_MA=1
    MA_NOTE="Music Assistant is running — nothing to configure there. Open Crate's admin; the setup wizard creates your Music Assistant account and its own token."
  fi
  cat > "$ENV_FILE" <<EOF
MA_URL=$MA_URL
MA_TOKEN=$MA_TOKEN
CRATE_PORT=80
CRATE_HOST=0.0.0.0
CRATE_DATA_DIR=$DATA_DIR
CRATE_APPLIANCE=1
CRATE_MANAGES_MA=$MANAGES_MA
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
# Watchdog: the server sends a WATCHDOG=1 heartbeat every ~half of this (see apps/server/src/watchdog.ts).
# If it stops — a wedged event loop or a locked DB — systemd kills + relaunches the wall (Restart=always).
# 90s leaves ample margin for a slow cold start (tsx transpile + native sqlite load) on a small Pi.
# NotifyAccess=all accepts the heartbeat from the systemd-notify helper the server shells out to,
# since Node can't write the AF_UNIX notify datagram itself.
WatchdogSec=90
NotifyAccess=all
# Memory ceiling as a share of total RAM, so it adapts to the hardware automatically
# (systemd computes it per host: ~680M on a 1GB Pi, ~3G on a 4GB Pi, ~6G on an 8GB Pi).
# A leak/runaway is killed + restarted instead of taking down the whole Pi; it's a cap,
# not a reservation, and normal use (a few hundred MB incl. sharp artwork) stays well under.
MemoryMax=75%

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable crate.service
# restart (not just enable --now): a reinstall must (re)start the running service so unit changes
# like WatchdogSec/MemoryMax actually take effect — daemon-reload alone won't re-apply them.
systemctl restart crate.service

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
ExecStartPre=/bin/sh -c 'until curl -sf http://localhost/wall/ >/dev/null; do sleep 1; done'
# GPU flags: the wall leans on a CSS blur (the album glow) that is fill-rate heavy. Pi GPUs sit on
# Chromium's default blocklist, so without these the blur falls back to SOFTWARE rasterization on the
# CPU and janks on open (invisible on a fast dev machine, brutal on a Pi). --ignore-gpu-blocklist +
# --enable-gpu-rasterization move it onto the VideoCore GPU; --enable-zero-copy trims GPU<->CPU copies.
# These don't touch the display backend (cage's Wayland surface still comes up the same way), so they
# won't blank the screen. If a given Pi still can't get GPU raster, add --use-gl=egl (or angle) here.
ExecStart=/usr/bin/cage -- $CHROMIUM --kiosk --noerrdialogs --disable-infobars --incognito --check-for-update-interval=31536000 --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy http://localhost/wall/
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

echo
echo "==> Done."
echo "    Admin: http://${IP:-<pi-ip>}/"
echo "    Wall:  http://${IP:-<pi-ip>}/wall/"
echo "    Logs:  journalctl -u crate -f"
[[ -n "$MA_NOTE" ]] && { echo; echo "    $MA_NOTE"; }
[[ $WITH_KIOSK -eq 1 ]] && echo "    Reboot to launch the kiosk: sudo reboot"
