# Deploying the Crate landing page (TrueNAS + Cloudflare Tunnel)

The site is a static page (`index.html` + `screenshots/`). It's served by nginx
and published through a **Cloudflare Tunnel** — an outbound-only connection, so
**no ports are forwarded on your router and nothing is exposed on TrueNAS**.

```
[ visitor ] --HTTPS--> [ Cloudflare edge ] ==encrypted tunnel==> [ cloudflared ] --HTTP--> [ nginx ]
                                                          (both containers on TrueNAS, private network)
```

Files in this folder:

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | The stack: `nginx` (the site) + `cloudflared` (the tunnel) |
| `nginx.conf` | Server block (caching, security headers) |
| `.env.example` | Copy to `.env`, fill in the tunnel token |
| `Dockerfile` | Optional — bake the site into a portable image (Option B) |

---

## 1. Prerequisites

- A domain managed by Cloudflare (its nameservers point at Cloudflare). The
  subdomain you'll use (e.g. `getcrate.example.com`) does **not** need a DNS
  record yet — the tunnel creates one for you.
- **TrueNAS SCALE 24.10 "Electric Eel" or newer** (these use Docker; the Apps
  screen can run a custom `docker compose` stack). Older Kubernetes-based
  releases work too but the UI differs — the CLI path in step 3B is identical.

---

## 2. Create the Cloudflare Tunnel

1. Go to the **Cloudflare Zero Trust** dashboard → **Networks → Tunnels →
   Create a tunnel**.
2. Choose **Cloudflared** as the connector type. Name it e.g. `crate-site`.
3. On the **Install connector** screen, ignore the install commands — you only
   need the **token**: the long `eyJ...` string right after `--token`. Copy it.
4. Click **Next** to the **Public Hostnames** step and add a route:
   - **Subdomain / Domain:** the hostname you want, e.g. `getcrate` +
     `example.com`.
   - **Service Type:** `HTTP`
   - **URL:** `site:80`  ← the compose service name and port, not localhost.
5. Save. Cloudflare auto-creates the DNS + TLS for that hostname.

> You can add more hostnames later (e.g. `www`) pointing at the same `site:80`.

---

## 3. Deploy on TrueNAS

### 3A. Get the files onto the NAS

Create a dataset/folder for the app and copy this `site/` directory into it —
e.g. `/mnt/tank/apps/crate-site` (swap `tank` for your pool). From your Mac:

```sh
# from the repo root
rsync -av --exclude '.DS_Store' site/ truenas.local:/mnt/tank/apps/crate-site/
```

Then create the `.env` next to the compose file, with your token and the
absolute path to that folder:

```sh
# /mnt/tank/apps/crate-site/.env
TUNNEL_TOKEN=eyJ...your-token...
SITE_DIR=/mnt/tank/apps/crate-site
```

### 3B. Launch it

**Option 1 — TrueNAS UI (Custom App):** Apps → **Discover Apps** → **Custom App**
→ **"Install via YAML"**. Paste the contents of `docker-compose.yml`. In the
same screen there's an environment section — add `TUNNEL_TOKEN` and `SITE_DIR`
there (the UI has no `.env` file). Save & deploy.

**Option 2 — Shell (simplest, and what I'd use):** SSH into TrueNAS and run:

```sh
cd /mnt/tank/apps/crate-site
docker compose up -d
```

Check it came up and connected:

```sh
docker compose ps
docker compose logs cloudflared   # look for "Registered tunnel connection"
```

Now visit `https://getcrate.example.com` — the site should load over HTTPS
(Cloudflare handles the certificate).

---

## 4. Test locally first (optional)

On any machine with Docker, from this folder:

```sh
# temporarily uncomment the `ports: - "8088:80"` block in docker-compose.yml,
# then run just the web service:
docker compose up site
# open http://localhost:8088
```

Re-comment the ports before deploying (production doesn't need a host port).

---

## 5. Updating the site

Edit `index.html` / `screenshots/`, then re-sync and reload:

```sh
rsync -av --exclude '.DS_Store' site/ truenas.local:/mnt/tank/apps/crate-site/
ssh truenas.local 'cd /mnt/tank/apps/crate-site && docker compose restart site'
```

Because the files are bind-mounted, a `restart` (or nothing, for edits nginx
re-reads on the fly) is all it takes — no rebuild.

---

## Option B — Bake a portable image instead of bind-mounting

If you'd rather ship a versioned image (e.g. to run the site somewhere without
the source files), build and push it, then point compose at it:

```sh
# from this folder
docker build -t ghcr.io/nerdspar/crate-site:latest .
docker push ghcr.io/nerdspar/crate-site:latest
```

In `docker-compose.yml`, comment out the `image: nginx...` + `volumes:` lines in
the `site` service and uncomment the `image: ghcr.io/...` line. Now `SITE_DIR`
is unused and the NAS only needs the compose file + `.env`.

---

## Troubleshooting

- **502 / "site can't be reached" from Cloudflare:** the tunnel is up but can't
  reach nginx. Confirm the public-hostname URL is exactly `site:80` and that
  `docker compose ps` shows both containers running.
- **cloudflared logs "Unauthorized" / token errors:** the `TUNNEL_TOKEN` is
  wrong or truncated — recopy the full `eyJ...` string.
- **Images 404:** make sure `screenshots/` came across in the rsync (the
  `.dockerignore` only affects image builds, not bind mounts).
