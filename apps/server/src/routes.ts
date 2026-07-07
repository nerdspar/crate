import type { FastifyInstance } from 'fastify';
import type {
  AddPlaylistRequest,
  AddToShelfRequest,
  BrightnessRequest,
  CreateShelfRequest,
  GroupRequest,
  OverrideRequest,
  PlayRequest,
  Settings,
  ShelfAlbumRequest,
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
    const q = ((req.query as { q?: string }).q ?? '').trim();
    return q ? service.search(q) : [];
  });

  // Global search: albums + playlists + songs, optionally scoped to one source.
  app.get('/api/search/global', async (req) => {
    const { q, source } = req.query as { q?: string; source?: string };
    const query = (q ?? '').trim();
    if (!query) return { albums: [], playlists: [], songs: [], sources: [] };
    return service.globalSearch(query, source);
  });

  app.post('/api/play', async (req) => {
    const b = req.body as PlayRequest;
    await service.play(b.albumId, b.trackIndex, b.playerId, b.providerUri);
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

  app.post('/api/group', async (req) => {
    const b = req.body as GroupRequest;
    await service.group(b.playerIds);
    return { ok: true };
  });

  app.post('/api/shelf/add', async (req) => {
    const b = req.body as AddToShelfRequest;
    await service.addToShelf(b.providerUri, b.shelfId);
    return { ok: true };
  });

  app.delete('/api/shelf/:id', (req) => {
    const { id } = req.params as { id: string };
    service.removeFromShelf(id);
    return { ok: true };
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

  app.post('/api/system/brightness', (req) => {
    const b = req.body as BrightnessRequest;
    return service.setBrightness(b.level);
  });

  app.post('/api/system/display/sleep', () => service.setDisplaySleep(true));
  app.post('/api/system/display/wake', () => service.setDisplaySleep(false));

  app.post('/api/system/restart', () => service.restart());
  app.post('/api/system/reboot', () => service.reboot());
}
