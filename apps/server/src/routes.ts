import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  AddMediaRequest,
  AddPlaylistRequest,
  AddToShelfRequest,
  BrightnessRequest,
  CrateBackup,
  CreateShelfRequest,
  ExtraMediaKind,
  GroupRequest,
  MaConfigValue,
  OverrideRequest,
  PlayRequest,
  Settings,
  ShelfAlbumRequest,
  RepeatRequest,
  ShuffleRequest,
  TransportRequest,
  UpdateTarget,
  VolumeRequest,
} from '@crate/shared';
import { EXTRA_MEDIA } from '@crate/shared';
import type { Service } from './service.js';
import type { Auth } from './auth.js';

interface MultipartRequest {
  file(): Promise<{ toBuffer(): Promise<Buffer> } | undefined>;
}

export function registerRoutes(app: FastifyInstance, service: Service, auth: Auth): void {
  // --- Admin auth gate (Phase 5) ---
  // Endpoints the wall + shared UIs use stay open even once a passphrase is set; everything else
  // under /api/ (config, curation, /api/admin/*) needs a session. Safe-by-default — a new endpoint
  // is protected unless it's added to this allowlist.
  const OPEN: Array<[string, RegExp]> = [
    ['GET', /^\/api\/shelf$/],
    ['GET', /^\/api\/albums\/[^/]+$/],
    ['GET', /^\/api\/provider-album$/],
    ['GET', /^\/api\/players$/],
    ['GET', /^\/api\/search(\/global)?$/],
    ['GET', /^\/api\/artist\/(albums|songs)$/],
    ['GET', /^\/api\/sources$/],
    ['GET', /^\/api\/settings$/],
    ['GET', /^\/api\/playlists\/tracks$/],
    ['POST', /^\/api\/playlists\/prewarm$/],
    ['POST', /^\/api\/(play|transport|volume|shuffle|repeat|group)$/],
    ['GET', /^\/api\/queue$/],
    ['POST', /^\/api\/queue\/(play|move|remove|clear|enqueue)$/],
    // Wall-facing media reads: podcast/audiobook browse (library), tab-scoped search, episode
    // lists, audiobook detail, continue-listening — plus the played/unplayed toggle. All are wall
    // (unauthenticated touchscreen) surfaces; the media MUTATIONS (POST /api/media/:kind add + sync)
    // stay protected as admin curation.
    ['GET', /^\/api\/media\/(?:[^/]+\/(?:library|search|episodes|detail)|continue)$/],
    ['POST', /^\/api\/media\/played$/],
    // Control-center system controls live on the wall (an unauthenticated touchscreen).
    ['GET', /^\/api\/system\/(status|services)$/],
    ['POST', /^\/api\/system\/(brightness|restart|reboot)$/],
    ['POST', /^\/api\/system\/display\/(sleep|wake)$/],
    ['POST', /^\/api\/system\/services\/restart$/],
  ];
  const isOpen = (method: string, path: string): boolean => OPEN.some(([m, re]) => m === method && re.test(path));

  app.addHook('onRequest', async (req, reply) => {
    if (!auth.enabled()) return; // off until a passphrase is set
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || path.startsWith('/api/auth/')) return; // app shells + auth are open
    if (isOpen(req.method, path)) return;
    if (!auth.authed(req.headers.cookie)) {
      await reply.code(401).send({ error: 'Admin sign-in required' });
    }
  });

  app.get('/api/auth/status', (req) => ({
    enabled: auth.enabled(),
    authed: auth.enabled() ? auth.authed(req.headers.cookie) : true,
  }));
  // Brute-force + scrypt-CPU-DoS guard: exponential backoff per client IP around the (deliberately
  // slow, event-loop-blocking) scrypt verify. Shared by BOTH the login and the unauthenticated
  // passphrase-change paths — either would otherwise be an unthrottled guessing oracle + DoS.
  const loginFails = new Map<string, { count: number; until: number }>();
  const inBackoff = (ip: string): boolean => {
    const rec = loginFails.get(ip || 'unknown');
    return !!(rec && Date.now() < rec.until);
  };
  const recordAttempt = (ip: string, ok: boolean): void => {
    const key = ip || 'unknown';
    const now = Date.now();
    for (const [k, v] of loginFails) if (now - v.until > 10 * 60_000) loginFails.delete(k); // evict aged-out entries
    if (ok) return void loginFails.delete(key);
    const rec = loginFails.get(key);
    const count = (rec && now - rec.until < 10 * 60_000 ? rec.count : 0) + 1;
    const wait = count <= 2 ? 0 : Math.min(30_000, 2 ** (count - 3) * 1000); // 0,0,1s,2s,4s,…,30s
    loginFails.set(key, { count, until: now + wait });
  };
  app.post('/api/auth/login', (req, reply) => {
    const { passphrase } = (req.body ?? {}) as { passphrase?: string };
    if (!auth.enabled()) return { ok: true };
    if (inBackoff(req.ip)) return reply.code(429).send({ error: 'Too many attempts — try again shortly' });
    const ok = auth.verifyPassphrase(passphrase ?? '');
    recordAttempt(req.ip, ok);
    if (!ok) return reply.code(401).send({ error: 'Wrong passphrase' });
    void reply.header('set-cookie', auth.setCookieHeader(auth.issueToken()));
    return { ok: true };
  });
  app.post('/api/auth/logout', (_req, reply) => {
    void reply.header('set-cookie', auth.clearCookieHeader());
    return { ok: true };
  });
  // Set / change / clear (empty `next`) the passphrase. When already enabled, requires the current
  // passphrase OR a live session; re-issues a session so the caller isn't locked out by the change.
  app.post('/api/auth/passphrase', (req, reply) => {
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    // An unauthenticated change must prove the CURRENT passphrase — gate that scrypt verify behind
    // the same per-IP throttle as login, or it's an unthrottled guessing oracle + event-loop DoS.
    // A live session skips it (already trusted).
    if (auth.enabled() && !auth.authed(req.headers.cookie)) {
      if (inBackoff(req.ip)) return reply.code(429).send({ error: 'Too many attempts — try again shortly' });
      const ok = auth.verifyPassphrase(current ?? '');
      recordAttempt(req.ip, ok);
      if (!ok) return reply.code(401).send({ error: 'Wrong current passphrase' });
    }
    auth.setPassphrase((next ?? '').trim());
    void reply.header('set-cookie', auth.enabled() ? auth.setCookieHeader(auth.issueToken()) : auth.clearCookieHeader());
    return { ok: true, enabled: auth.enabled() };
  });

  // Recovery for a forgotten admin passphrase: clear the lock. LOOPBACK-ONLY — the request must
  // originate from the device itself (127.0.0.1/::1), which for the appliance means the wall's own
  // kiosk browser (it loads http://localhost/wall/) or a shell on the box. Unlike the reboot/
  // brightness wall controls this DEFEATS the admin credential, so a phone or laptop elsewhere on
  // the LAN must not be able to trigger it — the physical presence the old comment only assumed is
  // now enforced. (Split deploys where the wall is a separate device from the server reset from a
  // host shell instead: `curl -X POST http://localhost:<port>/api/auth/reset`.)
  app.post('/api/auth/reset', (req, reply) => {
    const addr = req.socket.remoteAddress ?? '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (!loopback) {
      return reply.code(403).send({ error: 'Admin reset can only be run from the wall itself' });
    }
    auth.setPassphrase('');
    void reply.header('set-cookie', auth.clearCookieHeader());
    return { ok: true, enabled: auth.enabled() };
  });

  app.get('/api/shelf', (req) => service.getShelf((req.query as { shelf?: string }).shelf));

  // Named shelves (curated collections; albums can belong to several).
  app.post('/api/shelves', (req) => {
    const b = (req.body ?? {}) as CreateShelfRequest;
    return service.createShelf(b.name, b.kind);
  });
  app.put('/api/shelves/:id', (req) => {
    const { id } = req.params as { id: string };
    service.renameShelf(id, (req.body as { name: string }).name);
    return { ok: true };
  });
  app.delete('/api/shelves/:id', (req) => {
    service.deleteShelf((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/shelves/:id/albums', (req) => {
    const { id } = req.params as { id: string };
    service.addAlbumToShelf(id, (req.body as ShelfAlbumRequest).albumId);
    return { ok: true };
  });
  app.delete('/api/shelves/:id/albums/:albumId', (req) => {
    const { id, albumId } = req.params as { id: string; albumId: string };
    service.removeAlbumFromShelf(id, albumId);
    return { ok: true };
  });

  app.get('/api/albums/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await service.albumDetail(id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return detail;
  });

  app.get('/api/players', () => service.getPlayers());

  app.get('/api/search', async (req) => {
    const { q, source } = req.query as { q?: string; source?: string };
    const query = (q ?? '').trim();
    return query ? service.search(query, source) : [];
  });

  // Global search: artists + albums + playlists + songs, optionally scoped to one source.
  app.get('/api/search/global', async (req) => {
    const { q, source, limit } = req.query as { q?: string; source?: string; limit?: string };
    const query = (q ?? '').trim();
    if (!query) return { artists: [], albums: [], playlists: [], songs: [], sources: [] };
    const n = Math.min(Math.max(Number(limit) || 20, 20), 200); // clamp 20..200
    return service.globalSearch(query, source, n);
  });

  // Artist detail: albums (fast) and top songs (popularity-ranked via provider search).
  app.get('/api/artist/albums', async (req) => {
    const { uri } = req.query as { uri?: string };
    return uri ? service.artistAlbums(uri) : [];
  });
  app.get('/api/artist/songs', async (req) => {
    const { uri, name } = req.query as { uri?: string; name?: string };
    return uri ? service.artistTopSongs(uri, name) : [];
  });

  app.post('/api/play', async (req) => {
    const b = (req.body ?? {}) as PlayRequest;
    await service.play(b.albumId, b.trackIndex, b.playerId, b.providerUri, b.trackUris, b.position);
    return { ok: true };
  });

  // Off-shelf album detail (song→album card in a playlist song view).
  app.get('/api/provider-album', async (req, reply) => {
    const uri = (req.query as { uri?: string }).uri;
    if (!uri) return reply.code(400).send({ error: 'uri required' });
    const detail = await service.providerAlbum(uri);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return detail;
  });

  app.post('/api/transport', async (req) => {
    const b = (req.body ?? {}) as TransportRequest;
    await service.transport(b.playerId, b.cmd, b.position);
    return { ok: true };
  });

  app.post('/api/volume', async (req) => {
    const b = (req.body ?? {}) as VolumeRequest;
    await service.setVolume(b.playerId, b.level);
    return { ok: true };
  });

  app.post('/api/shuffle', async (req) => {
    const b = (req.body ?? {}) as ShuffleRequest;
    await service.setShuffle(b.playerId, b.enabled);
    return { ok: true };
  });

  app.post('/api/repeat', async (req) => {
    const b = (req.body ?? {}) as RepeatRequest;
    await service.setRepeat(b.playerId, b.mode);
    return { ok: true };
  });

  app.post('/api/group', async (req) => {
    const b = (req.body ?? {}) as GroupRequest;
    await service.group(b.playerIds);
    return { ok: true };
  });

  // Play queue ("Up Next" overlay). Per-player; the wall passes its current target.
  app.get('/api/queue', (req) => {
    const player = (req.query as { player?: string }).player;
    return player ? service.queue(player) : { items: [], currentIndex: null };
  });
  app.post('/api/queue/play', async (req) => {
    const b = (req.body ?? {}) as{ player: string; index: number };
    await service.queuePlay(b.player, b.index);
    return { ok: true };
  });
  app.post('/api/queue/move', async (req) => {
    const b = (req.body ?? {}) as{ player: string; itemId: string; posShift: number };
    await service.queueMove(b.player, b.itemId, b.posShift);
    return { ok: true };
  });
  app.post('/api/queue/remove', async (req) => {
    const b = (req.body ?? {}) as{ player: string; itemId: string };
    await service.queueRemove(b.player, b.itemId);
    return { ok: true };
  });
  app.post('/api/queue/clear', async (req) => {
    const b = (req.body ?? {}) as{ player: string };
    await service.queueClear(b.player);
    return { ok: true };
  });
  app.post('/api/queue/enqueue', async (req) => {
    const b = (req.body ?? {}) as{ player: string; uri: string };
    await service.queueEnqueue(b.player, b.uri);
    return { ok: true };
  });

  app.post('/api/shelf/add', async (req) => {
    const b = (req.body ?? {}) as AddToShelfRequest;
    const res = await service.addToShelf(b.providerUri, b.shelfId);
    return { ok: true, ...res };
  });

  app.delete('/api/shelf/:id', (req) => {
    const { id } = req.params as { id: string };
    service.removeFromShelf(id);
    return { ok: true };
  });

  // Manual ordering: reorder the library, or a crate when `shelf` is given.
  app.post('/api/shelf/reorder', (req) => {
    const b = (req.body ?? {}) as{ albumIds: string[]; shelf?: string };
    service.reorder(b.albumIds ?? [], b.shelf);
    return { ok: true };
  });

  // Connected streaming sources (Apple Music accounts, later Spotify, …).
  app.get('/api/sources', () => service.listSources());

  // Library albums: browse the user's saved albums (source-scoped / searched / favorites,
  // paged), and bulk-import an entire library.
  app.get('/api/library/albums', (req) => {
    const q = req.query as { source?: string; search?: string; favorite?: string; limit?: string; offset?: string };
    return service.listLibraryAlbums({
      source: q.source && q.source !== 'all' ? q.source : undefined,
      search: q.search?.trim() || undefined,
      favorite: q.favorite === '1' || q.favorite === 'true',
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });
  app.post('/api/library/import', (req) => {
    const b = (req.body ?? {}) as { source?: string };
    return service.importLibrary(b.source && b.source !== 'all' ? b.source : undefined);
  });

  // Playlists: list the provider-library playlists for the add picker, and add one.
  app.get('/api/playlists/library', () => service.listLibraryPlaylists());
  app.get('/api/playlists/search', async (req) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    return q ? service.searchPlaylists(q) : [];
  });
  app.post('/api/playlists', async (req) => {
    const b = (req.body ?? {}) as AddPlaylistRequest;
    await service.addPlaylist(b.providerUri);
    return { ok: true };
  });
  // Fire-and-forget: start resolving a playlist's track art before its shelf opens.
  app.post('/api/playlists/prewarm', (req) => {
    void service.prewarmPlaylist(((req.body ?? {}) as { providerUri?: string }).providerUri ?? '');
    return { ok: true };
  });
  // Crate-local song curation within a playlist shelf (never edits the source playlist).
  app.post('/api/playlists/:shelfId/songs/reorder', (req) => {
    const { shelfId } = req.params as { shelfId: string };
    const b = (req.body ?? {}) as{ trackUris?: string[] };
    service.reorderPlaylistSongs(shelfId, b.trackUris ?? []);
    return { ok: true };
  });
  app.post('/api/playlists/:shelfId/songs/hide', (req) => {
    const { shelfId } = req.params as { shelfId: string };
    const b = (req.body ?? {}) as{ trackUri: string; hidden?: boolean };
    service.setPlaylistSongHidden(shelfId, b.trackUri, b.hidden !== false);
    return { ok: true };
  });

  // A playlist's tracks, for the play-now overlay.
  app.get('/api/playlists/tracks', async (req) => {
    const uri = ((req.query as { uri?: string }).uri ?? '').trim();
    return uri ? service.providerPlaylistTracks(uri) : [];
  });

  // --- Extra media: radio / podcasts / audiobooks (via MA) ---
  const MEDIA_KINDS = new Set<string>(EXTRA_MEDIA.map((m) => m.kind));
  const asKind = (reply: FastifyReply, k: string): ExtraMediaKind | null => {
    if (MEDIA_KINDS.has(k)) return k as ExtraMediaKind;
    void reply.code(404).send({ error: 'unknown media kind' });
    return null;
  };
  app.get('/api/media/:kind/library', (req, reply) => {
    const kind = asKind(reply, (req.params as { kind: string }).kind);
    return kind ? service.listLibraryMedia(kind) : undefined;
  });
  app.get('/api/media/:kind/search', (req, reply) => {
    const kind = asKind(reply, (req.params as { kind: string }).kind);
    if (!kind) return undefined;
    const q = req.query as { q?: string; source?: string };
    return service.searchMedia(kind, (q.q ?? '').trim(), q.source);
  });
  app.post('/api/media/:kind', async (req, reply) => {
    const kind = asKind(reply, (req.params as { kind: string }).kind);
    if (!kind) return undefined;
    await service.addMedia(kind, (req.body as AddMediaRequest).providerUri);
    return { ok: true };
  });
  // Import every saved item of a kind from MA's library onto its shelf.
  app.post('/api/media/:kind/sync', (req, reply) => {
    const kind = asKind(reply, (req.params as { kind: string }).kind);
    return kind ? service.syncLibraryMedia(kind) : undefined;
  });
  // Toggle a podcast episode / audiobook played-state (the wall ✓). Literal path so it doesn't
  // hit POST /api/media/:kind. Feed providers (iTunes/RSS) persist it; account-based streaming
  // (e.g. Spotify) owns played-state server-side and won't — the wall reflects the real result.
  app.post('/api/media/played', async (req) => {
    const b = (req.body ?? {}) as { uri?: string; played?: boolean };
    await service.markPlayed(b.uri ?? '', b.played === true);
    return { ok: true };
  });
  // A saved podcast's episodes (for its track-list view).
  app.get('/api/media/podcast/episodes', (req) => service.podcastEpisodes((req.query as { uri?: string }).uri ?? ''));
  // An audiobook's progress + chapter list (for its reader view).
  app.get('/api/media/audiobook/detail', (req) => service.audiobookDetail((req.query as { uri?: string }).uri ?? ''));
  // In-progress items of a kind, for the "Continue listening" strip.
  app.get('/api/media/continue', (req, reply) => {
    const kind = asKind(reply, (req.query as { kind?: string }).kind ?? '');
    return kind ? service.continueListening(kind) : undefined;
  });

  // Per-album overrides: upload custom spine/cover, or set label font/color/spacing.
  app.post('/api/albums/:id/art/:kind', async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string };
    // `id` becomes a filename under artDir — constrain it to the album-id charset so a
    // crafted value (e.g. "../foo") can't traverse out and overwrite arbitrary files.
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send({ error: 'bad id' });
    if (kind !== 'spine' && kind !== 'cover') return reply.code(400).send({ error: 'kind must be spine|cover' });
    const part = await (req as unknown as MultipartRequest).file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    await service.uploadArt(id, kind, await part.toBuffer());
    return { ok: true };
  });

  app.post('/api/albums/:id/override', (req) => {
    const { id } = req.params as { id: string };
    service.setOverride(id, req.body as OverrideRequest);
    return { ok: true };
  });

  app.get('/api/settings', () => service.getSettings());

  app.put('/api/settings', (req) => service.putSettings(req.body as Partial<Settings>));

  // Re-run artwork + spine-scan for all shelved albums (backfills scans for
  // albums added before scan mode existed). Runs in the background.
  app.post('/api/system/artwork-refresh', () => {
    void service.refreshArtwork();
    return { ok: true };
  });

  // Control center system rows (§6).
  app.get('/api/system/status', () => service.systemStatus());
  app.get('/api/system/services', () => service.systemServices());
  app.post('/api/system/services/restart', (req) => {
    const { id } = (req.body ?? {}) as { id?: string };
    if (id === 'server' || id === 'shelf' || id === 'admin' || id === 'musicAssistant') return service.restartService(id);
    return { ok: false };
  });

  app.post('/api/system/brightness', (req) => {
    const b = (req.body ?? {}) as BrightnessRequest;
    return service.setBrightness(b.level);
  });

  app.post('/api/system/display/sleep', () => service.setDisplaySleep(true));
  app.post('/api/system/display/wake', () => service.setDisplaySleep(false));

  app.post('/api/system/restart', () => service.restart());
  app.post('/api/system/reboot', () => service.reboot());

  // Software update (admin-only, so kept out of the wall's OPEN allowlist). The check is a
  // read-only git fetch; the POST launches deploy/pi/update.sh and only runs on the appliance.
  app.get('/api/system/update', () => service.checkUpdate());
  app.post('/api/system/update', (req) => {
    const t = (req.body as { target?: string } | undefined)?.target;
    const target: UpdateTarget = t === 'crate' || t === 'ma' ? t : 'both';
    return service.runUpdate(target);
  });
  app.get('/api/system/update/progress', () => service.updateProgress());
  app.get('/api/system/update/auto', () => service.getAutoUpdateConfig());
  app.put('/api/system/update/auto', (req) => service.setAutoUpdateConfig((req.body ?? {}) as Parameters<typeof service.setAutoUpdateConfig>[0]));

  // --- Music Assistant management (Phase 5) ---
  // Status reads cached connection info (safe even when MA is down). The others talk to MA,
  // so wrap them: a disconnected MA or a token missing CONFIG_PROVIDERS_WRITE surfaces as a
  // 502 with MA's message rather than an opaque 500.
  const maCall = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      void reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  };

  app.get('/api/admin/ma/status', () => service.maStatus());
  app.get('/api/admin/ma/connection', () => service.getMaConnection());
  app.put('/api/admin/ma/connection', (req, reply) => {
    const b = (req.body ?? {}) as{ url?: string; token?: string };
    return maCall(reply, () => service.setMaConnection(b));
  });
  app.post('/api/admin/ma/connection/test', (req, reply) => {
    const b = (req.body ?? {}) as{ url?: string; token?: string };
    return maCall(reply, () => service.testMaConnection(b));
  });
  app.post('/api/admin/ma/connection/mint', (req, reply) => {
    const b = (req.body ?? {}) as{ url?: string; username?: string; password?: string };
    return maCall(reply, () => service.mintMaConnection(b));
  });
  app.post('/api/admin/ma/connection/needs-setup', (req, reply) => {
    const b = (req.body ?? {}) as{ url?: string };
    return maCall(reply, () => service.maSetupState(b.url));
  });

  // First-run onboarding flag.
  app.get('/api/admin/onboarding', () => service.getOnboarding());
  app.post('/api/admin/onboarding/done', () => service.completeOnboarding());
  app.get('/api/admin/ma/sources', (_req, reply) => maCall(reply, () => service.maSources()));
  app.get('/api/admin/ma/providers', (_req, reply) => maCall(reply, () => service.maAvailableProviders()));
  app.post('/api/admin/ma/sources/entries', (req, reply) => {
    const b = (req.body ?? {}) as{ domain: string; instanceId?: string; action?: string; values?: Record<string, MaConfigValue> };
    return maCall(reply, () => service.maSourceEntries(b.domain, { instanceId: b.instanceId, action: b.action, values: b.values }));
  });
  // Poll for the authorize URL MA emits after an OAuth/MusicKit auth action is started.
  app.get('/api/admin/ma/auth-url', (req) => service.maAuthUrl(((req.query as { session?: string }).session ?? '')));
  app.post('/api/admin/ma/sources', (req, reply) => {
    const b = (req.body ?? {}) as{ domain: string; values?: Record<string, MaConfigValue>; instanceId?: string };
    return maCall(reply, () => service.maSaveSource(b.domain, b.values ?? {}, b.instanceId));
  });
  app.delete('/api/admin/ma/sources/:instanceId', (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    return maCall(reply, async () => {
      await service.maRemoveSource(instanceId);
      return { ok: true };
    });
  });
  app.post('/api/admin/ma/sources/:instanceId/reload', (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    return maCall(reply, async () => {
      await service.maReloadSource(instanceId);
      return { ok: true };
    });
  });
  app.get('/api/admin/ma/builtin-playlists', (_req, reply) =>
    maCall(reply, async () => ({ enabled: await service.maBuiltinPlaylistsEnabled() })),
  );
  app.post('/api/admin/ma/builtin-playlists', (req, reply) => {
    const enabled = (req.body as { enabled?: boolean }).enabled === true;
    return maCall(reply, async () => {
      await service.maSetBuiltinPlaylists(enabled);
      return { ok: true, enabled };
    });
  });

  // --- Config backup / restore (Phase 5) ---
  app.get('/api/admin/backup/export', (_req, reply) => {
    void reply.header('content-disposition', 'attachment; filename="crate-backup.json"');
    return service.exportBackup();
  });
  // A large library can exceed Fastify's 1 MB default body limit — allow a generous ceiling.
  app.post('/api/admin/backup/import', { bodyLimit: 32 * 1024 * 1024 }, (req, reply) => {
    try {
      return service.importBackup(req.body as CrateBackup);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'Import failed' });
    }
  });

  // --- GitHub auto-backup ---
  app.get('/api/admin/backup/github', () => service.getGithubConfig());
  app.put('/api/admin/backup/github', (req) =>
    service.setGithubConfig(req.body as { repo?: string; branch?: string; path?: string; token?: string }),
  );
  app.get('/api/admin/backup/github/repos', async (_req, reply) => {
    try {
      return await service.listGithubRepos();
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'Failed to list repos' });
    }
  });
  app.post('/api/admin/backup/github/push', async (_req, reply) => {
    try {
      return await service.pushGithubBackup();
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'Push failed' });
    }
  });
  app.post('/api/admin/backup/github/restore', async (_req, reply) => {
    try {
      return await service.restoreGithubBackup();
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'Restore failed' });
    }
  });
  app.post('/api/admin/backup/github/test', async (_req, reply) => {
    try {
      return await service.testGithubBackup();
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'Test failed' });
    }
  });
  app.delete('/api/admin/backup/github/history', () => service.clearGithubHistory());
}
