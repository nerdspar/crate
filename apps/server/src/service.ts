import type {
  AlbumDetail,
  NowPlaying,
  PlayerState,
  PlayersResponse,
  SearchAlbum,
  Settings,
  ShelfResponse,
  TransportCmd,
} from '@crate/shared';
import type { MusicAssistantProvider } from '@crate/providers';
import { buildArtwork } from './artwork.js';
import type { Config } from './config.js';
import type { AlbumRow, Db } from './db.js';
import { rowToAlbum } from './db.js';
import type { Hub } from './hub.js';
import { albumIdFromUri, buildShelfItem, spineWidthFor } from './shelf.js';

const ART_BASE = '/art';

export class Service {
  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly ma: MusicAssistantProvider,
    private readonly hub: Hub,
  ) {}

  async init(): Promise<void> {
    this.ma.onConnect(() => {
      void this.refreshPlayers();
    });
    this.ma.onState((states) => {
      this.hub.broadcast({ type: 'state', state: this.resolveStates(states) });
    });
    this.ma.onProgress((playerId, elapsed) => {
      this.hub.broadcast({ type: 'progress', playerId, elapsed });
    });
    try {
      await this.ma.start();
      await this.refreshPlayers();
    } catch (err) {
      process.stderr.write(`[crate] MA not reachable yet, will retry: ${(err as Error).message}\n`);
    }
  }

  private async refreshPlayers(): Promise<void> {
    try {
      const players = await this.ma.listPlayers();
      this.db.upsertPlayers(players.map((p) => ({ id: p.id, name: p.name, type: p.type, available: p.available })));
      this.hub.broadcast({ type: 'players' });
      const states = await this.ma.getState();
      this.hub.broadcast({ type: 'state', state: this.resolveStates(states) });
    } catch {
      /* transient */
    }
  }

  private resolveStates(states: PlayerState[]): PlayerState[] {
    const shelf = this.db.listShelf();
    const byUri = new Map(shelf.map((r) => [r.provider_uri, r.id]));
    const byTitle = new Map(shelf.map((r) => [r.title.toLowerCase(), r.id]));
    return states.map((s) => {
      const np = s.nowPlaying;
      if (!np) return s;
      const id =
        (np.albumUri ? byUri.get(np.albumUri) : undefined) ??
        (np.album ? byTitle.get(np.album.toLowerCase()) : undefined) ??
        null;
      const resolved: NowPlaying = { ...np, albumId: id };
      return { ...s, nowPlaying: resolved };
    });
  }

  getShelf(): ShelfResponse {
    return {
      items: this.db.listShelf().map((r) => buildShelfItem(r, ART_BASE)),
      stacks: this.db.listStacks(),
    };
  }

  async search(query: string): Promise<SearchAlbum[]> {
    const [albums, shelved] = [await this.ma.search(query), this.db.shelfedUris()];
    return albums.map((a) => ({
      providerUri: a.providerUri,
      provider: a.provider,
      title: a.title,
      artist: a.artist,
      year: a.year,
      artworkUrl: a.artworkUrl,
      onShelf: shelved.has(a.providerUri),
    }));
  }

  async addToShelf(providerUri: string): Promise<void> {
    const album = await this.ma.getAlbum(providerUri);
    if (!album) throw new Error(`album not found: ${providerUri}`);
    const id = albumIdFromUri(providerUri);
    const existing = this.db.getAlbum(id);
    const row: AlbumRow = {
      id,
      provider_uri: providerUri,
      provider: album.provider,
      title: album.title,
      artist: album.artist,
      year: album.year,
      artwork_url: album.artworkUrl,
      artwork_path: existing?.artwork_path ?? null,
      palette: existing?.palette ?? null,
      spine_strip_path: existing?.spine_strip_path ?? null,
      spine_width: existing?.spine_width ?? spineWidthFor(id),
      added_at: existing?.added_at ?? new Date().toISOString(),
      play_count: existing?.play_count ?? 0,
    };
    this.db.upsertAlbum(row);
    this.db.addToShelf(id);
    this.hub.broadcast({ type: 'shelf' });

    // Build artwork + palette in the background, then push the updated spine.
    if (album.artworkUrl) {
      void this.processArtwork(id, album.artworkUrl);
    }
  }

  private async processArtwork(id: string, url: string): Promise<void> {
    try {
      const art = await buildArtwork(id, url, { artDir: this.cfg.artDir, coverHeightPx: this.cfg.coverHeightPx });
      this.db.updateArtwork(id, art.artworkPath, art.spineStripPath, art.palette);
      this.hub.broadcast({ type: 'shelf' });
    } catch (err) {
      process.stderr.write(`[crate] artwork failed for ${id}: ${(err as Error).message}\n`);
    }
  }

  removeFromShelf(albumId: string): void {
    this.db.removeFromShelf(albumId);
    this.hub.broadcast({ type: 'shelf' });
  }

  async albumDetail(id: string): Promise<AlbumDetail | null> {
    const row = this.db.getAlbum(id);
    if (!row) return null;
    const tracks = await this.ma.getTracks(row.provider_uri).catch(() => []);
    return { album: rowToAlbum(row), tracks };
  }

  async play(albumId: string, trackIndex?: number, playerId?: string): Promise<void> {
    const row = this.db.getAlbum(albumId);
    if (!row) throw new Error(`unknown album: ${albumId}`);
    const player = playerId ?? this.defaultPlayerId();
    if (!player) throw new Error('no player available');
    await this.ma.play(player, row.provider_uri, trackIndex !== undefined ? { trackIndex } : undefined);
    this.db.incrementPlayCount(albumId);
  }

  transport(playerId: string, cmd: TransportCmd, position?: number): Promise<void> {
    return this.ma.transport(playerId, cmd, position);
  }

  setVolume(playerId: string, level: number): Promise<void> {
    return this.ma.setVolume(playerId, level);
  }

  group(playerIds: string[]): Promise<void> {
    const [leader, ...members] = playerIds;
    if (!leader) return Promise.resolve();
    return this.ma.setMembers(leader, members, []);
  }

  async getPlayers(): Promise<PlayersResponse> {
    const players = this.db.listPlayers();
    const state = await this.ma.getState().catch(() => [] as PlayerState[]);
    return { players, state: this.resolveStates(state) };
  }

  getSettings(): Settings {
    return this.db.getSettings();
  }

  putSettings(partial: Partial<Settings>): Settings {
    const next = this.db.putSettings(partial);
    this.hub.broadcast({ type: 'settings', settings: next });
    return next;
  }

  private defaultPlayerId(): string | null {
    const explicit = this.db.getDefaultPlayerId();
    if (explicit) return explicit;
    const sonos = this.db.listPlayers().find((p) => p.type === 'sonos' && p.available);
    return sonos?.id ?? this.db.listPlayers()[0]?.id ?? null;
  }
}
