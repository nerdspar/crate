#!/usr/bin/env bash
#
# Crate — in-place updater for the Raspberry Pi appliance.
#
# Pulls the latest Crate, rebuilds, and restarts the service. Never touches
# Music Assistant's data. If you co-host Music Assistant (CRATE_MANAGES_MA=1),
# it also updates the MA container *when a newer image exists*, recreating it
# while reusing its existing data volume — so your library/config survive.
#
#   sudo bash deploy/pi/update.sh              # update Crate (+ co-hosted MA if newer)
#   sudo bash deploy/pi/update.sh --no-ma      # update Crate only
#   sudo bash deploy/pi/update.sh --ma-only    # update Music Assistant only
#   sudo bash deploy/pi/update.sh --force      # rebuild + restart even if already current
#
# Safe to re-run: if nothing changed it's a no-op. The running Crate keeps
# serving until the very end, so a failed build never leaves you half-updated.

set -euo pipefail

DO_CRATE=1
DO_MA=1
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --no-ma) DO_MA=0 ;;
    --ma-only) DO_CRATE=0 ;;
    --force) FORCE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash deploy/pi/update.sh ${*:-}" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_USER="$(stat -c '%U' "$REPO_DIR")"
ENV_FILE="$REPO_DIR/.env"
MA_IMAGE="ghcr.io/music-assistant/server:latest"
MA_CONTAINER="music-assistant"

MANAGES_MA=0
if [[ -f "$ENV_FILE" ]] && grep -q '^CRATE_MANAGES_MA=1' "$ENV_FILE"; then
  MANAGES_MA=1
fi

# ---- resilience helpers ---------------------------------------------------
# Retry a flaky command. On a 1GB Pi the native better-sqlite3 rebuild in `npm ci` and the Vite build
# can be OOM-killed transiently; a warm retry usually succeeds — this automates the manual "just run
# update again" recovery so one hiccup doesn't leave the wall down.
retry() {
  local tries="$1"; shift
  local n=1
  until "$@"; do
    [[ $n -ge $tries ]] && return 1
    echo "    ...attempt $n failed; retrying ($((n+1))/$tries) in a moment" >&2
    n=$((n+1)); sleep 3
  done
}

# Temporary swap for the build. `npm ci` deletes node_modules FIRST, so if a low-RAM Pi is OOM-killed
# mid-install the wall can't start at all — swap prevents the kill. Only when RAM is low and no swap
# already exists; torn down afterwards, including on any failure (trap).
TMP_SWAP=""
maybe_add_swap() {
  if [[ "$(grep -c '^/' /proc/swaps 2>/dev/null || echo 0)" -gt 0 ]]; then return 0; fi  # swap already present
  local kb; kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ "$kb" -eq 0 || "$kb" -gt 2000000 ]]; then return 0; fi                            # unknown or >~2GB → skip
  local sf=/var/tmp/crate-update-swap.img
  echo "    Low RAM + no swap — mounting a temporary 1G swapfile for the build"
  rm -f "$sf"
  if fallocate -l 1G "$sf" 2>/dev/null || dd if=/dev/zero of="$sf" bs=1M count=1024 status=none 2>/dev/null; then
    chmod 600 "$sf"
    mkswap "$sf" >/dev/null 2>&1 && swapon "$sf" 2>/dev/null && TMP_SWAP="$sf"
  fi
  [[ -n "$TMP_SWAP" ]] || { echo "    (couldn't add swap — continuing without it)" >&2; rm -f "$sf"; }
}
remove_swap() {
  [[ -n "$TMP_SWAP" ]] || return 0
  swapoff "$TMP_SWAP" 2>/dev/null || true
  rm -f "$TMP_SWAP" 2>/dev/null || true
  TMP_SWAP=""
}
trap remove_swap EXIT

# Poll the wall after a restart so a crash-loop (e.g. a bad native module) fails LOUD instead of this
# script reporting success. Same endpoint the kiosk waits on; honour a custom CRATE_PORT.
CRATE_PORT_VAL="$( { [[ -f "$ENV_FILE" ]] && grep -E '^CRATE_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2; } || true )"
CRATE_PORT_VAL="${CRATE_PORT_VAL:-80}"
wait_healthy() {
  local deadline=$(( SECONDS + 90 ))
  until curl -sf -o /dev/null "http://localhost:${CRATE_PORT_VAL}/wall/"; do
    [[ $SECONDS -ge $deadline ]] && return 1
    sleep 2
  done
}

echo "==> Crate update"
echo "    repo:  $REPO_DIR"
echo "    user:  $RUN_USER"

