import { createHash } from 'node:crypto';
import { BACKUP_VERSION } from '@crate/shared';
import type {
  AlbumDetail,
  BackupHistoryEntry,
  BackupImportResult,
  BackupInterval,
  BackupRunResult,
  BackupStatus,
  CrateBackup,
  GithubBackupConfig,
  GlobalSearchResponse,
  LibraryAlbum,
  LibraryAlbumsResponse,
  LibraryImportResult,
  LibraryPlaylist,
  MaConfigEntry,
  MaConfigValue,
  MaConnection,
  MaProviderManifest,
  MaSource,
  MaStatus,
  MusicSourceInfo,
  NowPlaying,
  SearchSong,
  PlayerState,
  PlayersResponse,
  ProviderAlbumDetail,
  RadioSearchResponse,
  RadioStation,
  RadioSyncResult,
  RepeatMode,
  SearchAlbum,
  SearchArtist,
  Settings,
  ServicesStatus,
  Shelf,
  ShelfItem,
  ShelfKind,
  ShelfResponse,
  SystemStatus,
  TransportCmd,
  UpdateProgress,
  UpdateStatus,
  UpdateTarget,
} from '@crate/shared';
import { MusicAssistantProvider, maSetupState, mintMaToken, parseProviderUri, setupMaAccount } from '@crate/providers';
import type { ProviderAlbum, ProviderLibraryAlbum, ProviderRadio, ProviderTrackHit } from '@crate/providers';
import type { AlbumOverride } from '@crate/shared';
import { buildArtwork, buildSpineScan, processUploadedArt } from './artwork.js';
import { findSpineScans } from './musicbrainz.js';
import type { Config } from './config.js';
import type { AlbumRow, Db } from './db.js';
import { rowToAlbum, titleArtistKey } from './db.js';
import type { Hub } from './hub.js';
import { albumIdFromUri, artUrl, buildShelfItem, invalidateArtCache, songShelfItem, spineWidthFor } from './shelf.js';
import { applyBrightness, checkForUpdate, detectBrightnessMethod, getLocalIp, latestMaRelease, rebootSystem, setDisplayPower, spawnUpdate, updateProgress } from './system.js';
import { githubCheck, githubGet, githubListRepos, githubPush, type GithubTarget } from './github.js';
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
  // Not readonly: onboarding / MA settings can swap the connection, which recreates the provider.
  private ma: MusicAssistantProvider;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly hub: Hub,
  ) {
    this.ma = new MusicAssistantProvider(this.maOpts());
  }

  /** MA connection options — a DB override (set via onboarding / MA settings) wins over env. */
  private maOpts() {
    return {
      url: this.db.getRaw<string>('ma.url', this.cfg.maUrl),
      token: this.db.getRaw<string>('ma.token', this.cfg.maToken),
      log: (level: 'info' | 'warn' | 'error', msg: string) => process.stderr.write(`[ma:${level}] ${msg}\n`),
    };
  }

  /** (Re)wire the live MA event handlers to the hub. Call after (re)creating the provider. */
  // MA state plumbing. resolveCache: now-playing→album-id lookup, rebuilt at most every 5s (the link
  // is cosmetic — it highlights the playing album — so brief staleness after an add is fine).
  // progressAt: last progress push per player, so we throttle the ~1/sec ticks the client interpolates.
  private resolveCache: { at: number; byUri: Map<string, string>; byTitle: Map<string, string> } | null = null;
  private readonly progressAt = new Map<string, number>();

  private wireMa(): void {
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
      // The client interpolates elapsed locally between ticks, so a periodic correction is
      // enough — throttle to one push per player every few seconds instead of ~1/sec.
      const now = Date.now();
      if (now - (this.progressAt.get(playerId) ?? 0) < 4000) return;
      this.progressAt.set(playerId, now);
      this.hub.broadcast({ type: 'progress', playerId, elapsed });
    });
  }

  async init(): Promise<void> {
    // Restore the panel to the last-set brightness (no-op under 'software').
    void applyBrightness(this.db.getRaw<number>('system.brightness', 100));
    this.wireMa();
    try {
      await this.ma.start();
      await this.refreshPlayers();
      await this.pushState();
    } catch (err) {
      process.stderr.write(`[crate] MA not reachable yet, will retry: ${(err as Error).message}\n`);
    }
  }

  // --- MA connection (Phase 5 onboarding): editable URL + token, stored in the DB ---------

  getMaConnection(): MaConnection {
    return {
      url: this.db.getRaw<string>('ma.url', this.cfg.maUrl),
      hasToken: !!this.db.getRaw<string>('ma.token', this.cfg.maToken),
      connected: this.ma.connected,
      serverVersion: this.ma.serverVersion ?? null,
    };
  }

  /** Point Crate at a (new) MA URL/token and reconnect by recreating the provider. The token is
      write-only: only replaced when a non-empty value is supplied. */
  async setMaConnection(input: { url?: string; token?: string }): Promise<MaConnection> {
    if (typeof input.url === 'string' && input.url.trim()) {
      this.db.setRaw('ma.url', input.url.trim().replace(/\/+$/, ''));
    }
    if (typeof input.token === 'string' && input.token.trim()) {
      this.db.setRaw('ma.token', input.token.trim());
    }
    this.ma.close();
    this.ma = new MusicAssistantProvider(this.maOpts());
    this.wireMa();
    try {
      await this.ma.start();
      await this.refreshPlayers();
      await this.pushState();
    } catch {
      /* not reachable — getMaConnection() reflects connected:false */
    }
    return this.getMaConnection();
  }

  /** First-run onboarding flag. */
  getOnboarding(): { done: boolean } {
    return { done: this.db.getRaw<boolean>('onboarding.done', false) };
  }
  completeOnboarding(): { done: boolean } {
    this.db.setRaw('onboarding.done', true);
    return { done: true };
  }

  /** Reachability + first-run state of the (co-hosted) MA — the wizard polls this until it's up. */
  maSetupState(url?: string): Promise<{ reachable: boolean; needsSetup: boolean }> {
    const u = (url?.trim() || this.db.getRaw<string>('ma.url', this.cfg.maUrl)).replace(/\/+$/, '');
    return maSetupState(u);
  }

  /** Co-hosted onboarding: create the first MA admin account if the instance is fresh, then mint a
      long-lived token from those credentials and connect — no Music Assistant UI needed. */
  async mintMaConnection(input: { url?: string; username?: string; password?: string }): Promise<MaConnection> {
    const url = (input.url?.trim() || this.db.getRaw<string>('ma.url', this.cfg.maUrl)).replace(/\/+$/, '');
    const username = input.username?.trim();
    if (!username || !input.password) {
      throw new Error('Enter a Music Assistant username and password.');
    }
    if ((await maSetupState(url)).needsSetup) {
      await setupMaAccount(url, username, input.password);
    }
    const token = await mintMaToken(url, username, input.password);
    return this.setMaConnection({ url, token });
  }

  /** Verify a URL+token (falling back to the stored ones) without touching the live connection. */
  async testMaConnection(input: { url?: string; token?: string }): Promise<{ ok: boolean; serverVersion: string | null }> {
    const url = (input.url?.trim() || this.db.getRaw<string>('ma.url', this.cfg.maUrl)).replace(/\/+$/, '');
    const token = input.token?.trim() || this.db.getRaw<string>('ma.token', this.cfg.maToken);
    const probe = new MusicAssistantProvider({ url, token, log: () => {} });
    try {
      const info = await probe.start();
      return { ok: true, serverVersion: info.server_version ?? null };
    } finally {
      probe.close();
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
    const now = Date.now();
    if (!this.resolveCache || now - this.resolveCache.at >= 5000) {
      const shelf = this.db.listShelf();
      this.resolveCache = {
        at: now,
        byUri: new Map(shelf.map((r) => [r.provider_uri, r.id])),
        byTitle: new Map(shelf.map((r) => [r.title.toLowerCase(), r.id])),
      };
    }
    const { byUri, byTitle } = this.resolveCache;
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
          : shelfId === 'radio'
            ? this.db.listShelf('radio')
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

  async search(query: string, _source?: string): Promise<SearchAlbum[]> {
    // One aggregated search (MA spans every provider — per-source scoping is a no-op); each hit
    // is attributed to its real source domain. The `source` arg is ignored; the client filters.
    const providers = await this.ma.listMusicProviders().catch((): Array<{ instanceId: string; name: string; domain: string; iconSvg: string | null }> => []);
    const byDomain = new Map<string, string>();
    for (const s of providers) if (s.domain && !byDomain.has(s.domain)) byDomain.set(s.domain, s.name);
    const nameOf = (d?: string | null): string => (d && byDomain.get(d)) || 'Music';
    const raw = await this.ma.search(query).catch((): ProviderAlbum[] => []);
    return raw.map((a) => {
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
        version: a.version,
        explicit: a.explicit,
        inLibrary: a.inLibrary,
        source: nameOf(a.provider),
      };
    });
  }

  /** Sonos-style global search: albums, playlists, songs, and artists in one aggregated pass.
      MA already searches every connected provider (per-provider scoping is a no-op there), so
      each hit is attributed to its real source and the UI badges + filters on that. The `source`
      argument is accepted for back-compat but ignored — the client filters the returned hits. */
  async globalSearch(query: string, _source?: string, limit = 20): Promise<GlobalSearchResponse> {
    const providers = await this.ma
      .listMusicProviders()
      .catch((): Array<{ instanceId: string; name: string; domain: string; iconSvg: string | null }> => []);
    const byDomain = new Map<string, { name: string; iconSvg: string | null }>();
    for (const s of providers) if (s.domain && !byDomain.has(s.domain)) byDomain.set(s.domain, { name: s.name, iconSvg: s.iconSvg });
    const byInstance = new Map(providers.map((s) => [s.instanceId, s.name] as const));
    const used = new Set<string>(); // source names actually present in the results
    const srcOfDomain = (d?: string | null): string => {
      const n = (d && byDomain.get(d)?.name) || 'Library';
      used.add(n);
      return n;
    };
    const srcOfInstance = (iid?: string | null): string => {
      const n = (iid && byInstance.get(iid)) || 'Library';
      used.add(n);
      return n;
    };
    const shelved = this.db.shelfedUris();
    // One aggregated catalog search + the saved library in parallel (MA's catalog hits never
    // carry the library flag, so the "in your library" tier comes from a dedicated query).
    const [r, libRaw] = await Promise.all([
      this.ma.searchAll(query, limit).catch(() => ({ artists: [], albums: [], playlists: [], tracks: [] })),
      this.ma.listLibraryAlbums({ search: query, limit, offset: 0 }).catch((): ProviderLibraryAlbum[] => []),
    ]);
    const key = (artist: string, title: string): string => `${artist}|${title}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
    const albums: SearchAlbum[] = [];
    // Library albums first (marked in-library); their keys suppress duplicate catalog hits.
    const libKeys = new Set<string>();
    for (const a of libRaw) {
      libKeys.add(key(a.artist, a.title));
      const row = this.shelvedRow(a.providerUri, a.title, a.artist);
      albums.push({ providerUri: a.providerUri, provider: a.provider, title: a.title, artist: a.artist, year: a.year, artworkUrl: this.cachedCoverFromRow(row) ?? a.artworkUrl, onShelf: !!row, albumId: row?.id ?? null, version: a.version, explicit: a.explicit, inLibrary: true, source: srcOfInstance(a.sourceInstanceId) });
    }
    const playlists: LibraryPlaylist[] = [];
    const songs: SearchSong[] = [];
    const artists: SearchArtist[] = [];
    const artistNames = new Set<string>();
    for (const a of r.artists) {
      const nk = a.name.toLowerCase();
      if (artistNames.has(nk)) continue; // one card per artist
      artistNames.add(nk);
      artists.push({ providerUri: a.providerUri, provider: a.provider, name: a.name, artworkUrl: a.artworkUrl, source: srcOfDomain(a.provider) });
    }
    for (const a of r.albums) {
      if (libKeys.has(key(a.artist, a.title))) continue; // already shown under "in your library"
      // Match the shelf by album id OR title+artist (not just the exact catalog uri) so a
      // shelved album added under a different uri/edition is still recognized as on-shelf.
      const row = this.shelvedRow(a.providerUri, a.title, a.artist);
      albums.push({ providerUri: a.providerUri, provider: a.provider, title: a.title, artist: a.artist, year: a.year, artworkUrl: this.cachedCoverFromRow(row) ?? a.artworkUrl, onShelf: !!row, albumId: row?.id ?? null, version: a.version, explicit: a.explicit, inLibrary: a.inLibrary, source: srcOfDomain(a.provider) });
    }
    for (const p of r.playlists)
      playlists.push({ providerUri: p.providerUri, provider: p.provider, name: p.name, owner: p.owner, artworkUrl: p.artworkUrl, onShelf: shelved.has(p.providerUri), source: srcOfDomain(p.provider) });
    for (const t of r.tracks)
      songs.push({ trackUri: t.trackUri, title: t.title, artist: t.artist, album: t.album, artworkUrl: t.artworkUrl, explicit: t.explicit, source: srcOfDomain(parseProviderUri(t.trackUri)?.provider) });
    // Only surface sources that actually returned something, so the filter never lists a dead
    // option (e.g. a radio-only provider under an album search). Domain-distinct, with icons.
    const sources: MusicSourceInfo[] = [...byDomain.entries()]
      .filter(([, v]) => used.has(v.name))
      .map(([domain, v]) => ({ instanceId: domain, name: v.name, domain, iconSvg: v.iconSvg }));
    const hasMore = { albums: libRaw.length >= limit || r.albums.length >= limit, playlists: r.playlists.length >= limit, songs: r.tracks.length >= limit };
    return { artists, albums, playlists, songs, sources, hasMore };
  }

  /** An artist's albums, marked with shelf/library status like search hits. */
  async artistAlbums(providerUri: string): Promise<SearchAlbum[]> {
    const [sources, raw] = await Promise.all([
      this.ma.listMusicProviders().catch((): MusicSourceInfo[] => []),
      this.ma.getArtistAlbums(providerUri).catch((): ProviderAlbum[] => []),
    ]);
    const srcName = new Map(sources.map((s) => [s.instanceId, s.name]));
    const primary = sources[0]?.name ?? 'Music';
    // Collapse the provider's many editions of the same album to one card.
    const seen = new Set<string>();
    const out: SearchAlbum[] = [];
    for (const a of raw) {
      const k = `${a.artist}|${a.title}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
      if (seen.has(k)) continue;
      seen.add(k);
      const row = this.shelvedRow(a.providerUri, a.title, a.artist);
      out.push({ providerUri: a.providerUri, provider: a.provider, title: a.title, artist: a.artist, year: a.year, artworkUrl: this.cachedCoverFromRow(row) ?? a.artworkUrl, onShelf: !!row, albumId: row?.id ?? null, version: a.version, explicit: a.explicit, inLibrary: a.inLibrary, source: srcName.get(a.provider) ?? primary });
    }
    // Newest first — a familiar artist-page ordering.
    out.sort((x, y) => (y.year ?? 0) - (x.year ?? 0));
    return out;
  }

  /** An artist's top songs (slow on the first fetch per artist; the provider caches). */
  async artistTopSongs(providerUri: string, artistName?: string): Promise<SearchSong[]> {
    const [sources, tracks] = await Promise.all([
      this.ma.listMusicProviders().catch((): MusicSourceInfo[] => []),
      this.ma.getArtistTopTracks(providerUri, artistName).catch((): ProviderTrackHit[] => []),
    ]);
    const primary = sources[0]?.name ?? 'Music';
    return tracks.map((t) => ({ trackUri: t.trackUri, title: t.title, artist: t.artist, album: t.album, artworkUrl: t.artworkUrl, explicit: t.explicit, source: primary }));
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
        version: a.version,
        explicit: a.explicit,
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
    // Build the dedupe indexes ONCE (was O(n²): shelfedUris + a title/artist JOIN-scan ran per
    // album). Grow them as we add so duplicates within the import are also caught.
    const shelvedUris = this.db.shelfedUris();
    const shelvedKeys = this.db.shelfedTitleArtistKeys();
    for (;;) {
      const page = await this.ma.listLibraryAlbums({ source, limit: PAGE, offset });
      if (!page.length) break;
      for (const a of page) {
        total++;
        const key = titleArtistKey(a.title, a.artist);
        if (shelvedUris.has(a.providerUri) || shelvedKeys.has(key)) {
          skipped++;
          continue;
        }
        try {
          await this.addToShelf(a.providerUri, undefined, { quiet: true });
          added++;
          shelvedUris.add(a.providerUri);
          shelvedKeys.add(key);
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

  // --- Radio (stations from TuneIn etc.) ----------------------------------

  /** Store one station as a `kind='radio'` media row (reuses the album store + artwork
      pipeline). A station has no tracks — it's a live stream. Returns the Crate id. */
  private ingestRadio(st: ProviderRadio): string {
    const id = albumIdFromUri(st.providerUri);
    const existing = this.db.getAlbum(id);
    const row: AlbumRow = {
      id,
      provider_uri: st.providerUri,
      provider: st.provider,
      title: st.name,
      // Second spine line: the station tagline, unless it just repeats the name.
      artist: st.description && st.description !== st.name ? st.description : 'Radio',
      year: null,
      artwork_url: st.artworkUrl,
      artwork_path: existing?.artwork_path ?? null,
      palette: existing?.palette ?? null,
      spine_strip_path: existing?.spine_strip_path ?? null,
      spine_scan_path: existing?.spine_scan_path ?? null,
      spine_width: existing?.spine_width ?? spineWidthFor(id),
      total_duration: null, // radio uses a uniform spine width, not runtime
      added_at: existing?.added_at ?? new Date().toISOString(),
      play_count: existing?.play_count ?? 0,
      overrides: existing?.overrides ?? null,
    };
    this.db.upsertAlbum(row);
    this.db.addToShelf(id, 'radio');
    // Palette + blurred strip from the station logo; no spine scan (no artist/title).
    if (st.artworkUrl) void this.processArtwork(id, st.artworkUrl, { scan: false });
    return id;
  }

  /** Save one station to the Radio shelf (resolves it from MA by uri, like addPlaylist). */
  async addRadio(providerUri: string): Promise<void> {
    const st = await this.ma.getRadio(providerUri);
    if (!st) throw new Error(`radio station not found: ${providerUri}`);
    this.ingestRadio(st);
    this.hub.broadcast({ type: 'shelf' });
  }

  /** Search radio stations across the connected radio sources; marks already-saved ones. */
  async searchRadio(query: string, _source?: string): Promise<RadioSearchResponse> {
    const providers = await this.ma
      .listMusicProviders()
      .catch((): Array<{ instanceId: string; name: string; domain: string; iconSvg: string | null }> => []);
    // A radio uri embeds the provider instance (e.g. tunein--xxx://…), so attribute by instance,
    // falling back to domain. MA aggregates across radio providers; the client filters.
    const byInstance = new Map(providers.map((s) => [s.instanceId, s] as const));
    const byDomain = new Map(providers.map((s) => [s.domain, s] as const));
    const shelved = this.db.shelfedUris();
    const used = new Set<string>();
    const raw = query ? await this.ma.searchRadio(query, 30).catch((): ProviderRadio[] => []) : [];
    const stations: RadioStation[] = raw.map((r) => {
      const src = byInstance.get(r.provider) ?? byDomain.get(r.provider);
      if (src) used.add(src.name);
      return {
        providerUri: r.providerUri,
        provider: r.provider,
        name: r.name,
        description: r.description,
        artworkUrl: r.artworkUrl,
        onShelf: shelved.has(r.providerUri),
        source: src?.name,
      };
    });
    const sources: MusicSourceInfo[] = providers
      .filter((s) => used.has(s.name))
      .map((s) => ({ instanceId: s.instanceId, name: s.name, domain: s.domain, iconSvg: s.iconSvg }));
    return { stations, sources };
  }

  /** MA's saved radio stations (your custom TuneIn stations), marked with shelf state. */
  async listLibraryRadios(): Promise<RadioStation[]> {
    const [radios, shelved] = [await this.ma.listLibraryRadios(), this.db.shelfedUris()];
    return radios.map((r) => ({
      providerUri: r.providerUri,
      provider: r.provider,
      name: r.name,
      description: r.description,
      artworkUrl: r.artworkUrl,
      onShelf: shelved.has(r.providerUri),
    }));
  }

  /** Pull every MA library radio onto the Radio shelf (idempotent). Returns how many were new. */
  async syncLibraryRadios(): Promise<RadioSyncResult> {
    const radios = await this.ma.listLibraryRadios().catch((): ProviderRadio[] => []);
    let added = 0;
    for (const r of radios) {
      if (this.db.isOnShelf(albumIdFromUri(r.providerUri))) continue;
      this.ingestRadio(r);
      added++;
    }
    if (added) this.hub.broadcast({ type: 'shelf' });
    return { added, total: radios.length };
  }

  private async processArtwork(id: string, url: string, opts: { scan?: boolean } = {}): Promise<void> {
    try {
      const art = await buildArtwork(id, url, { artDir: this.cfg.artDir, coverHeightPx: this.cfg.coverHeightPx });
      this.db.updateArtwork(id, art.artworkPath, art.spineStripPath, art.palette);
      invalidateArtCache(id);
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
        invalidateArtCache(id);
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
    // 'all' (albums), 'playlists', and 'radio' are all virtual views over shelf_items;
    // named shelves reorder their members.
    if (shelfId && shelfId !== 'all' && shelfId !== 'playlists' && shelfId !== 'radio') this.db.reorderShelfMembers(shelfId, albumIds);
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
    invalidateArtCache(id);
    this.hub.broadcast({ type: 'shelf' });
  }

  setOverride(id: string, patch: Partial<AlbumOverride>): AlbumOverride {
    const next = this.db.setOverride(id, patch);
    this.hub.broadcast({ type: 'shelf' });
    return next;
  }

  async play(albumId: string, trackIndex?: number, playerId?: string, providerUri?: string, trackUris?: string[]): Promise<void> {
    const player = playerId ?? this.defaultPlayerId();
    if (!player) throw new Error('no player available');
    // An explicit track list (a playlist shelf played from a song) — play it in order.
    if (trackUris && trackUris.length) {
      await this.ma.playTracks(player, trackUris);
      return;
    }
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

  setShuffle(playerId: string, enabled: boolean): Promise<void> {
    return this.ma.setShuffle(playerId, enabled);
  }

  setRepeat(playerId: string, mode: RepeatMode): Promise<void> {
    return this.ma.setRepeat(playerId, mode);
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

  /** Which front-end bundles the server actually mounted at boot (set from index.ts). */
  private frontendsServed = { shelf: false, admin: false };
  setFrontendsServed(v: { shelf: boolean; admin: boolean }): void {
    this.frontendsServed = v;
  }

  /** Health of the three Crate apps (server / shelf / admin) + Music Assistant.
      "online" means alive & serving: the server if this request is answered; the
      front-ends if the server is serving their built bundle (they have no process of
      their own); Music Assistant if the provider websocket is up. `connections` is the
      live `/ws` client count — informational, separate from the health dot. */
  systemServices(): ServicesStatus {
    const now = Date.now();
    // A front-end's "uptime" is how long its longest-lived client has been connected
    // (resets when it's reloaded); shown only while something is connected.
    const appDetail = (served: boolean, app: 'shelf' | 'admin'): string => {
      if (!served) return 'not built';
      const n = this.hub.count(app);
      const since = this.hub.oldestSince(app);
      return n > 0 && since ? `up ${fmtUptime((now - since) / 1000)} · ${plural(n, 'connection')}` : plural(n, 'connection');
    };
    const maUp = this.ma.connectedSince;
    const maVer = this.ma.serverVersion;
    return {
      services: [
        {
          id: 'server',
          name: 'Server',
          online: true,
          connections: this.hub.total,
          restartable: this.cfg.appliance,
          detail: `up ${fmtUptime(process.uptime())} · ${plural(this.hub.total, 'client')}`,
        },
        {
          id: 'shelf',
          name: 'Shelf',
          online: this.frontendsServed.shelf,
          connections: this.hub.count('shelf'),
          restartable: this.frontendsServed.shelf,
          detail: appDetail(this.frontendsServed.shelf, 'shelf'),
        },
        {
          id: 'admin',
          name: 'Admin',
          online: this.frontendsServed.admin,
          connections: this.hub.count('admin'),
          restartable: this.frontendsServed.admin,
          detail: appDetail(this.frontendsServed.admin, 'admin'),
        },
        {
          id: 'musicAssistant',
          name: 'Music Assistant',
          online: this.ma.connected,
          restartable: this.ma.connected,
          detail: this.ma.connected
            ? `${maUp ? `up ${fmtUptime((now - maUp) / 1000)}` : 'connected'}${maVer ? ` · v${maVer}` : ''}`
            : 'disconnected',
        },
      ],
    };
  }

  /** Restart one service: the server process (appliance only), a front-end (tell its
      clients to reload), or Music Assistant (reconnect its websocket). */
  async restartService(id: 'server' | 'shelf' | 'admin' | 'musicAssistant'): Promise<{ ok: boolean }> {
    switch (id) {
      case 'server':
        return this.restart();
      case 'shelf':
        this.hub.broadcast({ type: 'reload', app: 'shelf' });
        return { ok: true };
      case 'admin':
        this.hub.broadcast({ type: 'reload', app: 'admin' });
        return { ok: true };
      case 'musicAssistant':
        this.ma.reconnect();
        return { ok: true };
      default:
        return { ok: false };
    }
  }

  // --- MA management (Phase 5): sources + status ---------------------------

  /** Connection/topology status for the Settings "Music Assistant" card. */
  maStatus(): MaStatus {
    return this.ma.maStatus(this.cfg.managesMa);
  }

  /** Configured MA providers. The UI shows the `music` ones as manageable sources. */
  maSources(): Promise<MaSource[]> {
    return this.ma.listSources();
  }

  /** Music-provider types available to add. */
  maAvailableProviders(): Promise<MaProviderManifest[]> {
    return this.ma.listAvailableProviders('music');
  }

  /** Config-flow fields for adding/configuring a source (drives the Add-source form + OAuth steps). */
  maSourceEntries(
    domain: string,
    opts: { instanceId?: string; action?: string; values?: Record<string, MaConfigValue> } = {},
  ): Promise<MaConfigEntry[]> {
    return this.ma.getSourceConfigEntries(domain, opts);
  }

  /** Add (no instanceId) or update a source. */
  maSaveSource(domain: string, values: Record<string, MaConfigValue>, instanceId?: string): Promise<MaSource> {
    return this.ma.saveSource(domain, values, instanceId);
  }

  /** Remove a source, incl. MA's default source. */
  maRemoveSource(instanceId: string): Promise<void> {
    return this.ma.removeSource(instanceId);
  }

  /** Reload a source. */
  maReloadSource(instanceId: string): Promise<void> {
    return this.ma.reloadSource(instanceId);
  }

  /** Whether MA's builtin smart playlists are exposed (they otherwise clutter Crate search). */
  maBuiltinPlaylistsEnabled(): Promise<boolean> {
    return this.ma.getBuiltinPlaylistsEnabled();
  }

  /** Turn MA's builtin smart playlists on/off. The install flow disables them by default. */
  maSetBuiltinPlaylists(enabled: boolean): Promise<void> {
    return this.ma.setBuiltinPlaylists(enabled);
  }

  // --- Backup / restore (Phase 5) -----------------------------------------

  /** A portable snapshot of the user-authored config, for download or GitHub push. */
  exportBackup(): CrateBackup {
    return {
      crate: 'crate-backup',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      crateVersion: this.cfg.version,
      tables: this.db.exportConfig(),
    };
  }

  /** Restore from a backup (destructive replace). Rejects a non-Crate or newer-format file. */
  importBackup(data: CrateBackup): BackupImportResult {
    if (!data || (data as { crate?: string }).crate !== 'crate-backup' || !data.tables) {
      throw new Error('That doesn’t look like a Crate backup file.');
    }
    if (typeof data.version === 'number' && data.version > BACKUP_VERSION) {
      throw new Error(`This backup is from a newer version of Crate (format v${data.version}).`);
    }
    this.db.importConfig(data.tables);
    // The restored library/settings only take effect once the front-ends reload.
    this.hub.broadcast({ type: 'reload', app: 'shelf' });
    this.hub.broadcast({ type: 'reload', app: 'admin' });
    return {
      ok: true,
      counts: {
        albums: data.tables.albums?.length ?? 0,
        shelves: data.tables.shelves?.length ?? 0,
        shelfItems: data.tables.shelfItems?.length ?? 0,
      },
    };
  }

  // --- GitHub auto-backup (Phase 5) ---------------------------------------
  // Config lives under dotted settings keys (kept out of the typed Settings object and
  // never returned to the client — only whether a token is present).

  private githubTarget(): GithubTarget | null {
    const cfg = this.db.getRaw<{ repo?: string; branch?: string; path?: string }>('backup.github', {});
    if (!cfg.repo) return null;
    return {
      repo: cfg.repo,
      branch: cfg.branch || 'main',
      path: cfg.path || 'crate-backup.json',
      token: this.db.getRaw<string>('backup.github.token', ''),
    };
  }

  private intervalMs(iv: BackupInterval): number {
    return iv === 'hourly' ? 3_600_000 : iv === 'daily' ? 86_400_000 : iv === 'weekly' ? 604_800_000 : 0;
  }

  getGithubConfig(): GithubBackupConfig {
    const cfg = this.db.getRaw<{ repo?: string; branch?: string; path?: string; interval?: BackupInterval }>('backup.github', {});
    const interval = cfg.interval ?? 'off';
    const lastAt = this.db.getRaw<string | null>('backup.github.lastAt', null);
    const ms = this.intervalMs(interval);
    const nextBackupAt =
      interval === 'off' ? null : new Date((lastAt ? new Date(lastAt).getTime() : Date.now() - ms) + ms).toISOString();
    return {
      repo: cfg.repo ?? '',
      branch: cfg.branch ?? 'main',
      path: cfg.path ?? 'crate-backup.json',
      hasToken: !!this.db.getRaw<string>('backup.github.token', ''),
      interval,
      lastBackupAt: lastAt,
      lastStatus: this.db.getRaw<BackupStatus | null>('backup.github.lastStatus', null),
      nextBackupAt,
      history: this.db.getRaw<BackupHistoryEntry[]>('backup.github.history', []),
    };
  }

  /** Repos the stored token can reach, for the admin repo picker. */
  listGithubRepos(): Promise<Array<{ fullName: string; private: boolean }>> {
    const token = this.db.getRaw<string>('backup.github.token', '');
    if (!token) throw new Error('Add a GitHub token first.');
    return githubListRepos(token);
  }

  setGithubConfig(input: { repo?: string; branch?: string; path?: string; token?: string; interval?: BackupInterval }): GithubBackupConfig {
    const prev = this.db.getRaw<{ repo?: string; branch?: string; path?: string; interval?: BackupInterval }>('backup.github', {});
    this.db.setRaw('backup.github', {
      repo: (input.repo ?? prev.repo ?? '').trim(),
      branch: (input.branch ?? prev.branch ?? 'main').trim() || 'main',
      path: (input.path ?? prev.path ?? 'crate-backup.json').trim() || 'crate-backup.json',
      interval: input.interval ?? prev.interval ?? 'off',
    });
    // The token is write-only: replace it only when a non-empty value is supplied.
    if (typeof input.token === 'string' && input.token.trim()) {
      this.db.setRaw('backup.github.token', input.token.trim());
    }
    return this.getGithubConfig();
  }

  /** Verify the token + repo are reachable, without committing. */
  async testGithubBackup(): Promise<{ ok: true; repo: string; defaultBranch: string }> {
    const t = this.githubTarget();
    if (!t) throw new Error('Set a GitHub repository first.');
    if (!t.token) throw new Error('Add a GitHub token first.');
    return { ok: true, ...(await githubCheck(t)) };
  }

  clearGithubHistory(): GithubBackupConfig {
    this.db.setRaw('backup.github.history', []);
    return this.getGithubConfig();
  }

  private recordBackupHistory(entry: BackupHistoryEntry): void {
    const hist = this.db.getRaw<BackupHistoryEntry[]>('backup.github.history', []);
    hist.unshift(entry);
    this.db.setRaw('backup.github.history', hist.slice(0, 20));
    this.db.setRaw('backup.github.lastStatus', entry.status);
  }

  /** Push a backup, skipping when the config hasn't changed since the last push (no empty
      commits). Records a history entry. `lastAt` marks the attempt time (any status) so the
      schedule advances even on a skip. */
  async runBackup(auto: boolean): Promise<BackupRunResult> {
    const t = this.githubTarget();
    if (!t) throw new Error('Set a GitHub repository first.');
    if (!t.token) throw new Error('Add a GitHub token first.');
    const at = new Date().toISOString();
    this.db.setRaw('backup.github.lastAt', at);
    const tables = this.db.exportConfig();
    const hash = createHash('sha256').update(JSON.stringify(tables)).digest('hex');
    if (hash === this.db.getRaw<string>('backup.github.lastHash', '')) {
      this.recordBackupHistory({ at, status: 'skipped', commit: null, url: null, message: 'No changes', auto });
      return { status: 'skipped', commit: null, url: null, at, message: 'No changes' };
    }
    const backup: CrateBackup = {
      crate: 'crate-backup',
      version: BACKUP_VERSION,
      exportedAt: at,
      crateVersion: this.cfg.version,
      tables,
    };
    try {
      const { url, commit } = await githubPush(t, JSON.stringify(backup, null, 2), `Crate backup ${at}`);
      const short = commit ? commit.slice(0, 7) : null;
      this.db.setRaw('backup.github.lastHash', hash);
      this.recordBackupHistory({ at, status: 'success', commit: short, url, message: null, auto });
      return { status: 'success', commit: short, url, at, message: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Push failed';
      this.recordBackupHistory({ at, status: 'error', commit: null, url: null, message, auto });
      throw e;
    }
  }

  /** Manual "Back up now". */
  pushGithubBackup(): Promise<BackupRunResult> {
    return this.runBackup(false);
  }

  /** Called by the scheduler: run a backup if auto is enabled and one is due. */
  private autoBackupRunning = false;
  async maybeAutoBackup(): Promise<void> {
    if (this.autoBackupRunning) return;
    const cfg = this.db.getRaw<{ repo?: string; interval?: BackupInterval }>('backup.github', {});
    const interval = cfg.interval ?? 'off';
    if (interval === 'off' || !cfg.repo || !this.db.getRaw<string>('backup.github.token', '')) return;
    const ms = this.intervalMs(interval);
    const lastAt = this.db.getRaw<string | null>('backup.github.lastAt', null);
    if (lastAt && Date.now() - new Date(lastAt).getTime() < ms) return; // not due yet
    this.autoBackupRunning = true;
    try {
      await this.runBackup(true);
    } catch {
      /* the failure is recorded in history */
    } finally {
      this.autoBackupRunning = false;
    }
  }

  async restoreGithubBackup(): Promise<BackupImportResult> {
    const t = this.githubTarget();
    if (!t) throw new Error('Set a GitHub repository first.');
    if (!t.token) throw new Error('Add a GitHub token first.');
    let data: CrateBackup;
    try {
      data = JSON.parse(await githubGet(t)) as CrateBackup;
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('The backup file in GitHub isn’t valid JSON.');
      throw e;
    }
    return this.importBackup(data);
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
    // Go through the graceful-shutdown path (close HTTP + DB, checkpoint WAL); systemd relaunches.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 150);
    return { ok: true };
  }

  async reboot(): Promise<{ ok: boolean }> {
    if (!this.cfg.appliance) return { ok: false };
    await rebootSystem().catch(() => {});
    return { ok: true };
  }

  /** Current vs latest for both Crate (git) and Music Assistant (GitHub releases),
      plus MA topology so the admin can offer an MA-image update. Read-only. */
  async checkUpdate(): Promise<UpdateStatus> {
    const maVersion = this.ma.serverVersion ?? null;
    const [git, maLatest] = await Promise.all([
      checkForUpdate(),
      maVersion ? latestMaRelease() : Promise.resolve(null),
    ]);
    return {
      current: git.current ?? this.cfg.version,
      latest: git.latest,
      updateAvailable: git.updateAvailable,
      behind: git.behind,
      crateVersion: this.cfg.version,
      managesMa: this.cfg.managesMa,
      maVersion,
      maLatest,
      maUpdateAvailable: !!(maVersion && maLatest && cmpSemver(maLatest, maVersion) > 0),
      appliance: this.cfg.appliance,
      error: git.error ?? null,
    };
  }

  /** Kick off deploy/pi/update.sh (detached, outside our cgroup). Appliance only —
      it rebuilds this checkout and restarts the service; a no-op elsewhere so dev
      previews aren't disturbed. MA-only updates need the co-hosted topology. */
  /** Live progress of an in-flight update (crate-update unit state + journal tail). */
  async updateProgress(): Promise<UpdateProgress> {
    if (!this.cfg.appliance) return { active: false, log: [] };
    return updateProgress();
  }

  runUpdate(target: UpdateTarget): { ok: boolean; started: boolean } {
    if (!this.cfg.appliance) return { ok: false, started: false };
    if (target === 'ma' && !this.cfg.managesMa) return { ok: false, started: false };
    const started = spawnUpdate(target);
    return { ok: started, started };
  }
}

/** "3d 4h" / "5h 12m" / "8m" — a compact process-uptime string. */
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
/** "1 client" / "2 clients" / "0 clients". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Compare dotted numeric versions ("2.9.6" vs "2.9.5"): >0 if a is newer, <0 if
    older, 0 if equal. Non-numeric/short parts are treated as 0, so odd tags degrade
    gracefully rather than throwing. */
function cmpSemver(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
