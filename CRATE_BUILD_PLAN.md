# Crate — Build Plan

**Name:** Crate. Repo: `crate-shelf` (the bare word is unsearchable and collides with the Rust ecosystem; the binary/service can still be `crate`). The sub-shelf feature is called **stacks** to avoid app-named-Crate-contains-crates confusion.

A wall-mounted touchscreen music shelf. Your streaming collection rendered as physical album spines on a stretched bar display. Tap a spine, the case flips open, hit play, and it starts on your speakers. Inspired by Spine (spinemusic.com), built open-source on commodity hardware.

**License target:** MIT. **Distribution target:** self-hosters with a Raspberry Pi, a bar LCD, and Sonos speakers. No cloud dependency owned by us; users bring their own streaming accounts.

---

## 1. Hardware reference

The software must not hard-code this hardware, but this is the reference build:

| Component | Reference part | Notes |
|---|---|---|
| Display | Prechen 16.2" 2608×720 IPS touch bar, 800 nits, HDMI + USB-C | Touch is USB HID, works out of the box on Linux. Quirk: panel must have power before signal cable or touch fails — irrelevant once permanently wired, but document it. |
| Computer | Raspberry Pi 5 (4GB) | Pi 4 should also work; document both. |
| Sensor | APDS-9960 (I²C) | Ambient light (auto-brightness) + proximity (wave-to-wake). Config option, not required. |
| Power | Single 12V/5A brick → buck converter for Pi, or PoE++ | Goal: one cable to the wall. |
| Enclosure | 3D-printed frame + aluminum U-channel, French cleat mount | Out of scope for software; keep a `/hardware` folder in the repo for STLs and wiring diagrams. |

Any resolution must work. The UI is built with viewport-relative units; the reference aspect is ~3.6:1. Test at 2608×720, 1920×360, and 1920×540.

---

## 2. System architecture

Three deployable pieces, one repo (monorepo):

```
crate-shelf/
├── apps/
│   ├── shelf/          # Kiosk frontend (the wall UI)
│   ├── admin/          # Admin web app (served on port 80)
│   └── server/         # Device service (Node) — API, providers, system control
├── packages/
│   ├── providers/      # Music source + player target plugins
│   └── shared/         # Types, API client, shared utils
├── hardware/           # STLs, wiring, BOM
├── deploy/             # systemd units, kiosk setup scripts, install.sh
└── docs/
```

**Stack:** Node 20+, TypeScript throughout. Server: Fastify. Frontend: Vite + vanilla TS or Preact (keep the shelf app light — it runs on a Pi and must feel 60fps; no heavy framework). SQLite via better-sqlite3. WebSocket for live state push.

### Device service (`apps/server`)

The brain. Runs on the Pi as a systemd unit. Responsibilities:

- Serve the shelf app (port 8080, kiosk Chromium points here) and admin app (**port 80**, requires `CAP_NET_BIND_SERVICE` on the node binary or an authbind/systemd socket approach — handle in deploy scripts)
- Library sync from configured music sources on a schedule + on demand
- Artwork pipeline (download, cache, resize, color extraction)
- Playback orchestration: route play/transport/volume commands to player targets
- Live state: subscribe to player events, push now-playing/volume/progress to all clients over WebSocket
- System control: brightness, display sleep/wake, app restart, Pi reboot, OTA update
- Sensor daemon: read APDS-9960, drive auto-brightness and wake
- Config + persistence in SQLite

### Shelf app (`apps/shelf`)

The existing prototype (`spine-shelf.html`) evolved into the production frontend. **The prototype's gesture model and visual design are the spec** — port them faithfully (see §5). Talks to the server via REST + WebSocket. Zero external network access; everything through the device service.

### Admin app (`apps/admin`)

Browser app on the LAN, `http://<device>/`. Setup wizard on first boot, full configuration after. See §8.

---

## 3. Provider architecture

The core open-source design decision: sources and players are plugins behind stable interfaces. Users connect their own services.

### MusicSource interface

