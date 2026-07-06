# Playback — Phase 0 findings

Phase 0 is the risk spike from CRATE_BUILD_PLAN.md §3 / §10 / §11.1: prove that an
Apple Music album can be started on a Sonos room from Crate, and that live state
events flow back. **Outcome: proven — via Music Assistant, not node-sonos-http-api.**

Two CLIs came out of this spike:

- [`scripts/phase0.ts`](../scripts/phase0.ts) — the original node-sonos-http-api probe (kept as the record of why we pivoted).
- [`scripts/phase0-ma.ts`](../scripts/phase0-ma.ts) — the Music Assistant probe. **This is the path that works.**

---

## TL;DR

- iTunes Search API → `collectionId` works perfectly (zero-config, no auth).
- **node-sonos-http-api's `applemusic` action cannot start arbitrary albums on this
  household.** It hard-codes Apple Music account metadata (`sn=4`, service-account
  token `SA_RINCON52231…-0-Token`) that doesn't match this system (`sn=21`, and two
  Apple Music accounts linked). Every album/transport control call returns
  `500 "Got status 500 when invoking /MediaRenderer/AVTransport/Control"`.
- **Music Assistant plays it correctly.** MA streams Apple Music to Sonos using the
  operator's real credentials, so it plays any album, and it exposes search,
  playback, state, and live events over one authenticated WebSocket.

---

## The node-sonos-http-api dead-end (why we pivoted)

Investigated step by step against the operator's instance at `sonos.nerdspar.com:5005`:

1. **iTunes search (step 1): passes.** `Rumours Fleetwood Mac` → `collectionId=594061854`,
   artwork upscaled to `3000x3000bb`.
2. **applemusic playback (step 2): 500.** Reproduced on multiple rooms (Living Room *and*
   Kitchen — so it is **not** an HT-device or room-specific issue) and multiple albums.
3. **Root cause: hard-coded account metadata.** `lib/actions/appleMusic.js` builds album
   playback from a fixed browse-container + a fixed `<desc>` service-account token
   (`SA_RINCON52231_X_#Svc52231-0-Token`) and, for songs, `sid=204&flags=8224&sn=4`.
   The `-0-` account slot and `sn=4` are static. This household's Apple Music account is
   serial **21** (visible in the track already playing: `…mp4?sid=204&flags=8232&sn=21`),
   and it has **two** Apple Music accounts linked, so the fixed slot-0/serial-4 guess
   points at the wrong/nonexistent account → Sonos rejects the container with the 500.
   This also matches the operator's "it used to work" recollection: it worked when the
   account was at a low slot/serial matching the hard-code, and broke after re-linking.
4. **Can't fix it cleanly.** S2 firmware locks down account introspection
   (`/status/accounts` returns empty), and `GetPositionInfo` / queue browse both strip
   the `<desc>` service-account token, so the correct token can't be cheaply extracted.
   Making native playback work would mean reconstructing Sonos's Apple Music
   authorization per-household — unshippable for an open-source release. The duplicate
   account could not be removed via the Sonos app either.

**Verdict:** node-sonos-http-api's Apple Music album-start is too account-entangled to be
Crate's playback engine. It remains fine for what it does robustly (discovery, transport,
volume, grouping, `/state`) but not for *originating* Apple Music albums.

## The Music Assistant path (what works)

MA 2.9.5 (schema 31), reached directly on its own port (**not** through the HA reverse
proxy): `http://<ha-host>:8095`. For this system: `http://10.0.1.96:8095`.

WebSocket API at `ws://<host>:8095/ws`. Protocol:

- **Connect** → server sends a `ServerInfoMessage` (`server_version`, `schema_version`, …).
- **Auth (required, schema ≥ 28):** first command must be
  `{ "command": "auth", "message_id": "…", "args": { "token": "<long-lived token>" } }`.
  The token is created in the **Music Assistant** web UI → profile → long-lived tokens
  (an MA-native token; a Home Assistant long-lived token does **not** work here).
- **Commands:** `{ message_id, command, args }` → reply `{ message_id, result }` or
  `{ message_id, error_code, details }`.
- **Events:** pushed on the same socket as `{ event, object_id, data }` — no registration,
  no webhook, no firewall/NAT concerns. This replaces the entire node-sonos-http-api
  webhook mechanism.

The four Phase 0 steps map to:

| Step | MA command |
|------|-----------|
| 1. Search | `music/search` `{search_query, media_types:["album"], limit, library_only:false}` |
| 2. Play | `player_queues/play_media` `{queue_id, media:<album uri>, option:"replace"}` |
| 3. State | `player_queues/get` / `player_queues/get_active_queue` (`state`, `current_item`) |
| 4. Live event | listen for `queue_updated` / `queue_time_updated` / `player_updated` |

`queue_id == player_id` unless the player is grouped. Player list via `player_queues/all`
(each has `queue_id` + `display_name` = the Sonos room name).

Run:
```bash
export MA_TOKEN='<ma long-lived token>'
npm run phase0:ma -- "Rumours Fleetwood Mac" --ma-url http://10.0.1.96:8095        # discovery
npm run phase0:ma -- "Rumours Fleetwood Mac" "Kitchen" --ma-url http://10.0.1.96:8095  # play
```

## Implications for Phase 1 (architecture change from the plan)

The plan (§3) had **node-sonos-http-api** as the launch Sonos target and the **iTunes
Search API** as the Apple Music metadata source. Phase 0 changes this:

- **Music Assistant becomes the playback engine** (the `PlayerTarget` for Sonos). It is a
  first-class option the plan already anticipated ("Music Assistant bridge … collapses the
  whole pairing matrix").
- MA also provides Apple Music **search, metadata, and artwork**, so it can serve much of
  the `MusicSource` role too. The iTunes Search API may still be useful for high-res
  artwork / library.xml matching, but is no longer required for the playback path.
- **Auth + config the device service must own:** MA base URL (`:8095`) and an MA
  long-lived token, stored in settings.
- **Live state:** subscribe to MA's WS events and fan out over Crate's own WebSocket —
  simpler and more reliable than the polling+webhook design in the plan.

## Results

All four steps pass against the operator's hardware (MA 2.9.5, schema 31,
Kitchen / `RINCON_542A1B71A6B801400`):

| Step | Result | Notes |
|------|--------|-------|
| 1. Search (Apple Music via MA) | ✅ pass | `Rumours` → `apple_music://album/594061854`. |
| 2. Play via `play_media` | ✅ pass | Started Rumours on Kitchen. |
| 3. State readback | ✅ pass | `state=playing`, "Second Hand News", elapsed/duration reported. |
| 4. Live event | ✅ pass | `queue_updated` on the same socket, `object_id` = the Sonos RINCON id. |

Notes:
- MA uses the Sonos **RINCON UUID** as the player_id (matches node-sonos-http-api's
  `/zones`), so player identity is consistent across both.
- MA exposes **all** player types (Sonos, HomePod, AirPlay, Apple TV, Cast, web, and
  the Macs). Crate's room picker will need to filter/curate these — likely default to
  the Sonos rooms, with others opt-in. Tracked for Phase 1 (players model).

_node-sonos-http-api equivalents (steps 2–4) fail by design; see the dead-end section._
