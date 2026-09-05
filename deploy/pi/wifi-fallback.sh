#!/usr/bin/env bash
# Crate WiFi fallback — when the wall can't reach any known network, raise a "Crate-Setup" hotspot so it
# can be reconfigured from a phone: join the hotspot, open http://10.42.0.1/admin and pick a network on
# the Network page. The hotspot is dropped the moment a real connection (WiFi or Ethernet) returns.
#
# Runs as root via crate-wifi-fallback.service (installed by deploy/pi/install.sh). NetworkManager only.
set -u

# Defaults — override in /etc/crate/wifi-fallback.conf (written by install.sh).
HOTSPOT_CON="crate-setup"   # NM connection name — MUST match HOTSPOT_CON in apps/server/src/system.ts
HOTSPOT_SSID="Crate-Setup"
HOTSPOT_PASS="cratewifi"    # WPA2, 8+ chars
WIFI_IFACE="wlan0"
GRACE=25                    # seconds to let NM auto-join on boot before the first check
CHECK=15                    # poll interval
NEED=3                      # consecutive offline checks before raising the hotspot (debounces blips)
[ -f /etc/crate/wifi-fallback.conf ] && . /etc/crate/wifi-fallback.conf

log() { echo "[wifi-fallback] $*"; }

# Online = a WiFi or Ethernet device is connected to something OTHER than our own setup hotspot.
# (Independent of NM's connectivity-check ping, which may be disabled.)
online() {
  nmcli -t -f TYPE,STATE,CONNECTION device status 2>/dev/null | awk -F: -v h="$HOTSPOT_CON" '
    ($1 == "wifi" || $1 == "ethernet") && $2 == "connected" && $3 != h { found = 1 }
    END { exit(found ? 0 : 1) }'
}

hotspot_active() {
  nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "$HOTSPOT_CON"
}

start_hotspot() {
  hotspot_active && return 0
  log "no known network reachable — raising setup hotspot '$HOTSPOT_SSID'"
  if nmcli -t -f NAME connection show 2>/dev/null | grep -qx "$HOTSPOT_CON"; then
    nmcli connection up "$HOTSPOT_CON" || true
  else
    nmcli device wifi hotspot ifname "$WIFI_IFACE" con-name "$HOTSPOT_CON" ssid "$HOTSPOT_SSID" password "$HOTSPOT_PASS" || true
    # Don't let the AP auto-grab the radio on boot — this watchdog decides when it's needed.
    nmcli connection modify "$HOTSPOT_CON" connection.autoconnect no 2>/dev/null || true
  fi
}

stop_hotspot() {
  hotspot_active || return 0
  log "network back — dropping setup hotspot"
  nmcli connection down "$HOTSPOT_CON" || true
}

sleep "$GRACE"
offline=0
while true; do
  if online; then
    offline=0
    stop_hotspot
  else
    offline=$((offline + 1))
    [ "$offline" -ge "$NEED" ] && start_hotspot
  fi
  sleep "$CHECK"
done