```ts
interface MusicSource {
  id: string;                      // "apple-music", "spotify"
  auth(): AuthFlow;                // OAuth/token flow surfaced in admin
  getLibraryAlbums(): Album[];     // paginated
  getPlaylists(): Playlist[];
  getTracks(albumId): Track[];
  getArtworkUrl(albumId, size): string;
  search(query): SearchResults;
  resolvePlayableRef(albumId): PlayableRef;  // what a PlayerTarget needs to start it
}
```

**Apple Music (launch) — no developer account required:** metadata via the public **iTunes Search API** (no auth): album search (`https://itunes.apple.com/search?entity=album`), track lists (`/lookup?id=<collectionId>&entity=song`), and artwork (`artworkUrl100` with dimensions rewritten up to 3000x3000). Playback goes through node-sonos-http-api's `applemusic` action using the same catalog `collectionId` (see PlayerTarget). Users must have Apple Music linked as a service in their Sonos system.

**Apple Music library seeding & sync (three paths, all free):**
1. **Library.xml import (seed):** admin app accepts the file exported from the Music app on macOS (File → Library → Export Library). Parse albums/playlists (plist XML), match each against iTunes Search (artist + album title, fuzzy fallback) to resolve `collectionId` + artwork, and queue unmatched items for manual review in admin. This is the "populate my shelf in one shot" path.
2. **iOS Shortcuts push (ongoing sync):** publish a shared Shortcut that reads the user's saved albums via Shortcuts' native Apple Music actions and POSTs them as JSON to `POST /api/import/shortcuts` (token-protected). Runs on demand or on a schedule via Shortcuts automations. Server diffs against existing shelf items and adds new albums (setting: auto-add to shelf vs. staging area in admin).
3. **Admin search (curation):** iTunes search in the admin app for one-off adds. Sonos Favorites import as a bonus path.

There is deliberately **no companion mobile app** (see §13 Future directions) — Spine's phone-centric architecture requires one; ours doesn't.

**Spotify (post-launch, design for now):** playback already works via node-sonos-http-api's `spotify` action; metadata/search requires a free Spotify app (client credentials) which the operator creates and pastes into admin — standard self-hosted pattern. Library sync (`/me/albums`) additionally needs a user OAuth (PKCE) flow. Ship Apple-first; Spotify metadata provider is the first community-sized contribution.

