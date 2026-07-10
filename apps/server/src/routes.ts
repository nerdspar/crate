import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  AddPlaylistRequest,
  AddToShelfRequest,
  BrightnessRequest,
  CreateShelfRequest,
  GroupRequest,
  MaConfigValue,
  OverrideRequest,
  PlayRequest,
  Settings,
  ShelfAlbumRequest,
  RepeatRequest,
  ShuffleRequest,
  TransportRequest,
  VolumeRequest,
} from '@crate/shared';
import type { Service } from './service.js';

interface MultipartRequest {
  file(): Promise<{ toBuffer(): Promise<Buffer> } | undefined>;
}

export function registerRoutes(app: FastifyInstance, service: Service): void {
  app.get('/api/shelf', (req) => service.getShelf((req.query as { shelf?: string }).shelf));

  // Named shelves (curated collections; albums can belong to several).
  app.post('/api/shelves', (req) => {
    const b = req.body as CreateShelfRequest;
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
    const b = req.body as PlayRequest;
    await service.play(b.albumId, b.trackIndex, b.playerId, b.providerUri, b.trackUris);
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
    const b = req.body as TransportRequest;
    await service.transport(b.playerId, b.cmd, b.position);
    return { ok: true };
  });

  app.post('/api/volume', async (req) => {
    const b = req.body as VolumeRequest;
    await service.setVolume(b.playerId, b.level);
    return { ok: true };
  });

  app.post('/api/shuffle', async (req) => {
    const b = req.body as ShuffleRequest;
    await service.setShuffle(b.playerId, b.enabled);
    return { ok: true };
  });

  app.post('/api/repeat', async (req) => {
    const b = req.body as RepeatRequest;
    await service.setRepeat(b.playerId, b.mode);
    return { ok: true };
  });

  app.post('/api/group', async (req) => {
    const b = req.body as GroupRequest;
    await service.group(b.playerIds);
    return { ok: true };
  });

  app.post('/api/shelf/add', async (req) => {
    const b = req.body as AddToShelfRequest;
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
    const b = req.body as { albumIds: string[]; shelf?: string };
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
    const b = req.body as AddPlaylistRequest;
    await service.addPlaylist(b.providerUri);
    return { ok: true };
  });
  // Fire-and-forget: start resolving a playlist's track art before its shelf opens.
  app.post('/api/playlists/prewarm', (req) => {
    void service.prewarmPlaylist((req.body as { providerUri: string }).providerUri);
    return { ok: true };
  });
  // Crate-local song curation within a playlist shelf (never edits the source playlist).
  app.post('/api/playlists/:shelfId/songs/reorder', (req) => {
    const { shelfId } = req.params as { shelfId: string };
    const b = req.body as { trackUris?: string[] };
    service.reorderPlaylistSongs(shelfId, b.trackUris ?? []);
    return { ok: true };
  });
  app.post('/api/playlists/:shelfId/songs/hide', (req) => {
    const { shelfId } = req.params as { shelfId: string };
    const b = req.body as { trackUri: string; hidden?: boolean };
    service.setPlaylistSongHidden(shelfId, b.trackUri, b.hidden !== false);
    return { ok: true };
  });

  // A playlist's tracks, for the play-now overlay.
  app.get('/api/playlists/tracks', async (req) => {
    const uri = ((req.query as { uri?: string }).uri ?? '').trim();
    return uri ? service.providerPlaylistTracks(uri) : [];
  });

  // Per-album overrides: upload custom spine/cover, or set label font/color/spacing.
  app.post('/api/albums/:id/art/:kind', async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string };
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
    const b = req.body as BrightnessRequest;
    return service.setBrightness(b.level);
  });

  app.post('/api/system/display/sleep', () => service.setDisplaySleep(true));
  app.post('/api/system/display/wake', () => service.setDisplaySleep(false));

  app.post('/api/system/restart', () => service.restart());
  app.post('/api/system/reboot', () => service.reboot());

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
  app.get('/api/admin/ma/sources', (_req, reply) => maCall(reply, () => service.maSources()));
  app.get('/api/admin/ma/providers', (_req, reply) => maCall(reply, () => service.maAvailableProviders()));
  app.post('/api/admin/ma/sources/entries', (req, reply) => {
    const b = req.body as { domain: string; instanceId?: string; action?: string; values?: Record<string, MaConfigValue> };
    return maCall(reply, () => service.maSourceEntries(b.domain, { instanceId: b.instanceId, action: b.action, values: b.values }));
  });
  app.post('/api/admin/ma/sources', (req, reply) => {
    const b = req.body as { domain: string; values?: Record<string, MaConfigValue>; instanceId?: string };
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
}
