import type {
  AlbumDetail,
  NowPlaying,
  PlayerState,
  PlayersResponse,
  SearchAlbum,
  Settings,
  ShelfResponse,
  SystemStatus,
  TransportCmd,
} from '@crate/shared';
import type { MusicAssistantProvider } from '@crate/providers';
import type { AlbumOverride } from '@crate/shared';
import { buildArtwork, buildSpineScan, processUploadedArt } from './artwork.js';
import { findSpineScans } from './musicbrainz.js';
import type { Config } from './config.js';
import type { AlbumRow, Db } from './db.js';
import { rowToAlbum } from './db.js';
import type { Hub } from './hub.js';
import { albumIdFromUri, buildShelfItem, spineWidthFor } from './shelf.js';
import { applyBrightness, detectBrightnessMethod, getLocalIp, rebootSystem, setDisplayPower } from './system.js';
import type { Track } from '@crate/shared';

const ART_BASE = '/art';

/** Sum track durations (seconds) for duration-scaled spine widths; null when no
    track reports a duration (so the UI can fall back to a uniform width). */
function sumDuration(tracks: Track[]): number | null {
  let total = 0;
  let any = false;
  for (const t of tracks) {
    if (t.duration && t.duration > 0) {
      total += t.duration;
      any = true;
    }
  }
  return any ? Math.round(total) : null;
}

export class Service {
  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly ma: MusicAssistantProvider,
    private readonly hub: Hub,
  ) {}

  async init(): Promise<void> {
    // Restore the panel to the last-set brightness (no-op under 'software').
    void applyBrightness(this.db.getRaw<number>('system.brightness', 100));
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
      items: this.db.listShelf().map((r) => buildShelfItem(r, ART_BASE, this.cfg.artDir)),
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
    // Album runtime for duration-scaled spine widths (best-effort; keep any
    // previously-computed value if the track fetch fails).
    const tracks = await this.ma.getTracks(providerUri).catch((): Track[] => []);
    const totalDuration = sumDuration(tracks) ?? existing?.total_duration ?? null;
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
      spine_scan_path: existing?.spine_scan_path ?? null,
      spine_width: existing?.spine_width ?? spineWidthFor(id),
      total_duration: totalDuration,
      added_at: existing?.added_at ?? new Date().toISOString(),
      play_count: existing?.play_count ?? 0,
      overrides: existing?.overrides ?? null,
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
    // Real spine scan (best-effort, slow: MusicBrainz is rate-limited) — after
    // the fast artwork so the spine appears immediately, upgraded if a scan lands.
    void this.processSpineScan(id);
  }

  private async processSpineScan(id: string): Promise<void> {
    const row = this.db.getAlbum(id);
    if (!row) return;
    try {
      const urls = await findSpineScans(row.artist, row.title, row.year, this.cfg.mbUserAgent);
      if (urls.length === 0) return;
      const name = await buildSpineScan(id, urls, { artDir: this.cfg.artDir, userAgent: this.cfg.mbUserAgent });
      if (name) {
        this.db.setSpineScan(id, name);
        this.hub.broadcast({ type: 'shelf' });
      }
    } catch (err) {
      process.stderr.write(`[crate] spine scan failed for ${id}: ${(err as Error).message}\n`);
    }
  }

  /** Re-run the artwork + spine-scan pipeline for every shelved album (admin refresh). */
  async refreshArtwork(): Promise<void> {
    for (const row of this.db.listShelf()) {
      if (row.artwork_url) await this.processArtwork(row.id, row.artwork_url);
      else void this.processSpineScan(row.id);
      // Backfill album runtime for shelves added before duration was tracked.
      if (row.total_duration == null) {
        const tracks = await this.ma.getTracks(row.provider_uri).catch((): Track[] => []);
        const dur = sumDuration(tracks);
        if (dur != null) {
          this.db.setDuration(row.id, dur);
          this.hub.broadcast({ type: 'shelf' });
        }
      }
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
    return { album: rowToAlbum(row), tracks, override: this.db.getOverride(id) };
  }

  async uploadArt(id: string, kind: 'spine' | 'cover', buf: Buffer): Promise<void> {
    const name = await processUploadedArt(id, kind, buf, {
      artDir: this.cfg.artDir,
      coverHeightPx: this.cfg.coverHeightPx,
    });
    this.db.setOverride(id, kind === 'spine' ? { spinePath: name } : { coverPath: name });
    this.hub.broadcast({ type: 'shelf' });
  }

  setOverride(id: string, patch: Partial<AlbumOverride>): AlbumOverride {
    const next = this.db.setOverride(id, patch);
    this.hub.broadcast({ type: 'shelf' });
    return next;
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
    // Exact membership: everything not in the requested set is removed from the
    // leader's group, so the control-center chips do both join and leave.
    const all = this.db.listPlayers().map((p) => p.id);
    const remove = all.filter((id) => id !== leader && !members.includes(id));
    return this.ma.setMembers(leader, members, remove);
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

  // --- System / appliance (control center §6) -----------------------------

  systemStatus(): SystemStatus {
    return {
      brightness: this.db.getRaw<number>('system.brightness', 100),
      brightnessMethod: detectBrightnessMethod(),
      displayAsleep: this.db.getRaw<boolean>('system.displayAsleep', false),
      ip: getLocalIp(),
      appliance: this.cfg.appliance,
      version: this.cfg.version,
    };
  }

  async setBrightness(level: number): Promise<SystemStatus> {
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    this.db.setRaw('system.brightness', pct);
    await applyBrightness(pct);
    const status = this.systemStatus();
    this.hub.broadcast({ type: 'system', status });
    return status;
  }

  async setDisplaySleep(asleep: boolean): Promise<SystemStatus> {
    this.db.setRaw('system.displayAsleep', asleep);
    await setDisplayPower(!asleep);
    const status = this.systemStatus();
    this.hub.broadcast({ type: 'system', status });
    return status;
  }

  /** Restart the app process. Only on the appliance, where systemd relaunches
      it (Restart=always); a no-op elsewhere so dev previews aren't killed. */
  restart(): { ok: boolean } {
    if (!this.cfg.appliance) return { ok: false };
    setTimeout(() => process.exit(0), 150);
    return { ok: true };
  }

  async reboot(): Promise<{ ok: boolean }> {
    if (!this.cfg.appliance) return { ok: false };
    await rebootSystem().catch(() => {});
    return { ok: true };
  }
}