**Future sources (design for, don't build):** Jellyfin, Subsonic/Navidrome, local files, Tidal, Music Assistant bridge (for users who already run MA — it collapses the whole pairing matrix below).

### PlayerTarget interface

```ts
interface PlayerTarget {
  id: string;                      // "sonos"
  discover(): Player[];            // e.g. SSDP discovery of Sonos on LAN
  play(player, ref: PlayableRef): void;
  transport(player, cmd: "pause"|"resume"|"next"|"prev"|"seek"): void;
  setVolume(player, v): void;
  group(players[]): void; ungroup(player): void;
  onState(cb): void;               // events: track, position, volume, play state
}
```

**Sonos via node-sonos-http-api (launch):** target an existing or bundled instance of jishi's **node-sonos-http-api** (configurable base URL; the operator may already run one). The install script offers to deploy it as a sidecar (Docker or systemd) if not present. Everything is plain HTTP:
- Discovery/players: `GET /zones`
- Playback: `GET /{room}/applemusic/now/album:{collectionId}` (Apple Music), `/{room}/spotify/now/spotify:album:{id}` (Spotify), `/{room}/favorite/{name}` (fallback)
- Transport: `/{room}/play`, `/pause`, `/next`, `/previous`, `/trackseek/{s}`
- Volume: `/{room}/volume/{0-100}`; grouping: `/{room}/join/{other}`, `/{room}/leave`
- State: `GET /{room}/state` (track, position, volume, playback state). For live push, configure node-sonos-http-api's **webhook** setting to POST transport/volume events to the device service, which fans out over WebSocket; poll `/state` as fallback.

### The pairing matrix (be honest in docs)

| Source → Sonos | Mechanism | Risk |
|---|---|---|
| Apple Music | node-sonos-http-api `applemusic` action with the iTunes `collectionId`. Requires Apple Music linked in the user's Sonos system. | **Low-medium.** The action wraps the undocumented Sonos metadata trick, but it's mature, widely deployed, and maintained outside this project. Still the first thing Phase 0 tests. |
| Spotify | node-sonos-http-api `spotify` action with a Spotify album URI. | Low-medium, same caveat. |
| Fallback (any source) | Sonos Favorites via `/{room}/favorite/{name}`; also an import path for curation. | Low. Ship as safety net. |

**Phase 0 gate:** against the operator's existing node-sonos-http-api instance, one script that (a) searches iTunes for an album, (b) plays it in a chosen room via the `applemusic` action, (c) reads back `/state`, and (d) receives a webhook event. All four pass → proceed.

---

## 4. Data & artwork pipeline

**SQLite schema (core tables):** `sources`, `albums` (id, source, title, artist, year, artwork_path, palette JSON, sort keys, added_at, play_count), `tracks`, `playlists`, `shelf_items` (what's displayed, manual order, stack_id), `stacks`, `players` (discovered + display order + default flag), `settings` (key/value).

**Artwork pipeline** (runs during sync, results cached on disk under `/var/lib/crate/art`):

1. Download the largest artwork; store original + resized renditions (cover @ display height ×2, spine strip)
2. Extract palette with `node-vibrant`: dominant, muted, dark variants → stored as JSON
3. Pre-render the **spine strip**: a 1px-wide center slice of the artwork, stretched to spine height, heavily gaussian-blurred, exported as a small PNG. This gives spines the album's real color texture.
4. Compute label ink color (light/dark) from palette luminance — same logic as the prototype's `pickInk`

**Spine rendering modes (user setting):**
- `palette` — gradient from extracted colors (default; closest to real CD spines)
- `art` — the blurred art strip
- Per-album override in admin for when extraction picks an ugly color

---

## 5. Shelf app — feature spec

Port the prototype exactly. The gesture engine is settled UX:

- **Nothing open + drag** → scroll shelf with momentum
- **Quick tap** → flip album open (3D hinge flip, spine face → cover face). Tap open cover → flip closed.
- **Hold (420ms, configurable)** → flip open under the finger, then without lifting, drag to step
- **Anything open + drag** → step mode: every ~110px of drag flips the next/previous album open sequentially, shelf glides to keep the open album anchored ~12% from the left edge. Scroll targets computed from settled layout, not mid-animation DOM (this bug was found and fixed; keep the `settledLeft` approach).
- **Release during step** → stops open on current album, no momentum

**Open modes (setting):**
- `cover` (default): art only + circular Play button (bottom-right, plays album on default player) + ⋯ menu button (top-right) that expands to the full card
- `card`: expands straight to cover + details panel

**Details panel:** eyebrow, title, artist, Play button, player (room) picker, volume slider bound to the active player's real volume, scrollable track list with now-playing indicator (♪). Tracks are tappable → play album starting from that track.

**Spine labels (setting):** uniform / collected / eclectic — as prototyped.

**Now playing on the shelf:** playing album's spine shows the animated EQ bars (driven by real WebSocket state — including music started from phones). Idle behavior: after N minutes without touch while playing, auto-scroll to and open the playing album (setting, default on).

**Sorting (setting + control center):** artist, album title, recently added, most played, release year, **color** (hue-sorted rainbow shelf).

**Stacks:** swipe up on the shelf switches between curated sub-shelves (All, Favorites, user-defined). Stack name appears briefly as an overlay label, Newsreader italic. Configured in admin.

**Playlist spines:** playlists render visually distinct from albums — flat matte texture, no jewel-case inner shadow, small ♫ glyph at spine base.

**Search:** accessible from control center; on-screen keyboard, filters the shelf live (non-matching spines collapse to slivers).

---

## 6. Control center (swipe down from top edge)

A translucent sheet (same blur language as the settings sheet):

- **Now playing:** art thumbnail, title/artist, seek bar with position
- **Transport:** prev / play-pause / next
- **Volume:** one bar per Sonos player, live values; group toggle chips to join/unjoin players
- **Brightness:** slider + Auto toggle (sensor-driven)
- **Search** field
- **Sort** selector
- **Display:** sleep now; night schedule indicator
- **System row:** restart app · reboot · IP address · sync status · update available badge

Swipe up or tap outside dismisses. The bottom-corner gear from the prototype is replaced by this (keep gear as a dev-mode fallback).

---

## 7. System integration (the appliance layer)

- **Kiosk:** Raspberry Pi OS Lite + `cage` (Wayland kiosk compositor) running Chromium `--kiosk` pointed at `http://localhost:8080`. No desktop.
- **systemd units:** `crate-server.service`, `crate-kiosk.service`, with watchdog + `Restart=always`. Chromium crash = auto-relaunch within seconds.
- **Brightness:** driver-board dependent. Try in order: `ddcutil` (DDC/CI over HDMI), then sysfs backlight, then software dim (CSS overlay) as last resort. Abstract behind one server endpoint; expose which method is active in admin.
- **Sensor daemon:** APDS-9960 over I²C. Ambient light → brightness curve (configurable min/max/response). Proximity → wake display from sleep. Both optional; config flags `sensor.enabled`, `sensor.autoBrightness`, `sensor.wakeOnApproach`.
- **Night schedule:** dim/sleep between configured hours. Optional Home Assistant integration: a simple webhook/REST toggle so HA scenes or presence can sleep/wake the display (`display/sleep`, `display/wake` endpoints, token-protected).
- **Resilience:** read-only root with overlayfs (raspi-config option), all mutable state under `/var/lib/crate` on a separate writable mount. Survives power cuts indefinitely.
- **OTA:** admin-triggered `git pull` + `npm ci` + build + restart, with a rollback tag. Show current version/commit in admin.
- **install.sh:** one-command setup on a fresh Pi OS Lite image: deps, node, repo, systemd units, kiosk config, port-80 capability. This is the open-source front door — invest here.

---

## 8. Admin app (port 80)

First boot → setup wizard: connect a source → discover players → pick default player → choose what's on the shelf → done. After setup, tabs:

1. **Sources:** node-sonos-http-api base URL + connection status; Apple Music search (iTunes, zero-config); **Library.xml import** with match review for unresolved albums; **Shortcuts sync** setup (shows the import token + link to the shared Shortcut, log of pushes, auto-add vs. staging toggle); Sonos Favorites import; Spotify credentials (optional, post-launch); artwork refresh; sync log
2. **Library & shelf:** browse synced library; toggle albums/playlists/favorites onto the shelf; drag-to-reorder manual sort; per-album spine color/mode override; manage stacks (create, assign, order)
3. **Players:** discovered Sonos devices; display order; default player; rename display labels
4. **Appearance:** spine label style, spine render mode (palette/art), open mode (cover/card), sort default, idle behavior, theme accents
5. **Display & sensor:** brightness curve, auto-brightness on/off, night schedule, wake-on-approach, display sleep timeout
6. **System:** device status (CPU temp, uptime, IP), restart/reboot, OTA update, logs, backup/restore config (single JSON export), HA webhook tokens

No auth for v1 (LAN-only appliance), but structure routes so a simple password can be added — open-source users will ask.

---

## 9. API sketch

REST (server, consumed by shelf + admin):

```
GET  /api/shelf                 → ordered shelf items w/ palette, spine assets, stack
GET  /api/albums/:id            → album + tracks
POST /api/play                  → { albumId, trackIndex?, playerId? }
POST /api/transport             → { playerId, cmd, position? }
POST /api/volume                → { playerId, level }
POST /api/group                 → { playerIds[] }
GET  /api/players               → players + live state snapshot
GET  /api/search?q=
GET/PUT /api/settings
POST /api/system/:action        → brightness|sleep|wake|restart|reboot|update
POST /api/import/library-xml   → multipart upload; returns match report
POST /api/import/shortcuts     → token-protected JSON album list from iOS Shortcuts
Admin-only: /api/sources/*, /api/curation/*, /api/stacks/*
```

WebSocket `/ws`: server pushes `state` (now playing, position, volumes, groups), `sync` (library sync progress), `system` (brightness, update available). Clients send nothing critical over WS; commands stay REST.

---

## 10. Build phases

**Phase 0 — Risk spike (do first, small):**
Against the operator's existing node-sonos-http-api instance: iTunes search → `applemusic` playback → `/state` readback → webhook event, as one CLI script (see §3 gate). Exit criteria: a chosen album starts reliably in a chosen room, and state events arrive. Findings recorded in `docs/playback.md`.

**Phase 1 — Real shelf:**
Monorepo scaffold. Server: Apple Music source (iTunes search + lookup), Sonos player target (node-sonos-http-api client), SQLite, artwork pipeline with palette extraction + spine strips. Admin has just enough UI to search and add albums to the shelf. Shelf app ported from prototype, rendering real art. Play works end-to-end via default player. *Milestone: it's on the wall and plays music.*

**Phase 2 — Live state:**
Sonos event subscriptions → WebSocket push. Real EQ indicator, real volume sliders, track progress, external-playback reflection. Track-tap playback.

**Phase 3 — Control center:**
Swipe-down sheet: transport, per-player volume + grouping, search, sort, brightness (manual), display sleep, restart/reboot.

**Phase 4 — Admin app:**
Setup wizard + all tabs. Curation, stacks, ordering, per-album overrides, player defaults. Library.xml import with match-review UI, Shortcuts push endpoint + published shared Shortcut, Sonos Favorites import. Port 80 binding in deploy.

**Phase 5 — Appliance:**
Kiosk deploy scripts, systemd + watchdog, read-only FS, sensor daemon (auto-brightness, wake-on-approach), night schedule, HA webhooks, OTA, install.sh, docs.

**Phase 6 — Open-source polish:**
README with photos, hardware guide (BOM, STLs, wiring), CONTRIBUTING, provider-plugin authoring guide, GitHub Actions CI, issue templates, demo GIF (the flip deserves it).

---

## 11. Risks & open questions

1. **Apple Music → Sonos start via node-sonos-http-api** (§3). Phase 0 exists because of this. Mitigations: Sonos Favorites fallback, optional Music Assistant bridge provider.
2. **iTunes Search API is unauthenticated but rate-limited** (~20 req/min guidance) — cache aggressively, debounce admin search, and never call it from the shelf app directly.
3. **node-sonos-http-api dependency health** — it's mature but community-maintained; pin a known-good version in the sidecar install and document self-hosting it. The PlayerTarget abstraction keeps a direct-UPnP replacement possible.
4. **Touch + custom gesture engine on Pi Chromium/Wayland** — the prototype's pointer-event engine must be verified on the actual touchscreen early (Phase 1), especially `touch-action: none` behavior under cage.
5. **Brightness control method varies by driver board** — DDC support unknown on the Prechen until tested; software-dim fallback guarantees *something* works.
6. **2608×720 EDID on Pi** — confirm KMS picks up the native mode; keep a `docs/display.md` with tested `cmdline.txt`/KMS overrides.
7. **Sonos S1 vs S2 differences** — target S2; note S1 untested.

---

## 12. Design language (carry from prototype)

Warm gallery black (#131114), warm off-white ink (#ece7dd), brass accents (#8a8578). Archivo Narrow for spine labels and UI chrome; Newsreader (incl. italic) for titles — liner-note energy. Fonts must be bundled locally in production (kiosk shouldn't depend on Google Fonts). Motion: the 3D hinge flip is the signature — 0.55s, cubic-bezier(0.32, 0.9, 0.3, 1). Idle state is art: no clocks, no widgets, ever.

---

## 13. Future directions (explicitly out of scope for v1)

- **Companion mobile app:** would add on-device Apple Music library sync and phone-speaker playback, at the cost of a $99/yr developer account, App Store maintenance, and a second codebase. The Shortcuts push covers the sync value for free. Revisit only if the project attracts a Swift-fluent maintainer.
- **Additional sources:** Spotify metadata provider, Jellyfin/Navidrome, Tidal, local files, Music Assistant bridge.
- **Additional player targets:** AirPlay, Chromecast, Squeezebox.
- **Multi-display sync:** several bars on one library (e.g., kitchen + office).
- **Admin auth:** simple password protection once anyone requests it.
