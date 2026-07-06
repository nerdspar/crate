# Crate

A wall-mounted touchscreen music shelf. Your streaming collection rendered as
physical album spines on a stretched bar display — tap a spine, the case flips
open, hit play, and it starts on your speakers. Open-source, commodity hardware.

See [`CRATE_BUILD_PLAN.md`](./CRATE_BUILD_PLAN.md) for the full design.

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
