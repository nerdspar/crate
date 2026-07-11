# Crate — Project Reference

A wall-mounted, ultrawide touchscreen that shows a music library as CD **spines on a shelf**;
tapping a spine flips the jewel case open and plays the album. Playback runs through **Music
Assistant** (which drives Sonos and other players).

This is the single up-to-date reference for the project — architecture, how playback works, the
spine-rendering spec, what's built, and what's deferred. It replaces the original planning trio
(the old build plan, architecture, and spine-rendering docs), which predated the Music Assistant
pivot. Install steps live in [`INSTALL.md`](./INSTALL.md); appliance/deploy tooling in
[`deploy/`](./deploy).

---

## Architecture

An npm-workspaces monorepo: **one backend process** and **two browser front-ends it serves**,
plus two shared libraries.

```
apps/
  server    @crate/server     Node (tsx) — Fastify + better-sqlite3 + Music Assistant WS.
                              The only long-running process. Owns the DB + the MA connection.
  shelf     @crate/shelf      Vite SPA — the wall/kiosk UI (ultrawide ~2608×720, touch/gesture).
  admin     @crate/admin      Vite SPA — the phone/desktop management UI.
packages/
  shared    @crate/shared     Types + the HTTP/WS API client. Consumed as source by everyone.
  providers @crate/providers  The Music Assistant provider (WS client + mapping).
```

```
  ┌─────────┐  HTTP + /ws  ┌──────────┐  WebSocket  ┌─────────────────┐   ┌───────┐
  │  shelf  │◄────────────►│          │◄───────────►│ Music Assistant │──►│ Sonos │
  │ (wall)  │              │  server  │             │                 │   └───────┘
  └─────────┘              │          │             └─────────────────┘   (+ Chromecast/AirPlay)
  ┌─────────┐  HTTP + /ws  │          │  serves the built bundles as static files:
  │  admin  │◄────────────►│          │   shelf → `/`,  admin → `/admin/`
  └─────────┘              └──────────┘
```

- The **server** is the single process: HTTP API + a `/ws` fan-out hub, the SQLite database, and
  one persistent WebSocket to Music Assistant.
- **shelf** and **admin** are static bundles (`vite build` → `dist/`) with **no runtime of their
  own** — the server mounts each `dist/` at its route (`/`, `/admin/`) if present. They share the
  protocol via **@crate/shared** (no duplicated API code).
- They're separate because the runtimes differ (Node vs. browser) and the two UIs are genuinely
  different (always-on wide kiosk with a gesture engine vs. a portrait management UI); separate
  bundles keep the kiosk lean.

**Service status** (`GET /api/system/services`, shown in both front-ends): the front-ends have no
process of their own, so "Server online" = the request was answered; "Shelf/Admin online" = the
server is serving that `dist/`; "Music Assistant online" = the provider websocket is up. Each row
has a restart control (server restarts its process on the appliance; a front-end tells its clients
to reload; MA reconnects).

**Running:**
```
npm run dev:server   # tsx watch — backend on CRATE_PORT (default 8080)
npm run dev:shelf    # vite dev server for the wall UI
npm run dev:admin    # vite dev server for the admin UI
npm run build        # build every workspace (front-ends → dist/, served by the server)
npm run typecheck    # tsc across the repo
```

---

## How it plays music

Crate does **not** talk to Sonos directly. It holds one WebSocket to a **Music Assistant (MA)**
server, which owns the **sources** (Apple Music, etc.) and the **players** (Sonos, Chromecast,
AirPlay). MA handles source auth, the library, search, and playback; Crate is the shelf UI + a
thin control/curation layer on top.

> Historical note: the original design used `node-sonos-http-api` with a direct Apple
> Music/iTunes integration (see git history). The project pivoted to Music
> Assistant, which is why the old build plan is obsolete.

- **Topology:** MA can be **external** (point Crate at an existing MA) or **co-hosted** (the Pi
  installer runs MA in Docker on the same host, `CRATE_MANAGES_MA=1`). Crate can create the MA
  account and mint its own long-lived token so the user never opens MA's UI — the one exception is
  **Apple Music**, whose interactive MusicKit sign-in Crate drives via a browser popup + a
  session-id correlated long-poll, then saves the source automatically.
- **Playback nuances:** Crate uses MA *flow mode* — it plays the track uri directly and appends
  the rest of the album in the background (no gap). The Apple/Sonos "not encoded correctly" error
  is an Apple/Sonos bug that flow mode works around (Sonos then shows "No Content", but Crate is fine).
- The provider recreates + rewires its MA connection at runtime, so onboarding/settings can swap
  the MA URL/token without a restart.

---

## Spine & case rendering

Spines must read as physical CD jewel cases, not colored UI bars. Three layers, implemented in
`apps/shelf` (the prototype `spine-shelf.html` was the canonical source; the code is now the
source of truth):

1. **Materials (always on).** A fixed-pixel plastic edge treatment independent of spine width —
   ~8px top/bottom edges (catch-line → seam → translucent plastic → shadow), a left-biased vertical
   gloss, and on the cover a **heavier left hinge** + thin frame elsewhere + a 112° diagonal gloss.
   Edges are **fixed px, never percentages**, so a 1–2mm lip looks the same on a thin single and a
   fat double. The cover overlay lives on the cover face so gloss **rotates with the 3D flip**.
