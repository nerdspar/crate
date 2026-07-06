/**
 * Crate — Phase 0 risk spike (Music Assistant path).
 *
 * After discovering that node-sonos-http-api's `applemusic` action cannot start
 * arbitrary albums on this household (it hard-codes an Apple Music account
 * slot/serial that doesn't match; see scripts/phase0.ts and docs/playback.md),
 * we pivoted the playback engine to Music Assistant. MA streams Apple Music to
 * Sonos using the operator's real credentials, so it plays any album — and it
 * exposes search, playback, state, and live events over a single WebSocket.
 *
 * Four gated steps, all over MA's WS API (ws://<host>:8095/ws):
 *   1. Search MA for an album (positional arg) — Apple Music via MA's provider.
 *   2. Play it on a player (positional arg) via player_queues/play_media.
 *   3. Read back the queue state and print now-playing info.
 *   4. Confirm a live state event arrives on the same socket (replaces the
 *      node-sonos-http-api webhook entirely — no registration, no firewall).
 *
 *   npm run phase0:ma -- "<album query>" "<player>" [--ma-url http://host:8095]
 *
 * If <player> is omitted, the script runs in discovery mode: it searches and
 * lists available MA players, then exits without playing.
 */

import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Settings & CLI
// ---------------------------------------------------------------------------

const DEFAULT_MA_URL = 'http://homeassistant.local:8095';

interface Options {
  album: string;
  player: string | undefined;
  maUrl: string;
  maToken: string | undefined;
  limit: number;
  eventTimeoutMs: number;
}

function printUsage(): void {
  process.stdout.write(
    `\nCrate — Phase 0 risk spike (Music Assistant)\n\n` +
      `Usage:\n` +
      `  npm run phase0:ma -- "<album query>" "<player>" [options]\n\n` +
      `Positional:\n` +
      `  <album query>   Album to search for via Music Assistant, e.g. "Rumours Fleetwood Mac"\n` +
      `  <player>        MA player (Sonos room) to play in, e.g. "Living Room".\n` +
      `                  Omit to run discovery mode (search + list players, no playback).\n\n` +
      `Options:\n` +
      `  --ma-url <url>          Music Assistant base URL (default ${DEFAULT_MA_URL}, env MA_URL)\n` +
      `  --ma-token <token>      MA long-lived API token (env MA_TOKEN). Required on MA schema >= 28.\n` +
      `                          Create one in the MA web UI → your profile → long-lived tokens.\n` +
      `  --limit <n>             Search result count to show (default 5)\n` +
      `  --event-timeout <ms>    How long to wait for a live event (default 15000)\n` +
      `  -h, --help              Show this help\n\n`,
  );
}

function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'ma-url': { type: 'string' },
      'ma-token': { type: 'string' },
      limit: { type: 'string' },
      'event-timeout': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const album = positionals[0];
  if (album === undefined) {
    printUsage();
    fail('<album query> is required.');
  }

  const maUrl = (values['ma-url'] ?? process.env.MA_URL ?? DEFAULT_MA_URL).replace(/\/+$/, '');

  return {
    album,
    player: positionals[1],
    maUrl,
    maToken: values['ma-token'] ?? process.env.MA_TOKEN,
    limit: toInt(values.limit, 5, 'limit'),
    eventTimeoutMs: toInt(values['event-timeout'], 15_000, 'event-timeout'),
  };
}

function toInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive integer (got "${raw}").`);
  return n;
}

// ---------------------------------------------------------------------------
// Music Assistant WebSocket client
// ---------------------------------------------------------------------------

interface ServerInfo {
  server_id?: string;
  server_version?: string;
  schema_version?: number;
  base_url?: string;
}

interface MaEvent {
  event: string;
  object_id?: string | undefined;
  data?: unknown;
}

/** A tiny JSON-RPC-over-WebSocket client for the MA API. */
class MaClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly eventWaiters: Array<(e: MaEvent) => void> = [];
  readonly events: MaEvent[] = [];

  constructor(private readonly httpBaseUrl: string) {}

  connect(): Promise<ServerInfo> {
    const wsUrl = `${this.httpBaseUrl.replace(/^http/, 'ws')}/ws`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    return new Promise<ServerInfo>((resolve, reject) => {
      const onError = (err: Error): void => reject(new Error(`WebSocket error connecting to ${wsUrl}: ${err.message}`));
      ws.once('error', onError);
      ws.on('open', () => {
        /* MA sends a ServerInfoMessage immediately on connect. */
      });
      ws.on('message', (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          return;
        }
        // 1) Event message (no message_id).
        if (typeof msg['event'] === 'string') {
          const event: MaEvent = {
            event: msg['event'],
            object_id: typeof msg['object_id'] === 'string' ? msg['object_id'] : undefined,
            data: msg['data'],
          };
          this.events.push(event);
          for (const w of this.eventWaiters.splice(0)) w(event);
          return;
        }
        // 2) Command result / error.
        if (typeof msg['message_id'] === 'string') {
          const entry = this.pending.get(msg['message_id']);
          if (!entry) return;
          this.pending.delete(msg['message_id']);
          if ('error_code' in msg) {
            entry.reject(new Error(`${String(msg['error_code'])}: ${String(msg['details'] ?? '')}`));
          } else {
            entry.resolve(msg['result']);
          }
          return;
        }
        // 3) ServerInfoMessage (sent once on connect) — resolves connect().
        if (typeof msg['server_version'] === 'string') {
          ws.off('error', onError);
          resolve(msg as ServerInfo);
        }
      });
    });
  }

  command<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws) throw new Error('not connected');
    const message_id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message_id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ message_id, command, args }));
      setTimeout(() => {
        if (this.pending.delete(message_id)) reject(new Error(`command ${command} timed out`));
      }, 20_000);
    });
  }

  waitForEvent(predicate: (e: MaEvent) => boolean, timeoutMs: number): Promise<MaEvent | undefined> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.eventWaiters.indexOf(onEvent);
        if (idx >= 0) this.eventWaiters.splice(idx, 1);
        resolve(undefined);
      }, timeoutMs);
      const onEvent = (e: MaEvent): void => {
        if (!predicate(e)) {
          this.eventWaiters.push(onEvent); // not ours — keep waiting
          return;
        }
        clearTimeout(timer);
        resolve(e);
      };
      this.eventWaiters.push(onEvent);
    });
  }

  close(): void {
    this.ws?.close();
  }
}

// ---------------------------------------------------------------------------
// Shapes we read out of MA responses (defensive — treat JSON as unknown).
// ---------------------------------------------------------------------------

interface MaAlbum {
  uri: string;
  name: string;
  version?: string | undefined;
  year?: number | undefined;
  artists?: Array<{ name?: string }> | undefined;
  provider?: string | undefined;
}

interface MaQueue {
  queue_id: string;
  display_name?: string;
  state?: string;
  elapsed_time?: number;
  current_item?: {
    name?: string;
    duration?: number;
    media_item?: { name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } };
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function albumFrom(v: unknown): MaAlbum | undefined {
  const r = asRecord(v);
  if (typeof r['uri'] !== 'string' || typeof r['name'] !== 'string') return undefined;
  return {
    uri: r['uri'],
    name: r['name'],
    version: typeof r['version'] === 'string' ? r['version'] : undefined,
    year: typeof r['year'] === 'number' ? r['year'] : undefined,
    artists: Array.isArray(r['artists']) ? (r['artists'] as Array<{ name?: string }>) : undefined,
    provider: typeof r['provider'] === 'string' ? r['provider'] : undefined,
  };
}

function artistNames(artists: Array<{ name?: string }> | undefined): string {
  return (artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || '(unknown artist)';
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const results: Array<{ step: string; ok: boolean; note: string }> = [];
function record(step: string, ok: boolean, note: string): void {
  results.push({ step, ok, note });
}
function heading(text: string): void {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`);
}
function fail(message: string): never {
  process.stderr.write(`\n\x1b[31mError:\x1b[0m ${message}\n`);
  process.exit(1);
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  process.stdout.write(`\n\x1b[1mCrate — Phase 0 risk spike (Music Assistant)\x1b[0m\n`);
  process.stdout.write(`  MA URL   : ${opts.maUrl}\n`);
  process.stdout.write(`  Album    : "${opts.album}"\n`);
  process.stdout.write(`  Player   : ${opts.player ? `"${opts.player}"` : '(discovery mode — will not play)'}\n`);

  const ma = new MaClient(opts.maUrl);
  const info = await ma.connect();
  process.stdout.write(`  Connected: MA ${info.server_version ?? '?'} (schema ${info.schema_version ?? '?'})\n`);

  // MA schema >= 28 requires an auth command with a long-lived token before anything else.
  const schema = info.schema_version ?? 0;
  if (opts.maToken) {
    try {
      await ma.command('auth', { token: opts.maToken });
      process.stdout.write(`  Authenticated.\n`);
    } catch (err) {
      ma.close();
      fail(
        `Music Assistant rejected the token (${errMsg(err)}).\n` +
          `Create a fresh long-lived token in the MA web UI (${opts.maUrl}) → your profile → long-lived tokens,\n` +
          `then pass it via --ma-token or set MA_TOKEN.`,
      );
    }
  } else if (schema >= 28) {
    ma.close();
    fail(
      `Music Assistant ${info.server_version ?? ''} (schema ${schema}) requires authentication.\n` +
        `Open the MA web UI (${opts.maUrl}) → your profile → create a long-lived token, then re-run with\n` +
        `  --ma-token <token>   (or: export MA_TOKEN=<token>)`,
    );
  }

  try {
    // --- Step 1: search ------------------------------------------------------
    heading('Step 1 — Search Music Assistant');
    const search = asRecord(
      await ma.command('music/search', {
        search_query: opts.album,
        media_types: ['album'],
        limit: opts.limit,
        library_only: false,
      }),
    );
    const albums = (Array.isArray(search['albums']) ? search['albums'] : [])
      .map(albumFrom)
      .filter((a): a is MaAlbum => a !== undefined);
    if (albums.length === 0) fail(`No albums found in Music Assistant for "${opts.album}".`);

    albums.forEach((a, i) => {
      const marker = i === 0 ? '▶' : ' ';
      const ver = a.version ? ` (${a.version})` : '';
      process.stdout.write(
        `  ${marker} [${i}] ${artistNames(a.artists)} — ${a.name}${ver} ` +
          `${a.year ?? ''} [${a.provider ?? a.uri.split('://')[0]}]\n`,
      );
    });
    const chosen = albums[0]!;
    process.stdout.write(`\n  Selected: ${artistNames(chosen.artists)} — ${chosen.name}\n`);
    process.stdout.write(`  URI     : ${chosen.uri}\n`);
    record('1. MA search', true, `${artistNames(chosen.artists)} — ${chosen.name} (${chosen.uri})`);

    // --- Player discovery ----------------------------------------------------
    heading('Players');
    const allQueues = await ma.command('player_queues/all');
    const queues = (Array.isArray(allQueues) ? allQueues : [])
      .map(asRecord)
      .filter((q) => typeof q['queue_id'] === 'string');
    for (const q of queues) {
      process.stdout.write(`  • ${String(q['display_name'] ?? q['queue_id'])}  (state: ${String(q['state'] ?? '—')})\n`);
    }

    if (opts.player === undefined) {
      process.stdout.write(`\n(Discovery mode — pass a player name as the 2nd argument to actually play.)\n`);
      finishAndExit();
      return;
    }

    const wanted = opts.player.toLowerCase();
    const match = queues.find((q) => String(q['display_name'] ?? '').toLowerCase() === wanted);
    if (!match) fail(`No MA player named "${opts.player}". See the list above.`);
    const playerId = String(match['queue_id']);

    // --- Step 2: play --------------------------------------------------------
    heading('Step 2 — Play via player_queues/play_media');
    process.stdout.write(`  Playing ${chosen.uri} on "${opts.player}" (${playerId})\n`);
    // Arm the event listener BEFORE issuing play, so we can't miss the update.
    const eventPromise = ma.waitForEvent(
      (e) => e.object_id === playerId && (e.event === 'queue_updated' || e.event === 'player_updated' || e.event === 'queue_time_updated'),
      opts.eventTimeoutMs,
    );
    try {
      await ma.command('player_queues/play_media', { queue_id: playerId, media: chosen.uri, option: 'replace' });
      process.stdout.write(`  play_media accepted.\n`);
      record('2. play_media', true, `${chosen.name} → ${opts.player}`);
    } catch (err) {
      record('2. play_media', false, errMsg(err));
      process.stderr.write(`  \x1b[31mFailed:\x1b[0m ${errMsg(err)}\n`);
    }

    // --- Step 3: state readback ---------------------------------------------
    heading('Step 3 — Read back queue state');
    let queue: MaQueue | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(attempt === 0 ? 1500 : 1500);
      const q = asRecord(await ma.command('player_queues/get', { queue_id: playerId }));
      queue = q as unknown as MaQueue;
      if (queue.state === 'playing' && queue.current_item) break;
    }
    if (queue) {
      const item = queue.current_item;
      const mi = item?.media_item;
      process.stdout.write(`  State       : ${queue.state ?? '—'}\n`);
      process.stdout.write(`  Now playing : ${artistNames(mi?.artists)} — ${mi?.name ?? item?.name ?? '—'}\n`);
      process.stdout.write(`  Album       : ${mi?.album?.name ?? '—'}\n`);
      process.stdout.write(`  Elapsed     : ${Math.floor(queue.elapsed_time ?? 0)}s / ${item?.duration ?? '—'}s\n`);
      const playing = queue.state === 'playing';
      record('3. state readback', playing, playing ? `${mi?.name ?? item?.name ?? '?'} [playing]` : `state=${queue.state ?? '?'}`);
      if (!playing) process.stdout.write(`  \x1b[33mNote:\x1b[0m state is not "playing" — verify audio is audible.\n`);
    } else {
      record('3. state readback', false, 'no queue state');
    }

    // --- Step 4: live event --------------------------------------------------
    heading('Step 4 — Live event on the same socket');
    process.stdout.write(`  Waiting up to ${opts.eventTimeoutMs}ms for a queue/player event...\n`);
    const event = await eventPromise;
    if (event) {
      process.stdout.write(`  \x1b[32mReceived event:\x1b[0m ${event.event} (object_id=${event.object_id})\n`);
      record('4. live event', true, event.event);
    } else {
      process.stdout.write(`  \x1b[31mNo event received within the timeout.\x1b[0m\n`);
      record('4. live event', false, 'no event received');
    }

    finishAndExit();
  } finally {
    ma.close();
  }
}

function finishAndExit(): never {
  heading('Phase 0 (MA) summary');
  for (const r of results) {
    const badge = r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    process.stdout.write(`  [${badge}] ${r.step} — ${r.note}\n`);
  }
  const allPass = results.length > 0 && results.every((r) => r.ok);
  process.stdout.write(
    `\n  ${allPass ? '\x1b[32mAll steps passed.\x1b[0m' : '\x1b[33mSee notes above.\x1b[0m'}\n\n`,
  );
  process.exit(allPass ? 0 : 2);
}

main().catch((err: unknown) => {
  fail(errMsg(err));
});
