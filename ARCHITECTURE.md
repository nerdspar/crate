# Architecture

Crate is an npm-workspaces monorepo. There is **one backend process** and **two browser
front-ends that it serves** — plus two shared libraries.

```
apps/
  server   @crate/server   Node (tsx) — Fastify + better-sqlite3 + Music Assistant WS.
                           The only long-running process. Owns the DB + the MA connection.
  shelf    @crate/shelf    Vite SPA — the wall/kiosk UI (ultrawide ~2608×720, touch/gesture).
  admin    @crate/admin    Vite SPA — the phone/desktop management UI.
packages/
  shared   @crate/shared   Types + the HTTP/WS API client. Consumed as source by everyone.
  providers @crate/providers  The Music Assistant provider (WS client + mapping).
```

## How the pieces relate

```
  ┌─────────┐   HTTP + /ws   ┌──────────────┐   WebSocket   ┌──────────────────┐   ┌───────┐
  │  shelf  │◄──────────────►│              │◄─────────────►│ Music Assistant  │──►│ Sonos │
  │ (wall)  │                │  server      │               │  (external)      │   └───────┘
  └─────────┘                │  @crate/     │               └──────────────────┘
  ┌─────────┐   HTTP + /ws   │  server      │
  │  admin  │◄──────────────►│              │
  └─────────┘                └──────────────┘
        ▲                          │  serves the built bundles as static files:
        └──────────────────────────┘   shelf → `/`,  admin → `/admin/`
```

- The **server** is the single process. It exposes the HTTP API + a `/ws` fan-out hub,
  holds the SQLite database, and keeps one persistent WebSocket to **Music Assistant**
  (which in turn drives Sonos).
- **shelf** and **admin** are **static bundles** (`vite build` → `dist/`). They have **no
  runtime of their own** — the server mounts each `dist/` at its route (`/` and `/admin/`)
  if present. They talk to the server over HTTP and subscribe to live updates over `/ws`.
- Both front-ends share types and the API client via **@crate/shared**, so there is no
  duplicated protocol code.

## Why are they separate?

- **server vs. front-ends** — different runtimes (Node vs. browser) and different build
  tooling (tsx, unbundled vs. Vite bundles). They can't live in one runtime; this is the
  normal backend/frontend split. Note the front-ends are *served by* the server, not
  separate services.
- **shelf vs. admin** — genuinely different UIs: the wall kiosk (always-on, gesture engine,
  wide-and-short) vs. a portrait management UI. Separate bundles keep the kiosk lean (it
  never ships admin-only code) and let each evolve independently, while `@crate/shared`
  keeps the API contract in one place. Merging them into one routed Vite app is possible
  but would couple the bundles for little gain.

## Running

```
npm run dev:server   # tsx watch — the backend on CRATE_PORT (default 8080)
npm run dev:shelf    # vite dev server for the wall UI
npm run dev:admin    # vite dev server for the admin UI
npm run build        # build every workspace (front-ends → dist/, served by the server)
npm run typecheck    # tsc across the repo
```

In production the server serves the built `shelf/dist` and `admin/dist`; the front-ends do
not run independently.

## Service status (System settings)

Both front-ends show a live health panel (`GET /api/system/services`) for the three apps +
Music Assistant. Because the front-ends have no process of their own, the meanings are:

| Service | "online" (dot) means | `connections` |
| --- | --- | --- |
| **Server** | this request was answered (the process is alive) | total `/ws` clients |
| **Shelf** | the server is serving `shelf/dist` at `/` | connected wall clients |
| **Admin** | the server is serving `admin/dist` at `/admin/` | connected admin clients |
| **Music Assistant** | the provider's websocket is connected | n/a |

So a green **Shelf**/​**Admin** dot means "built & being served," independent of whether a
browser is currently connected; the connection count is shown separately as context.
