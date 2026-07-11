# Crate

A wall-mounted touchscreen music shelf. Your streaming collection rendered as
physical album spines on a stretched bar display — tap a spine, the case flips
open, hit play, and it starts on your speakers. Open-source, commodity hardware.

See [`PROJECT.md`](./PROJECT.md) for the architecture, design, and current state.

> [!NOTE]
> **AI-assisted project.** Crate was built largely with the help of AI coding assistants
> (Anthropic's Claude), including much of its code, documentation, and this README. It is a
> personal hobby project, shared **as-is and without warranty** — review the code yourself
> before running it, and don't assume it has been security-audited or hardened for
> production. Contributions and scrutiny are welcome.

## Features

- **Spine shelf** — your library as CD-jewel-case spines on an ultrawide display; tap to
  flip a case open, hit play, and it streams to your Sonos. Real or generated spine art,
  duration-scaled widths, per-album typography.
- **Shelves** — curated, reorderable collections (albums and playlists), each with its own
  sort. Playlists render as song shelves you can view, reorder, and hide tracks in.
- **Search** — one box across your sources, tiered *On your shelf → In your library → From
  your sources*, plus artists (→ their albums + top songs) and songs (→ open the album cued).
  Explicit tags, recent searches.
- **Multi-room** — pick any speaker or group as the play target; form groups from the album
  picker (multi-select or long-press), save one-tap group presets, per-room + proportional
  group volume that tracks external (Sonos-app) changes live.
- **Playback feedback** — a "connecting" spinner and frozen seek until the room actually
  reports playing, so nothing animates before audio starts.
- **Pinch to zoom** the shelf (spine density or a magnifier loupe), idle/attract modes, a
  sleep schedule, and brightness/display control.
- **Admin app** — a phone/desktop companion (iOS-style) to import & curate the library,
  build shelves, edit spines, manage speakers/presets, and configure everything.

## Playback architecture (Phase 0 outcome)

Phase 0 proved that node-sonos-http-api **cannot** reliably start arbitrary Apple
Music albums on a real Sonos household (it hard-codes account metadata that S2
firmware won't let us reconstruct — see [`docs/playback.md`](./docs/playback.md)).
Crate therefore drives playback through **Music Assistant**, which streams Apple
Music to Sonos with the operator's real credentials and exposes search, metadata,
artwork, playback, and live state over one WebSocket.

## Monorepo (§2)

```
apps/
  shelf/     Kiosk frontend — the wall UI (Vite + vanilla TS), ported from spine-shelf.html
  admin/     Admin web app (Vite + vanilla TS) — search + add to shelf
  server/    Device service (Fastify) — REST + WS, SQLite, artwork pipeline, MA provider
packages/
  shared/    Domain types, REST/WS contract, typed client
  providers/ MusicSource/PlayerTarget interfaces + Music Assistant adapter
hardware/    STLs, wiring, BOM (Phase 5+)
deploy/      systemd units, kiosk setup, install.sh (Phase 5)
docs/        playback.md and friends
scripts/     phase0 risk-spike CLIs
```

## Prerequisites

- Node 20+.
- A running **Music Assistant** instance with the Apple Music provider and your
  Sonos players connected.
- A Music Assistant **long-lived token** (MA web UI → your profile → tokens).

## Develop

```bash
npm install

# 1. Device service (REST + WS + SQLite + artwork) on :8080
MA_URL=http://<ma-host>:8095 MA_TOKEN=<token> npm run dev:server

# 2. Shelf (kiosk UI) on :5173 — proxies /api, /art, /ws to the server
npm run dev:shelf

# 3. Admin (search + curate) on :5174
npm run dev:admin
```

Then open the **admin** (`http://localhost:5174`), search for an album, and Add
it. It appears on the **shelf** (`http://localhost:5173`); tap it and press Play.

### Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `MA_URL` | `http://homeassistant.local:8095` | Music Assistant base URL |
| `MA_TOKEN` | — | MA long-lived token (required) |
| `CRATE_DATA_DIR` | `./data` | SQLite + cached artwork |
| `CRATE_PORT` | `8080` | Device service port |
| `CRATE_COVER_HEIGHT` | `1440` | Cover rendition height (px) |

## Scripts

- `npm run typecheck` — typecheck all workspaces (TypeScript strict).
- `npm run build` — build the frontends.
- `npm run phase0:ma -- "<album>" "<player>" --ma-url <url>` — the Phase 0 MA spike.

## Acknowledgments

Crate is a **client of [Music Assistant](https://github.com/music-assistant/server)** — the
open-source media library manager that does the real work of streaming to your speakers.
Crate talks to a Music Assistant server over its WebSocket API for search, metadata, artwork,
playback, and live state; it does **not** bundle, fork, or modify Music Assistant, and it is
**not affiliated with or endorsed by** the Music Assistant project. Music Assistant is
licensed under Apache-2.0.

Crate is also built on open-source libraries, each under its own license — including
[Fastify](https://fastify.dev) (MIT), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (MIT),
[sharp](https://sharp.pixelplumbing.com) (Apache-2.0), [Vite](https://vitejs.dev) (MIT),
[node-vibrant](https://github.com/Vibrant-Colors/node-vibrant) (MIT), and
[ws](https://github.com/websockets/ws) (MIT) — plus fonts via [Fontsource](https://fontsource.org)
(Archivo Narrow, Oswald, Newsreader; SIL Open Font License / Apache-2.0).

## Trademarks & content

Apple Music, AirPlay, Sonos, and Music Assistant are trademarks of their respective owners.
Crate uses these names only to describe interoperability and is **not** affiliated with,
sponsored by, or endorsed by Apple, Sonos, or the Music Assistant project. Crate plays only
the content you are entitled to through your own Music Assistant / streaming-service accounts.

**Album artwork.** The album cover art displayed by the app and shown in this repo's
screenshots and demo site — e.g. Green Day's *American Idiot*, and the other albums on the
shelf (Taylor Swift, My Chemical Romance, Fall Out Boy, Paramore, Avicii, and others) — is
© the respective recording artists and record labels. It is reproduced here **solely to
identify the albums and demonstrate the interface**; Crate claims no rights to it and no
affiliation with or endorsement by the artists or labels.

## License

Crate is released under the [MIT License](./LICENSE) — use, copy, modify, and redistribute it
freely, just keep the copyright and license notice. It comes with no warranty. Third-party
dependencies and Music Assistant remain under their own licenses (see
[Acknowledgments](#acknowledgments) above).
