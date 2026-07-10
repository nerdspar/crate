/**
 * Crate — Phase 0 risk spike.
 *
 * A standalone CLI that validates the single riskiest assumption in the whole
 * project (CRATE_BUILD_PLAN.md §3, §10, §11.1): that an Apple Music album,
 * resolved purely from the public iTunes Search API, can be started on a Sonos
 * room through an existing node-sonos-http-api instance — and that live state
 * events flow back.
 *
 * Four gated steps, run in order against the operator's own hardware:
 *   1. Search the iTunes Search API for an album (positional arg).
 *   2. Play it in a room (positional arg) via the `applemusic` action.
 *   3. Read back /{room}/state and print now-playing info.
 *   4. Start a temporary HTTP listener, surface the webhook callback URL, and
 *      confirm a transport event arrives.
 *
 * Zero runtime dependencies — Node 20+ built-ins and global fetch only.
 *
 *   npm run phase0 -- "<album query>" "<room>" [options]
 *
 * The Sonos base URL is a user setting: --sonos-url flag, or SONOS_HTTP_API
 * env var, defaulting to the operator's instance.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Settings & CLI
// ---------------------------------------------------------------------------

const DEFAULT_SONOS_URL = 'http://localhost:5005';

interface Options {
  album: string;
  room: string;
  sonosUrl: string;
  listenPort: number;
  callbackUrl: string | undefined;
  webhookTimeoutMs: number;
  limit: number;
  country: string;
  runWebhook: boolean;
}

function printUsage(): void {
  process.stdout.write(
    `\nCrate — Phase 0 risk spike\n\n` +
      `Usage:\n` +
      `  npm run phase0 -- "<album query>" "<room>" [options]\n\n` +
      `Positional:\n` +
      `  <album query>   Album to search for on the iTunes Search API, e.g. "Rumours Fleetwood Mac"\n` +
      `  <room>          Sonos room/zone name to play in, e.g. "Living Room"\n\n` +
      `Options:\n` +
      `  --sonos-url <url>       node-sonos-http-api base URL\n` +
      `                          (default ${DEFAULT_SONOS_URL}, or env SONOS_HTTP_API)\n` +
      `  --listen-port <n>       Local webhook listener port (default 5599, env PHASE0_LISTEN_PORT)\n` +
      `  --callback-url <url>    Full URL the Sonos API should POST webhooks to\n` +
      `                          (default http://<detected-LAN-IP>:<listen-port>/)\n` +
      `  --webhook-timeout <ms>  How long to wait for a webhook event (default 15000)\n` +
      `  --limit <n>             iTunes search result count to show (default 5)\n` +
      `  --country <cc>          iTunes storefront country (default US)\n` +
      `  --no-webhook            Skip step 4 (webhook listener)\n` +
      `  -h, --help              Show this help\n\n`,
  );
}

function parseOptions(argv: string[]): Options {
  // Node's parseArgs has no built-in `--no-<flag>` negation; handle it manually.
  const runWebhook = !argv.includes('--no-webhook');
  const filteredArgs = argv.filter((a) => a !== '--no-webhook' && a !== '--webhook');
  const { values, positionals } = parseArgs({
    args: filteredArgs,
    allowPositionals: true,
    options: {
      'sonos-url': { type: 'string' },
      'listen-port': { type: 'string' },
      'callback-url': { type: 'string' },
      'webhook-timeout': { type: 'string' },
      limit: { type: 'string' },
      country: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const album = positionals[0];
  const room = positionals[1];
  if (album === undefined || room === undefined) {
    printUsage();
    fail('Both <album query> and <room> are required.');
  }

  const sonosUrl = (values['sonos-url'] ?? process.env.SONOS_HTTP_API ?? DEFAULT_SONOS_URL).replace(
    /\/+$/,
    '',
  );
  const listenPort = toInt(values['listen-port'] ?? process.env.PHASE0_LISTEN_PORT, 5599, 'listen-port');
  const webhookTimeoutMs = toInt(values['webhook-timeout'], 15_000, 'webhook-timeout');
  const limit = toInt(values.limit, 5, 'limit');

  return {
    album,
    room,
    sonosUrl,
    listenPort,
    callbackUrl: values['callback-url'],
    webhookTimeoutMs,
    limit,
    country: values.country ?? 'US',
    runWebhook,
  };
}

function toInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive integer (got "${raw}").`);
  return n;
}

// ---------------------------------------------------------------------------
// iTunes Search API (step 1)
// ---------------------------------------------------------------------------

interface AlbumResult {
  collectionId: number;
  collectionName: string;
  artistName: string;
  artworkUrl: string;
  trackCount: number;
  releaseYear: string;
}

interface RawiTunesAlbum {
  collectionId?: number;
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
  trackCount?: number;
  releaseDate?: string;
  wrapperType?: string;
  collectionType?: string;
}

/** Rewrite artwork URL to the largest rendition (iTunes accepts up to 3000x3000). */
function upscaleArtwork(url100: string): string {
  return url100.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/3000x3000bb.$1');
}

