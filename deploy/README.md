# Deploy

Deployment tooling for the Raspberry Pi wall appliance. (Docker Compose deploys use
the root `docker-compose.yml`; see `INSTALL.md`.)

## `pi/install.sh`
First-run installer for a Pi that drives the touchscreen. Installs Node, builds Crate,
and runs the server natively under `crate.service` (systemd, `CRATE_APPLIANCE=1`) so it
can control the display and reboot. Asks whether to use an existing Music Assistant (else
it co-hosts one in Docker) and whether to set up the `cage` + Chromium kiosk.

```sh
sudo bash deploy/pi/install.sh            # interactive
sudo bash deploy/pi/install.sh --kiosk    # / --no-kiosk to preset the display question
```

## `pi/update.sh`
In-place updater. Safe to re-run; it's a no-op when nothing changed.

```sh
sudo bash deploy/pi/update.sh            # update Crate (+ co-hosted MA if a newer image exists)
sudo bash deploy/pi/update.sh --no-ma    # Crate only
sudo bash deploy/pi/update.sh --ma-only  # Music Assistant only
sudo bash deploy/pi/update.sh --force    # rebuild + restart even if already current
```

What it does:
- **Crate** — `git pull --ff-only` → `npm ci && npm run build` (as the repo owner) → `systemctl restart crate`. Only rebuilds/restarts when the checkout actually moved (or `--force`). A diverged/dirty tree aborts before any restart, so the running version keeps serving.
- **Music Assistant** (only when `CRATE_MANAGES_MA=1`) — `docker pull` the latest image; if it changed, recreate the container **onto its existing `/data` volume**. The library/config are preserved; an external MA (`CRATE_MANAGES_MA=0`) is left alone.

It's also wired into the admin UI: **Settings → System → Software update**. That button launches this script via `systemd-run` (a transient unit outside `crate.service`), so the updater survives the service restart it triggers. Follow along with `journalctl -u crate-update -f`.
