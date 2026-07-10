# Installing Crate

Crate is a wall-mounted music shelf that plays through [Music Assistant](https://music-assistant.io) (MA). It runs as a small web server that serves the wall UI (`/`) and the admin app (`/admin/`).

You can run it two ways:

- **Docker Compose** (below) — the portable path. Best for a NAS/mini-PC/server, or any host where Crate doesn't drive the display itself. Works with an MA you already run, or can bring MA up alongside it.
- **Raspberry Pi appliance** — a native install (below) that also drives the touchscreen in kiosk mode and controls brightness/sleep/reboot.

---

## Docker Compose

### Prerequisites
- Docker + the Compose plugin (`docker compose version`).
- Either an existing Music Assistant server, or use the co-hosted profile below.

### 1. Configure
```sh
git clone https://github.com/<you>/crate.git
cd crate
cp .env.example .env
$EDITOR .env        # set MA_URL and MA_TOKEN
```
Create the MA token in the Music Assistant web UI (your profile → long-lived tokens); use an admin user so Crate can manage sources. Or leave it blank for now and paste it later in the admin.

### 2a. Use an existing Music Assistant (e.g. on a NAS)
Point `MA_URL` at it and leave `CRATE_MANAGES_MA=0`, then:
```sh
docker compose up -d --build
```

### 2b. Co-host Music Assistant alongside Crate
Start both (MA runs with host networking so it can discover speakers):
```sh
docker compose --profile cohosted up -d --build
```
Set in `.env`: `MA_URL=http://host.docker.internal:8095` and `CRATE_MANAGES_MA=1`. First-time MA setup is at `http://<host>:8095`.

### 3. Open it
- Wall: `http://<host>:8080`
- Admin: `http://<host>:8080/admin/`

In the admin, **Settings → Music Assistant** manages sources; **Settings → Backup** exports your config or syncs it to GitHub.

### Data & backups
All Crate state (shelves, settings, curation, cached art) lives in the `crate-data` volume. It is **not** in git — protect it with **Settings → Backup** (download a file and/or enable GitHub auto-backup). A restore rebuilds everything except the regenerable art cache.

### Updating
```sh
git pull
docker compose up -d --build     # add --profile cohosted if you use it
```

### Logs / stop
```sh
docker compose logs -f crate
docker compose down              # stop (keeps volumes/data)
```

---

## Raspberry Pi appliance

For a Pi that drives the wall touchscreen. Runs the server **natively** (not Docker) so it can control the display's brightness/sleep and reboot. Targets Raspberry Pi OS Bookworm.

```sh
git clone https://github.com/<you>/crate.git
cd crate
sudo bash deploy/pi/install.sh            # asks about Music Assistant + the kiosk display
```

The script installs Node, builds Crate, and installs a `crate.service` systemd unit with `CRATE_APPLIANCE=1`. Data lives in `/var/lib/crate`. It asks two questions up front:

- **"Will you be using an existing Music Assistant installation?"** — **No** (default) installs MA alongside Crate in Docker (`CRATE_MANAGES_MA=1`); **Yes** points at your existing MA (enter its URL, token optional). Either way the **token can be left blank** — open Crate's admin afterward and the **setup wizard** handles it: for a co-hosted MA it **creates your Music Assistant account and mints its own token** (you never open MA's UI); for an existing MA you can **sign in** (Crate mints the token) or paste a long-lived one. Also available later in **Settings → Music Assistant**.
- **"Set up the fullscreen kiosk display?"** — installs `cage` + Chromium and a `crate-kiosk.service` that opens `http://localhost:8080` fullscreen on boot. Preset non-interactively with `--kiosk` / `--no-kiosk`. It's **best-effort** — the display stack varies (Pi OS Bookworm uses Wayland/labwc; older setups use X11); if the screen stays blank, the server still runs and you can point any fullscreen browser at `http://localhost:8080`.

Manage it:
```sh
systemctl status crate            # server
journalctl -u crate -f            # server logs
systemctl restart crate           # after a `git pull` + `npm run build`
```

Updating:
```sh
cd crate && git pull && npm ci && npm run build && sudo systemctl restart crate
```

---

## Configuration reference

| Variable            | Default                          | Purpose |
|---------------------|----------------------------------|---------|
| `MA_URL`            | `http://homeassistant.local:8095`| Music Assistant server URL. |
| `MA_TOKEN`          | _(empty)_                        | Long-lived MA token (admin user). |
| `CRATE_PORT`        | `8080`                           | Port for the wall + admin. |
| `CRATE_MANAGES_MA`  | `0`                              | `1` when Crate co-hosts MA (enables restart affordance). |
| `CRATE_DATA_DIR`    | `/data` (in container)           | Where Crate stores its DB + art cache. |
| `CRATE_VERSION`     | `0.1.0`                          | Shown in the admin System view. |
