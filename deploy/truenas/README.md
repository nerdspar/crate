# Crate on TrueNAS SCALE (Custom App)

Run the Crate **app** on TrueNAS as a Custom App, so it shows up in the Apps
list. Crate is served LAN-only (`http://<truenas-ip>:8090/`) and points at an
existing Music Assistant. The public marketing site is a separate deployment —
see [`site/DEPLOY.md`](../../site/DEPLOY.md).

> **Why not on the Cloudflare tunnel?** Crate has no login yet, so anyone who
> could reach it could control your music. Keep it on the LAN until it has auth.

The Custom App UI can't build images, so the flow is: **CI builds the image →
GHCR hosts it → TrueNAS pulls it.**

---

## 1. Publish the image to GHCR (one-time + on every change)

`.github/workflows/docker-image.yml` builds `ghcr.io/nerdspar/crate:latest` and
pushes it. It runs automatically on pushes to `main`; to run it now, push this
commit (or Actions tab → **docker-image** → **Run workflow**).

Then make the package pullable without a login:

1. GitHub → your profile → **Packages** → **crate** → **Package settings**.
2. **Change visibility → Public.**

(Prefer to keep it private? Skip that and instead, in the TrueNAS Custom App
install screen, add an **image pull credential** for `ghcr.io` using a GitHub
PAT with `read:packages`.)

---

## 2. Create a dataset for Crate's data

Crate keeps its SQLite DB + cached artwork in `/data`. Create a dataset for it —
e.g. **`crate-data`** — so it lives at `/mnt/<pool>/crate-data`. This survives
app updates/recreates. (Crate also has its own **Settings → Backup**, incl.
GitHub auto-backup, for portable restores.)

---

## 3. Get a Music Assistant token

In the Music Assistant web UI: your profile → **long-lived tokens** → create one
with an **admin** user (so Crate can manage sources). Copy it.

You can skip this and leave `MA_TOKEN: ""` — then set it later in Crate's
**admin → Settings → Music Assistant** (the onboarding can sign in / mint one).

---

## 4. Install the Custom App

1. Open [`crate-custom-app.yaml`](crate-custom-app.yaml) and replace the
   placeholders: `MA_HOST`, `PASTE_MA_TOKEN`, and `POOL` (3 → your pool).
2. TrueNAS UI → **Apps → Discover Apps → Custom App → Install via YAML**.
3. **Application Name:** `crate`.
4. Paste the edited YAML → **Install**.

`crate` appears in the Apps list. When it's **Running**, open:

- Admin: `http://<truenas-ip>:8090/`
- Wall:  `http://<truenas-ip>:8090/wall/`

---

## 5. Updating

Push a change (CI rebuilds `:latest`), then in TrueNAS: **Apps → crate →**
pull the new image and recreate. Your `crate-data` dataset is untouched, so no
data is lost. (For a pinned, reproducible deploy, reference a specific tag like
`ghcr.io/nerdspar/crate:sha-abc1234` instead of `:latest`.)

---

## Troubleshooting

- **App won't pull the image:** the package is still private — make it Public
  (step 1) or add a `ghcr.io` pull credential in the install screen.
- **Crate loads but no music / "can't reach MA":** check `MA_URL` is reachable
  from the NAS (`curl http://MA_HOST:8095` over SSH) and the token is valid.
- **"port is already allocated"** on install: the host port is taken. The YAML
  already uses `8090`; if that's taken too, change the left number (e.g.
  `"8091:8080"`) and browse to that port. The right number stays 8080.
