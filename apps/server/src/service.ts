import type {
  AlbumDetail,
  GlobalSearchResponse,
  LibraryAlbum,
  LibraryAlbumsResponse,
  LibraryImportResult,
  LibraryPlaylist,
  MusicSourceInfo,
  NowPlaying,
  SearchSong,
  PlayerState,
  PlayersResponse,
  ProviderAlbumDetail,
  SearchAlbum,
  Settings,
  Shelf,
  ShelfItem,
  ShelfKind,
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
import { albumIdFromUri, artUrl, buildShelfItem, songShelfItem, spineWidthFor } from './shelf.js';
import { applyBrightness, detectBrightnessMethod, getLocalIp, rebootSystem, setDisplayPower } from './system.js';
import type { Track } from '@crate/shared';

const ART_BASE = '/art';

/** Run an async fn over items with bounded concurrency (keeps track enrichment
    from firing hundreds of simultaneous MA commands). */
async function runLimited<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < items.length) {
      const cur = items[idx++] as T;
      await fn(cur);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

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
      void this.pushState();
    });
    // Reflect speaker renames / added / removed within ~1s (not just on reconnect).
    this.ma.onPlayersChanged(() => void this.refreshPlayers());
    this.ma.onState((states) => {
      this.hub.broadcast({ type: 'state', state: this.resolveStates(states) });
    });
    this.ma.onProgress((playerId, elapsed) => {
      this.hub.broadcast({ type: 'progress', playerId, elapsed });
    });
    try {
      await this.ma.start();
      await this.refreshPlayers();
      await this.pushState();
    } catch (err) {
      process.stderr.write(`[crate] MA not reachable yet, will retry: ${(err as Error).message}\n`);
    }
  }

  private lastRoster = '';

  /** Sync the player roster (id/name/type/availability). Only broadcasts when it
      actually changed, so frequent `player_updated` events (volume, etc.) don't churn. */
  private async refreshPlayers(): Promise<void> {
    try {
      const players = await this.ma.listPlayers();
      const sig = players.map((p) => `${p.id}|${p.name}|${p.type}|${p.available ? 1 : 0}`).join(';');
      if (sig === this.lastRoster) return;
      this.lastRoster = sig;
      this.db.upsertPlayers(players.map((p) => ({ id: p.id, name: p.name, type: p.type, available: p.available })));
      this.hub.broadcast({ type: 'players' });
    } catch {
      /* transient */
    }
  }

  private async pushState(): Promise<void> {
    try {
      this.hub.broadcast({ type: 'state', state: this.resolveStates(await this.ma.getState()) });
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

  async getShelf(shelfId?: string): Promise<ShelfResponse> {
    const shelves = this.db.listShelves();
    const shelf = shelfId ? shelves.find((s) => s.id === shelfId) : undefined;
    // A named playlist shelf holds ONE playlist, shown as its songs (spines).
    if (shelf && shelf.kind === 'playlist' && shelf.id !== 'playlists') {
      return { items: await this.songItems(shelf.id), stacks: this.db.listStacks(), shelves };
    }
    const rows =
      !shelfId || shelfId === 'all'
        ? this.db.listShelf('album')
        : shelfId === 'playlists'
          ? this.db.listShelf('playlist')
          : this.db.listShelfMembers(shelfId);
    return {
      items: rows.map((r) => buildShelfItem(r, ART_BASE, this.cfg.artDir)),
      stacks: this.db.listStacks(),
      shelves,
    };
  }

  private readonly enriching = new Set<string>(); // track uris currently being resolved

  /** The songs of a single-playlist shelf, as spines (song→album via albumUri).
      Returns immediately from the cache; un-enriched tracks resolve in the
      background (get_track is per-track and serial through MA) and stream in via
      `shelf` broadcasts — so the shelf shows instantly and fills with art+artist. */
  private async songItems(shelfId: string): Promise<ShelfItem[]> {
    const playlist = this.db.listShelfMembers(shelfId)[0]; // holds exactly one playlist
    if (!playlist) return [];
    const live = await this.ma.getTracks(playlist.provider_uri).catch((): Track[] => []);
    // Layer Crate-local curation over the live playlist: hide removed songs, and apply a custom
    // order (stored songs first by their order; anything new stays in provider order after).
    const state = this.db.playlistSongState(shelfId);
    const kept = live.filter((t) => !(t.uri && state.get(t.uri)?.hidden));
    const tracks = kept
      .map((t, i) => ({ t, key: t.uri ? (state.get(t.uri)?.order ?? null) : null, i }))
      .sort((a, b) => {
        if (a.key != null && b.key != null) return a.key - b.key;
        if (a.key != null) return -1;
        if (b.key != null) return 1;
        return a.i - b.i;
      })
      .map((x) => x.t);
    const misses = tracks.filter((t) => t.uri && !this.db.getSongCache(t.uri));
    if (misses.length) void this.enrichSongsInBackground(misses);
    return tracks.map((t, i) => {
      const c = t.uri ? this.db.getSongCache(t.uri) : undefined;
      return songShelfItem(t, i, playlist.id, c ? { artist: c.artist, artworkUrl: c.artwork_url } : undefined);
    });
  }

  /** Set a Crate-local custom song order for a playlist shelf (never edits the source playlist). */
  reorderPlaylistSongs(shelfId: string, trackUris: string[]): void {
    this.db.setPlaylistSongOrder(shelfId, trackUris);
    this.hub.broadcast({ type: 'shelf' });
  }

  /** Hide (Crate-local) or restore one song within a playlist shelf. */
  setPlaylistSongHidden(shelfId: string, trackUri: string, hidden: boolean): void {
    this.db.setPlaylistSongHidden(shelfId, trackUri, hidden);
    this.hub.broadcast({ type: 'shelf' });
  }

  private async enrichSongsInBackground(misses: Track[]): Promise<void> {
    const todo = misses.filter((t) => t.uri && !this.enriching.has(t.uri));
    if (!todo.length) return;
    todo.forEach((t) => this.enriching.add(t.uri as string));
    let done = 0;
    await runLimited(todo, 6, async (t) => {
      const uri = t.uri as string;
      const e = await this.ma.enrichTrack(uri).catch(() => null);
      if (e) {
        this.db.upsertSongCache({
          track_uri: uri,
          artist: e.artist,
          album_uri: e.albumUri,
          artwork_url: e.artworkUrl,
          album_index: e.albumIndex,
        });
      }
      this.enriching.delete(uri);
      if (++done % 12 === 0) this.hub.broadcast({ type: 'shelf' }); // stream progress in
    });
    this.hub.broadcast({ type: 'shelf' });
  }

  /** Album detail for an off-shelf provider album (song→album card). Not ingested.
      A track uri is first resolved to its real album (+ the track's album position). */
  async providerAlbum(uri: string): Promise<ProviderAlbumDetail | null> {
    let albumUri = uri;
    let cueIndex = -1;
    if (uri.includes('://track/')) {
      // Fast path: a song shelf already resolved this track's album into the cache.
      const cached = this.db.getSongCache(uri);
      if (cached?.album_uri) {
        albumUri = cached.album_uri;
        cueIndex = cached.album_index ?? -1;
      } else {
        const res = await this.ma.getTrackAlbum(uri).catch(() => null);
        if (!res) return null;
        albumUri = res.albumUri;
        cueIndex = res.trackIndex;
      }
    }
    const [album, tracks] = await Promise.all([
      this.ma.getAlbum(albumUri),
      this.ma.getTracks(albumUri).catch((): Track[] => []),
    ]);
    if (!album) return null;
    const onShelf = this.db.isOnShelf(albumIdFromUri(albumUri));
    return { providerUri: albumUri, title: album.title, artist: album.artist, artworkUrl: album.artworkUrl, tracks, cueIndex, onShelf };
  }

  /** A playlist's tracks (for the play-now overlay). */
  async providerPlaylistTracks(uri: string): Promise<Track[]> {
    return this.ma.getTracks(uri).catch((): Track[] => []);
  }

  // --- Shelves (named curated collections) --------------------------------

  createShelf(name: string, kind: ShelfKind = 'album'): Shelf {
    const base = name.trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'shelf';
    const id = `sh-${base}-${this.db.listShelves().length}`;
    const shelf = this.db.createShelf(id, name.trim() || 'New shelf', kind);
    this.hub.broadcast({ type: 'shelves' });
    return shelf;
  }
  renameShelf(id: string, name: string): void {
    this.db.renameShelf(id, name);
    this.hub.broadcast({ type: 'shelves' });
  }
  deleteShelf(id: string): void {
    this.db.deleteShelf(id);
    this.hub.broadcast({ type: 'shelves' });
  }
  addAlbumToShelf(shelfId: string, albumId: string): void {
    this.db.addAlbumToShelf(shelfId, albumId);
    this.hub.broadcast({ type: 'shelves' });
  }
  removeAlbumFromShelf(shelfId: string, albumId: string): void {
    this.db.removeAlbumFromShelf(shelfId, albumId);
    this.hub.broadcast({ type: 'shelves' });
  }
  albumShelfIds(albumId: string): string[] {
    return this.db.shelvesForAlbum(albumId);
  }

  async search(query: string, source?: string): Promise<SearchAlbum[]> {
    const all = await this.ma.listMusicProviders().catch(() => []);
    const sources = source && source !== 'all' ? all.filter((s) => s.instanceId === source) : all;
    const toHit = (a: { providerUri: string; provider: string; title: string; artist: string; year: number | null; artworkUrl: string | null }, source: string): SearchAlbum => {
      const row = this.shelvedRow(a.providerUri, a.title, a.artist);
      return {
        providerUri: a.providerUri,
        provider: a.provider,
        title: a.title,
        artist: a.artist,
        year: a.year,
        artworkUrl: this.cachedCoverFromRow(row) ?? a.artworkUrl,
        onShelf: !!row,
        albumId: row?.id ?? null,
        source,
      };
    };
    // No known sources → one unscoped search. Otherwise search each streaming
    // source so results can be grouped/labelled by source (e.g. two Apple accounts).
    if (sources.length === 0) {
      return (await this.ma.search(query)).map((a) => toHit(a, 'Music'));
    }
    const perSource = await Promise.all(
      sources.map(async (s) => (await this.ma.search(query, 20, s.instanceId).catch(() => [])).map((a) => toHit(a, s.name))),
    );
    return perSource.flat();
  }

  /** Sonos-style global search: albums, playlists and songs across the connected
      sources (or one, when `source` is a specific instance id). */
  async globalSearch(query: string, source?: string, limit = 20): Promise<GlobalSearchResponse> {
    const sources = await this.ma.listMusicProviders().catch(() => []);
    const shelved = this.db.shelfedUris();
    const targets = source && source !== 'all' ? sources.filter((s) => s.instanceId === source) : sources;
    const searchIn = targets.length ? targets : [{ instanceId: '', name: 'Music' }];
    const results = await Promise.all(
      searchIn.map(async (s) => ({
        s,
        r: await this.ma.searchAll(query, limit, s.instanceId || undefined).catch(() => ({ albums: [], playlists: [], tracks: [] })),
      })),
    );
    const albums: SearchAlbum[] = [];
    const playlists: LibraryPlaylist[] = [];
    const songs: SearchSong[] = [];
    for (const { s, r } of results) {
      for (const a of r.albums)
        albums.push({ providerUri: a.providerUri, provider: a.provider, title: a.title, artist: a.artist, year: a.year, artworkUrl: a.artworkUrl, onShelf: shelved.has(a.providerUri), albumId: null, source: s.name });
      for (const p of r.playlists)
        playlists.push({ providerUri: p.providerUri, provider: p.provider, name: p.name, owner: p.owner, artworkUrl: p.artworkUrl, onShelf: shelved.has(p.providerUri), source: s.name });
      for (const t of r.tracks)
        songs.push({ trackUri: t.trackUri, title: t.title, artist: t.artist, album: t.album, artworkUrl: t.artworkUrl, source: s.name });
    }
    return { albums, playlists, songs, sources };
  }

  async addToShelf(providerUri: string, shelfId?: string, opts?: { quiet?: boolean }): Promise<{ albumId: string; duplicate: boolean }> {
    const album = await this.ma.getAlbum(providerUri);
    if (!album) throw new Error(`album not found: ${providerUri}`);
    const id = albumIdFromUri(providerUri);
    // Dedupe: if another release of the same album is already in the library, use it
    // instead of adding a second copy (Apple Music often has multiple editions).
    const dup = this.db.findLibraryAlbumByTitleArtist(album.title, album.artist);
    if (dup && dup.id !== id) {
      if (shelfId && shelfId !== 'all') this.db.addAlbumToShelf(shelfId, dup.id);
      if (!opts?.quiet) this.hub.broadcast({ type: 'shelf' });
      return { albumId: dup.id, duplicate: true };
    }
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
    // Optionally also drop it on a specific named shelf (besides the library).
    if (shelfId && shelfId !== 'all') this.db.addAlbumToShelf(shelfId, id);
    if (!opts?.quiet) this.hub.broadcast({ type: 'shelf' });

    // Build artwork + palette in the background, then push the updated spine.
    if (album.artworkUrl) {
      void this.processArtwork(id, album.artworkUrl);
    }
    return { albumId: id, duplicate: false };
  }

  // --- Playlists ----------------------------------------------------------

  /** The user's provider-library playlists, marked with whether they're added. */
  async listLibraryPlaylists(): Promise<LibraryPlaylist[]> {
    const [playlists, shelved] = [await this.ma.listLibraryPlaylists(), this.db.shelfedUris()];
    return playlists.map((p) => ({
      providerUri: p.providerUri,
      provider: p.provider,
      name: p.name,
      owner: p.owner,
      artworkUrl: p.artworkUrl,
      onShelf: shelved.has(p.providerUri),
    }));
  }

  /** Search playlists (your library + provider-curated, e.g. Apple Music editorial). */
  async searchPlaylists(query: string): Promise<LibraryPlaylist[]> {
    const [pls, shelved] = [await this.ma.searchPlaylists(query), this.db.shelfedUris()];
    return pls.map((p) => ({
      providerUri: p.providerUri,
      provider: p.provider,
      name: p.name,
      owner: p.owner,
      artworkUrl: p.artworkUrl,
      onShelf: shelved.has(p.providerUri),
    }));
  }

  // --- Library import (albums) --------------------------------------------

  /** Connected streaming music sources (Apple Music accounts, later Spotify, …). */
  async listSources(): Promise<MusicSourceInfo[]> {
    return this.ma.listMusicProviders().catch(() => []);
  }

  /** True if this provider album is already represented on a shelf — either by its own
      uri, or (across Apple's library-vs-catalog ids) by a same title+artist release. */
  private albumOnShelf(providerUri: string, title: string, artist: string, shelved: Set<string>): boolean {
    return shelved.has(providerUri) || !!this.db.findLibraryAlbumByTitleArtist(title, artist);
  }

  /** The album Crate holds *on a shelf* for this provider album — matched by its own uri, or
      (across Apple's library-vs-catalog ids) by a same title+artist release. Returns null when
      nothing is actually shelved, so a removed album's leftover row doesn't read as on-shelf. */
  private shelvedRow(providerUri: string, title: string, artist: string): AlbumRow | null {
    const byId = this.db.getAlbum(albumIdFromUri(providerUri));
    if (byId && this.db.isOnShelf(byId.id)) return byId;
    return this.db.findLibraryAlbumByTitleArtist(title, artist); // JOINs shelf_items → shelved only
  }

  /** The shelf's own cached cover for an album row — the same file the wall serves (same-origin,
      reliable, no expiring provider URLs). Null when no local rendition exists yet. */
  private cachedCoverFromRow(row: AlbumRow | null): string | null {
    if (!row) return null;
    let file: string | null = row.artwork_path;
    if (row.overrides) {
      try {
        const ov = JSON.parse(row.overrides) as { coverPath?: string | null };
        if (ov.coverPath) file = ov.coverPath;
      } catch {
        /* ignore bad override json */
      }
    }
    return file ? artUrl(ART_BASE, this.cfg.artDir, file) : null;
  }

  /** A page of the user's library albums, marked with whether each is already shelved. */
  async listLibraryAlbums(opts: {
    source?: string;
    search?: string;
    favorite?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<LibraryAlbumsResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const [sources, raw] = await Promise.all([
      this.ma.listMusicProviders().catch((): MusicSourceInfo[] => []),
      this.ma.listLibraryAlbums({ source: opts.source, search: opts.search, favorite: opts.favorite, limit, offset }),
    ]);
    const nameById = new Map(sources.map((s) => [s.instanceId, s.name]));
    const items: LibraryAlbum[] = raw.map((a) => {
      const row = this.shelvedRow(a.providerUri, a.title, a.artist);
      return {
        providerUri: a.providerUri,
        title: a.title,
        artist: a.artist,
        year: a.year,
        artworkUrl: this.cachedCoverFromRow(row) ?? a.artworkUrl,
        onShelf: !!row,
        albumId: row?.id ?? null,
        source: (a.sourceInstanceId ? nameById.get(a.sourceInstanceId) : undefined) ?? 'Library',
        sourceInstanceId: a.sourceInstanceId,
      };
    });
    return { items, offset, hasMore: raw.length >= limit, sources };
  }

  /** Bulk-add every album in the library (optionally one source) that isn't shelved yet.
      One shelf broadcast at the end, not per album. */
  async importLibrary(source?: string): Promise<LibraryImportResult> {
    const PAGE = 100;
    const MAX = 5000; // safety cap for very large libraries
    let offset = 0;
    let added = 0;
    let skipped = 0;
    let total = 0;
    for (;;) {
      const page = await this.ma.listLibraryAlbums({ source, limit: PAGE, offset });
      if (!page.length) break;
      for (const a of page) {
        total++;
        if (this.albumOnShelf(a.providerUri, a.title, a.artist, this.db.shelfedUris())) {
          skipped++;
          continue;
        }
        try {
          await this.addToShelf(a.providerUri, undefined, { quiet: true });
          added++;
        } catch {
          skipped++;
        }
      }
      offset += page.length;
      if (page.length < PAGE || offset >= MAX) break;
    }
    if (added > 0) this.hub.broadcast({ type: 'shelf' });
    return { added, skipped, total };
  }

  /** Kick off track enrichment (artist + album art) for a playlist before its
      song shelf is opened, so covers are already resolving by the time you switch. */
  async prewarmPlaylist(providerUri: string): Promise<void> {
    const tracks = await this.ma.getTracks(providerUri).catch((): Track[] => []);
    const misses = tracks.filter((t) => t.uri && !this.db.getSongCache(t.uri));
    if (misses.length) void this.enrichSongsInBackground(misses);
  }

  /** Ingest a playlist as a `kind='playlist'` media row (reuses the album store
      and artwork pipeline; its "tracks" are the playlist's songs). */
  async addPlaylist(providerUri: string): Promise<void> {
    const pl = await this.ma.getPlaylist(providerUri);
    if (!pl) throw new Error(`playlist not found: ${providerUri}`);
    const id = albumIdFromUri(providerUri);
    const existing = this.db.getAlbum(id);
    const row: AlbumRow = {
      id,
      provider_uri: providerUri,
      provider: pl.provider,
      title: pl.name,
      artist: pl.owner ?? 'Playlist',
      year: null,
      artwork_url: pl.artworkUrl,
      artwork_path: existing?.artwork_path ?? null,
      palette: existing?.palette ?? null,
      spine_strip_path: existing?.spine_strip_path ?? null,
      spine_scan_path: existing?.spine_scan_path ?? null,
      spine_width: existing?.spine_width ?? spineWidthFor(id),
      total_duration: null, // playlists use a uniform spine width, not runtime
      added_at: existing?.added_at ?? new Date().toISOString(),
      play_count: existing?.play_count ?? 0,
      overrides: existing?.overrides ?? null,
    };
    this.db.upsertAlbum(row);
    this.db.addToShelf(id, 'playlist');
    this.hub.broadcast({ type: 'shelf' });
    // Palette + blurred strip from the cover; no MusicBrainz spine scan (a
    // playlist has no single artist/title to look up).
    if (pl.artworkUrl) {
      void this.processArtwork(id, pl.artworkUrl, { scan: false });
    }
  }

  private async processArtwork(id: string, url: string, opts: { scan?: boolean } = {}): Promise<void> {
    try {
      const art = await buildArtwork(id, url, { artDir: this.cfg.artDir, coverHeightPx: this.cfg.coverHeightPx });
      this.db.updateArtwork(id, art.artworkPath, art.spineStripPath, art.palette);
      this.hub.broadcast({ type: 'shelf' });
    } catch (err) {
      process.stderr.write(`[crate] artwork failed for ${id}: ${(err as Error).message}\n`);
    }
    // Real spine scan (best-effort, slow: MusicBrainz is rate-limited) — after
    // the fast artwork so the spine appears immediately, upgraded if a scan lands.
    if (opts.scan !== false) void this.processSpineScan(id);
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

  /** Manually order albums: the library (no shelfId) or a specific crate. */
  reorder(albumIds: string[], shelfId?: string): void {
    // 'all' (albums) and 'playlists' are both virtual views over shelf_items; named shelves
    // reorder their members.
    if (shelfId && shelfId !== 'all' && shelfId !== 'playlists') this.db.reorderShelfMembers(shelfId, albumIds);
    else this.db.reorderShelfItems(albumIds);
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

  async play(albumId: string, trackIndex?: number, playerId?: string, providerUri?: string): Promise<void> {
    const player = playerId ?? this.defaultPlayerId();
    if (!player) throw new Error('no player available');
    // Off-shelf album (e.g. a song tapped in a playlist's song view) — play by uri.
    if (providerUri) {
      await this.ma.play(player, providerUri, trackIndex !== undefined ? { trackIndex } : undefined);
      return;
    }
    const row = this.db.getAlbum(albumId);
    if (!row) throw new Error(`unknown album: ${albumId}`);
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