async function searchAlbums(query: string, country: string, limit: number): Promise<AlbumResult[]> {
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', query);
  url.searchParams.set('entity', 'album');
  url.searchParams.set('media', 'music');
  url.searchParams.set('limit', String(Math.max(limit, 1)));
  url.searchParams.set('country', country);

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`iTunes Search API returned HTTP ${res.status} ${res.statusText}`);

  const body = (await res.json()) as { resultCount?: number; results?: RawiTunesAlbum[] };
  const rows = body.results ?? [];

  return rows
    .filter((r): r is RawiTunesAlbum & { collectionId: number } => typeof r.collectionId === 'number')
    .map((r) => ({
      collectionId: r.collectionId,
      collectionName: r.collectionName ?? '(unknown album)',
      artistName: r.artistName ?? '(unknown artist)',
      artworkUrl: r.artworkUrl100 ? upscaleArtwork(r.artworkUrl100) : '',
      trackCount: r.trackCount ?? 0,
      releaseYear: r.releaseDate ? r.releaseDate.slice(0, 4) : '—',
    }));
}

// ---------------------------------------------------------------------------
// node-sonos-http-api client (steps 2 & 3)
// ---------------------------------------------------------------------------

/**
 * Build a node-sonos-http-api URL. The room name is percent-encoded (it can
 * contain spaces, e.g. "Living Room"), but the action path is left literal —
 * encoding it would turn the required `album:{id}` colon into `%3A` and break
 * the applemusic action's routing.
 */
function buildUrl(baseUrl: string, room: string, action: string): string {
  return `${baseUrl}/${encodeURIComponent(room)}/${action}`;
}

