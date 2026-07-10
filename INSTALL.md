# Installing Crate

Crate is a wall-mounted music shelf that plays through [Music Assistant](https://music-assistant.io) (MA). It runs as a small web server that serves the wall UI (`/`) and the admin app (`/admin/`).

You can run it two ways:

- **Docker Compose** (below) — the portable path. Best for a NAS/mini-PC/server, or any host where Crate doesn't drive the display itself. Works with an MA you already run, or can bring MA up alongside it.
- **Raspberry Pi appliance** — a native install that also drives the touchscreen in kiosk mode and controls brightness/sleep/reboot. _(Coming next — see the roadmap.)_

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

## Configuration reference

| Variable            | Default                          | Purpose |
|---------------------|----------------------------------|---------|
| `MA_URL`            | `http://homeassistant.local:8095`| Music Assistant server URL. |
| `MA_TOKEN`          | _(empty)_                        | Long-lived MA token (admin user). |
| `CRATE_PORT`        | `8080`                           | Port for the wall + admin. |
| `CRATE_MANAGES_MA`  | `0`                              | `1` when Crate co-hosts MA (enables restart affordance). |
| `CRATE_DATA_DIR`    | `/data` (in container)           | Where Crate stores its DB + art cache. |
| `CRATE_VERSION`     | `0.1.0`                          | Shown in the admin System view. |
