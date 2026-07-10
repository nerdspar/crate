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

echo "==> Crate update"
echo "    repo:  $REPO_DIR"
echo "    user:  $RUN_USER"

# ---- Crate: pull + rebuild + restart -------------------------------------
if [[ $DO_CRATE -eq 1 ]]; then
  echo "==> Updating Crate"
  as_user() { sudo -u "$RUN_USER" "$@"; }
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
    as_user bash -lc "cd '$REPO_DIR' && npm ci && npm run build"
    echo "    Restarting crate.service"
    systemctl restart crate.service
    echo "    Crate updated."
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