/** GET a node-sonos-http-api URL and return parsed JSON (or raw text as fallback). */
async function sonosGet(url: string, timeoutMs = 15_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`GET ${url} → ${errMsg(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}\n${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface SonosState {
  playbackState?: string;
  volume?: number;
  mute?: boolean;
  currentTrack?: {
    artist?: string;
    title?: string;
    album?: string;
    duration?: number;
    trackNo?: number;
  };
  elapsedTime?: number;
  elapsedTimeFormatted?: string;
}

function asState(raw: unknown): SonosState {
  return typeof raw === 'object' && raw !== null ? (raw as SonosState) : {};
}

function fmtTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Webhook listener (step 4)
// ---------------------------------------------------------------------------

interface WebhookEvent {
  type: string;
  data: unknown;
  raw: string;
}

function detectLanIp(): string | undefined {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

interface Listener {
  events: WebhookEvent[];
  waitForEvent(timeoutMs: number): Promise<WebhookEvent | undefined>;
  close(): Promise<void>;
}

async function startWebhookListener(port: number): Promise<Listener> {
  const events: WebhookEvent[] = [];
  const waiters: Array<(e: WebhookEvent) => void> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(200).end('crate phase0 webhook listener');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let type = 'unknown';
      let data: unknown = raw;
      try {
        const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown };
        if (typeof parsed.type === 'string') type = parsed.type;
        data = parsed.data ?? parsed;
      } catch {
        /* keep raw */
      }
      const event: WebhookEvent = { type, data, raw };
      events.push(event);
      for (const w of waiters.splice(0)) w(event);
      res.writeHead(200).end('ok');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });

  return {
    events,
    waitForEvent(timeoutMs: number): Promise<WebhookEvent | undefined> {
      if (events.length > 0) return Promise.resolve(events[events.length - 1]);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onEvent);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(undefined);
        }, timeoutMs);
        const onEvent = (e: WebhookEvent): void => {
          clearTimeout(timer);
          resolve(e);
        };
        waiters.push(onEvent);
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  process.stdout.write(`\n\x1b[1mCrate — Phase 0 risk spike\x1b[0m\n`);
  process.stdout.write(`  Sonos API : ${opts.sonosUrl}\n`);
  process.stdout.write(`  Album     : "${opts.album}"\n`);
  process.stdout.write(`  Room      : "${opts.room}"\n`);

  // --- Step 1: iTunes search ------------------------------------------------
  heading('Step 1 — iTunes Search API');
  const albums = await searchAlbums(opts.album, opts.country, opts.limit);
  if (albums.length === 0) fail(`No albums found on iTunes for "${opts.album}".`);

  albums.forEach((a, i) => {
    const marker = i === 0 ? '▶' : ' ';
    process.stdout.write(
      `  ${marker} [${i}] ${a.artistName} — ${a.collectionName} (${a.releaseYear}), ` +
        `${a.trackCount} tracks, collectionId=${a.collectionId}\n`,
    );
  });
  const chosen = albums[0]!;
  process.stdout.write(`\n  Selected: ${chosen.artistName} — ${chosen.collectionName}\n`);
  process.stdout.write(`  Artwork : ${chosen.artworkUrl || '(none)'}\n`);
  record('1. iTunes search', true, `collectionId=${chosen.collectionId} (${chosen.artistName} — ${chosen.collectionName})`);

  // --- Step 2: applemusic playback -----------------------------------------
  heading('Step 2 — Play via applemusic action');
  const playUrl = buildUrl(opts.sonosUrl, opts.room, `applemusic/now/album:${chosen.collectionId}`);
  process.stdout.write(`  GET ${playUrl}\n`);
  try {
    const playResult = await sonosGet(playUrl, 25_000);
    const ok = isSuccess(playResult);
    process.stdout.write(`  Response: ${summarize(playResult)}\n`);
    record('2. applemusic playback', ok, ok ? 'status=success' : `unexpected response: ${summarize(playResult)}`);
    if (!ok) {
      process.stdout.write(
        `  \x1b[33mNote:\x1b[0m response was not a clean success. Common causes: Apple Music not\n` +
          `  linked in this Sonos system, wrong room name, or the album isn't in the storefront.\n`,
      );
    }
  } catch (err) {
    record('2. applemusic playback', false, errMsg(err));
    process.stderr.write(`  \x1b[31mFailed:\x1b[0m ${errMsg(err)}\n`);
  }

  // --- Step 3: state readback ----------------------------------------------
  heading('Step 3 — Read back /{room}/state');
  process.stdout.write(`  Waiting for the player to settle...\n`);
  const state = await readStateWithRetry(opts.sonosUrl, opts.room);
  if (state) {
    const t = state.currentTrack ?? {};
    process.stdout.write(`  Playback state : ${state.playbackState ?? '—'}\n`);
    process.stdout.write(`  Now playing    : ${t.artist ?? '—'} — ${t.title ?? '—'}\n`);
    process.stdout.write(`  Album          : ${t.album ?? '—'}\n`);
    process.stdout.write(
      `  Position       : ${state.elapsedTimeFormatted ?? fmtTime(state.elapsedTime)} / ${fmtTime(t.duration)}\n`,
    );
    process.stdout.write(`  Volume         : ${state.volume ?? '—'}${state.mute ? ' (muted)' : ''}\n`);
    const playing = state.playbackState === 'PLAYING';
    const hasTrack = Boolean(t.title);
    record(
      '3. state readback',
      hasTrack,
      hasTrack ? `${t.artist ?? '?'} — ${t.title ?? '?'} [${state.playbackState ?? '?'}]` : 'no currentTrack in state',
    );
    if (!playing) {
      process.stdout.write(`  \x1b[33mNote:\x1b[0m playbackState is not PLAYING — verify audio is actually audible.\n`);
    }
  } else {
    record('3. state readback', false, 'could not read /state');
  }

  // --- Step 4: webhook ------------------------------------------------------
  if (opts.runWebhook) {
    await runWebhookStep(opts);
  } else {
    process.stdout.write(`\n(Skipping step 4 — webhook — per --no-webhook)\n`);
  }

  // --- Summary --------------------------------------------------------------
  heading('Phase 0 summary');
  for (const r of results) {
    const badge = r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    process.stdout.write(`  [${badge}] ${r.step} — ${r.note}\n`);
  }
  const allPass = results.every((r) => r.ok);
  process.stdout.write(
    `\n  ${allPass ? '\x1b[32mAll steps passed.\x1b[0m' : '\x1b[33mSome steps need attention (see notes above).\x1b[0m'}\n\n`,
  );
  process.exit(allPass ? 0 : 2);
}

async function runWebhookStep(opts: Options): Promise<void> {
  heading('Step 4 — Webhook listener');
  const lanIp = detectLanIp();
  const callbackUrl = opts.callbackUrl ?? `http://${lanIp ?? 'YOUR-LAN-IP'}:${opts.listenPort}/`;

  const listener = await startWebhookListener(opts.listenPort);
  process.stdout.write(`  Listening on 0.0.0.0:${opts.listenPort}\n`);
  process.stdout.write(`  Callback URL : ${callbackUrl}\n`);
  process.stdout.write(
    `\n  \x1b[33mnode-sonos-http-api has no runtime webhook-registration endpoint.\x1b[0m\n` +
      `  The webhook is read from settings.json at startup. If your instance is not\n` +
      `  already posting here, add this to node-sonos-http-api's settings.json and restart:\n\n` +
      `      { "webhook": "${callbackUrl}" }\n\n`,
  );
  if (!lanIp && !opts.callbackUrl) {
    process.stdout.write(
      `  \x1b[33mCould not auto-detect a LAN IP.\x1b[0m Pass --callback-url explicitly with an address\n` +
        `  the Sonos API host can reach.\n`,
    );
  }

  process.stdout.write(`  Triggering a transport event (pause → play) to provoke a webhook...\n`);
  try {
    await sonosGet(buildUrl(opts.sonosUrl, opts.room, 'pause'));
    await sleep(1200);
    await sonosGet(buildUrl(opts.sonosUrl, opts.room, 'play'));
  } catch (err) {
    process.stdout.write(`  \x1b[33mCould not toggle transport:\x1b[0m ${errMsg(err)}\n`);
  }

  process.stdout.write(`  Waiting up to ${opts.webhookTimeoutMs}ms for an event...\n`);
  const event = await listener.waitForEvent(opts.webhookTimeoutMs);
  if (event) {
    process.stdout.write(`  \x1b[32mReceived webhook:\x1b[0m type="${event.type}"\n`);
    process.stdout.write(`  Payload (truncated): ${event.raw.slice(0, 300)}\n`);
    record('4. webhook event', true, `type=${event.type}`);
  } else {
    process.stdout.write(
      `  \x1b[31mNo webhook received within the timeout.\x1b[0m\n` +
        `  → Confirm settings.json points at ${callbackUrl}, the API was restarted,\n` +
        `    and that ${opts.sonosUrl.replace(/^https?:\/\//, '').split(':')[0]} can reach this host on port ${opts.listenPort}\n` +
        `    (firewall / NAT / VPN). Re-run once configured.\n`,
    );
    record('4. webhook event', false, 'no event received (likely webhook not configured in settings.json)');
  }

  await listener.close();
}

async function readStateWithRetry(baseUrl: string, room: string): Promise<SonosState | undefined> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? 2500 : 1500);
    try {
      const state = asState(await sonosGet(buildUrl(baseUrl, room, 'state')));
      if (state.currentTrack?.title || state.playbackState) return state;
    } catch (err) {
      if (attempt === 3) {
        process.stderr.write(`  \x1b[31mFailed to read /state:\x1b[0m ${errMsg(err)}\n`);
        return undefined;
      }
    }
  }
  return undefined;
}

function isSuccess(result: unknown): boolean {
  if (typeof result === 'object' && result !== null && 'status' in result) {
    return (result as { status?: unknown }).status === 'success';
  }
  // Some actions return an empty body / 200 with no JSON; treat non-error as success.
  return result === '' || typeof result === 'string';
}

function summarize(result: unknown): string {
  if (typeof result === 'string') return result.length ? result.slice(0, 200) : '(empty 200 OK)';
  return JSON.stringify(result).slice(0, 200);
}

function errMsg(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'request timed out';
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  let causeStr = '';
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    causeStr = ` (cause: ${typeof code === 'string' ? code : cause.message})`;
  } else if (cause !== undefined && cause !== null) {
    causeStr = ` (cause: ${String(cause)})`;
  }
  return err.message + causeStr;
}

main().catch((err: unknown) => {
  fail(errMsg(err));
});