2. **Color/texture from real artwork.** Per album the artwork pipeline produces: a `palette`
   (dominant + dark via node-vibrant → spine gradient + cover fallback), a blurred `spineStrip`
   (1px center slice of the cover stretched + gaussian-blurred), an `ink` color (light/dark via
   luminance — `pickInk`), and optionally a real `scan` (MusicBrainz Cover Art Archive "spine"
   image). Render mode is a setting: `palette` (default) | `art` | `scan`-preferred, with per-album
   override in admin. A scan suppresses generated label text but keeps the materials layer.
3. **Typography.** Six styles across Archivo Narrow / Oswald / Newsreader, assigned deterministically
   as `TYPE_STYLES[hash(artist) % 6]` so an artist's albums share a "label identity" and the shelf
   renders identically every load. Font size `min(baseWidth × mult, 19px)`; fonts bundled locally
   (no Google Fonts on the kiosk). Determinism is a feature — no randomness beyond the hash.

**Spine width** is derived from track count / total duration (a 78-min double is visibly fatter
than a 34-min record), clamped, and stored on the shelf item so layout math (`settledLeft`) is
deterministic.

---

## Design language

Warm gallery black (`#131114`), warm off-white ink (`#ece7dd`), brass accents (`#8a8578`).
Archivo Narrow for spine labels + UI chrome; Newsreader (incl. italic) for titles — liner-note
energy. The **3D hinge flip** is the signature motion (~0.55s, `cubic-bezier(0.32, 0.9, 0.3, 1)`).
Idle state is art: no clocks, no widgets, ever.

---

## What's built

Everything below is implemented and on `main`.

- **Wall UI** — spine shelf with real artwork, the 3D case flip, the load-bearing drag-through
  gesture (one drag sweeps the shelf, edge-hold for overflow), open-album swipe-up-to-expand /
  swipe-down-to-close, pinch-zoom + loupe, live playback state (EQ, seek, volume), and the
  swipe-down **control center** (transport, per-player volume/grouping, brightness, display sleep,
  restart/reboot).
- **Playback** — play an album or a track via MA (plays the track uri + appends the album in the
  background), speaker grouping, shuffle/repeat, after-album behavior, and playlists (all-playlists
  view + single-playlist song view + song→album).
- **Admin** — search + add albums/playlists (Apple Music + library), shelves / stacks / ordering /
  per-album spine overrides, player defaults + exposure subset, group presets, MA **sources**
  (incl. the Apple Music MusicKit auth), and all settings. iOS-style bottom tabs (Search / Shelves /
  Settings).
- **Onboarding wizard** — Welcome → Connect MA (creates the account + token when co-hosted) →
  **Add your music** (sources) → tidy playlists → speakers → security → done; lands on Search.
- **Appliance & deploy** — Raspberry Pi installer (`deploy/pi/install.sh`: native server under
  systemd + optional `cage`/Chromium kiosk, co-host-MA option, `MemoryMax=75%` that auto-scales to
  the host's RAM) and a Docker Compose path (`docker-compose.yml`, cohosted profile).
- **Updates** — in-place `deploy/pi/update.sh` (updates Crate, and the co-hosted MA image only if
  newer, always preserving MA's data volume) + an admin **Update** button with a **live progress
  log** and a version-vs-GitHub readout for both Crate and MA.
- **Backups** — file export/import + **GitHub backup** (token-first flow: apply the token, pick the
  repo, save; manual + scheduled/automated commits, with history).
- **Security** — admin passphrase gate (scrypt + signed cookie, wall endpoints stay open) + login
  rate-limiting.
- **Hardening / perf** — process crash handlers + graceful SIGTERM shutdown, timeouts + size caps
  on all outbound `fetch`, DB indexes + state/lookup caches, throttled progress broadcasts, the
  wall's idle rAF stopped + `shelf` rebuilds coalesced, artwork mtime cache, and a dead-code sweep
  with `noUnusedLocals` on.

---

## Deferred / next

None of this is required — it's the menu for later.

- **systemd watchdog** — deferred. Lower value now that all hang-prone fetches have timeouts, and
  it needs app-side `sd_notify` + live on-Pi testing (misconfig = restart loop).
- **Wall-render polish** — the drag-gesture full-card-rebuild-per-step optimization (held back as
  too feel-risky without a real touchscreen), plus minor items (`sizeFaces` NodeList cache,
  `handleState` early-out, `spineAtX` arithmetic).
- **Features (not started)** — Apple Music `Library.xml` import with match-review, stacks polish, an
  iOS Shortcut push endpoint, a night schedule / auto-brightness sensor daemon, Home Assistant
  webhooks.
- **Open-source polish** — README with photos, hardware guide (BOM / STLs / wiring — see
  `hardware/`), CONTRIBUTING, a provider-plugin authoring guide, GitHub Actions CI, and a demo GIF.

---

## Key operational notes

- **Config** lives in SQLite under `CRATE_DATA_DIR` (`/var/lib/crate` on the appliance). Env:
  `MA_URL`, `MA_TOKEN`, `CRATE_PORT`, `CRATE_MANAGES_MA`, `CRATE_APPLIANCE`, `CRATE_VERSION`.
- **Appliance mode** (`CRATE_APPLIANCE=1`, runs as root under systemd) enables real
  brightness/display control + restart/reboot; it's a no-op on a dev box.
- **Updating the appliance:** `sudo bash deploy/pi/update.sh` (or the admin Update button). A repo
  cloned via `sudo` is root-owned; the installer fixes ownership so `npm ci` can build as the login
  user.