# ---- Crate: pull + rebuild + restart -------------------------------------
if [[ $DO_CRATE -eq 1 ]]; then
  echo "==> Updating Crate"
  as_user() { sudo -u "$RUN_USER" "$@"; }
  # Self-heal ownership before dropping to $RUN_USER for git/npm. A prior
  # root-run git or build can leave root-owned files inside this user-owned
  # checkout (e.g. .git/FETCH_HEAD), which then makes `git fetch`/`pull` or
  # `npm ci` fail with EACCES. Re-asserting ownership is idempotent — a no-op
  # when it's already correct.
  if [[ "$RUN_USER" != root ]]; then
    chown -R "$RUN_USER" "$REPO_DIR"
  fi
  BEFORE="$(as_user git -C "$REPO_DIR" rev-parse HEAD)"
  as_user git -C "$REPO_DIR" fetch --quiet
  # --ff-only: refuse to update if the checkout has diverged/uncommitted merges,
  # rather than creating a merge commit. Fix it by hand, then re-run.
  if ! as_user git -C "$REPO_DIR" pull --ff-only --quiet; then
    echo "    git pull failed (local changes or diverged branch). Resolve, then re-run." >&2
    exit 1
  fi
  AFTER="$(as_user git -C "$REPO_DIR" rev-parse HEAD)"

  if [[ "$BEFORE" != "$AFTER" || $FORCE -eq 1 ]]; then
    echo "    ${BEFORE:0:7} -> ${AFTER:0:7}; installing deps + building"
    maybe_add_swap
    # npm ci wipes node_modules first, so a failure here can leave the service unable to start until a
    # re-run — retry rather than bail on the first transient OOM.
    if ! retry 3 as_user bash -lc "cd '$REPO_DIR' && npm ci"; then
      echo "    npm ci failed after retries — node_modules may be incomplete." >&2
      echo "    Free some memory/disk (check 'free -h' / 'df -h'), then re-run this script." >&2
      exit 1
    fi
    if ! retry 3 as_user bash -lc "cd '$REPO_DIR' && npm run build"; then
      echo "    Build failed after retries — NOT restarting (the running Crate keeps serving)." >&2
      exit 1
    fi
    remove_swap  # free it before the restart so the wall boots with full RAM
    echo "    Restarting crate.service"
    systemctl restart crate.service
    # Confirm it actually came back — don't declare success on a silent crash-loop.
    if wait_healthy; then
      echo "    Crate updated and serving (${AFTER:0:7})."
    else
      echo "    ERROR: crate.service did not answer /wall/ within 90s after restart." >&2
      systemctl status crate.service --no-pager -l 2>/dev/null | head -20 >&2 || true
      journalctl -u crate.service -n 30 --no-pager 2>/dev/null >&2 || true
      exit 1
    fi
  else
    echo "    Already up to date (${AFTER:0:7})."
  fi
fi

# ---- Music Assistant: pull newer image, recreate preserving data ----------
if [[ $DO_MA -eq 1 ]]; then
  if [[ $MANAGES_MA -ne 1 ]]; then
    if [[ $DO_CRATE -eq 0 ]]; then
      echo "==> Music Assistant is external (CRATE_MANAGES_MA=0)."
      echo "    Update it where it's hosted — Crate doesn't manage that instance."
    fi
  elif ! command -v docker >/dev/null; then
    echo "==> Skipping Music Assistant: docker not found." >&2
  else
    echo "==> Checking Music Assistant image"
    BEFORE_IMG="$(docker inspect --format '{{.Image}}' "$MA_CONTAINER" 2>/dev/null || echo none)"
    docker pull "$MA_IMAGE"
    LATEST_IMG="$(docker inspect --format '{{.Id}}' "$MA_IMAGE")"

    if [[ "$BEFORE_IMG" != "$LATEST_IMG" ]]; then
      # Recreate onto the SAME data volume the running container uses, so the
      # library/config are preserved. Fall back to the installer's default name.
      VOL="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$MA_CONTAINER" 2>/dev/null || true)"
      VOL="${VOL:-music-assistant-data}"
      echo "    Newer image — recreating $MA_CONTAINER (data volume '$VOL' preserved)"
      docker rm -f "$MA_CONTAINER" >/dev/null 2>&1 || true
      docker run -d --name "$MA_CONTAINER" --restart unless-stopped --network host \
        -v "$VOL":/data "$MA_IMAGE"
      echo "    Music Assistant updated."
    else
      echo "    Music Assistant already up to date."
    fi
  fi
fi

echo
echo "==> Done."
