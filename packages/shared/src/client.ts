/** Minimal typed REST client used by the shelf and admin apps. */

import type {
  AddToShelfRequest,
  AlbumDetail,
  AutoUpdateConfig,
  CreateShelfRequest,
  GlobalSearchResponse,
  GroupRequest,
  LibraryAlbumsResponse,
  LibraryImportResult,
  LibraryPlaylist,
  MusicSourceInfo,
  OverrideRequest,
  PlayRequest,
  PlayersResponse,
  QueueResponse,
  ProviderAlbumDetail,
  AudiobookDetail,
  MediaBrowseItem,
  MediaSearchResponse,
  MediaSyncResult,
  PodcastEpisodesResponse,
  RepeatRequest,
  SearchAlbum,
  SearchSong,
  ServiceHealth,
  ServicesStatus,
  ShelfResponse,
  ShuffleRequest,
  SystemStatus,
  TransportRequest,
  UpdateProgress,
  UpdateStatus,
  UpdateTarget,
  VolumeRequest,
} from './api.js';
import type { ExtraMediaKind, Settings, Shelf, Track } from './domain.js';
import type { MaConfigEntry, MaConfigValue, MaConnection, MaProviderManifest, MaSource, MaStatus } from './ma.js';
import type { BackupImportResult, BackupInterval, BackupRunResult, CrateBackup, GithubBackupConfig } from './backup.js';

export class CrateClient {
  constructor(private readonly baseUrl: string = '') {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    // Only declare a JSON content-type when there's actually a body — a body-less
    // DELETE with content-type:application/json makes Fastify reject the empty body.
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init?.body != null ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${res.statusText} ${text}`);
    }
    return (await res.json()) as T;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.req<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  getShelf(shelfId?: string): Promise<ShelfResponse> {
    return this.req(shelfId ? `/api/shelf?shelf=${encodeURIComponent(shelfId)}` : '/api/shelf');
  }

  createShelf(body: CreateShelfRequest): Promise<Shelf> {
    return this.post('/api/shelves', body);
  }
  renameShelf(id: string, name: string): Promise<{ ok: true }> {
    return this.req(`/api/shelves/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name }) });
  }
  deleteShelf(id: string): Promise<{ ok: true }> {
    return this.req(`/api/shelves/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  addAlbumToShelf(shelfId: string, albumId: string): Promise<{ ok: true }> {
    return this.post(`/api/shelves/${encodeURIComponent(shelfId)}/albums`, { albumId });
  }
  removeAlbumFromShelf(shelfId: string, albumId: string): Promise<{ ok: true }> {
    return this.req(`/api/shelves/${encodeURIComponent(shelfId)}/albums/${encodeURIComponent(albumId)}`, {
      method: 'DELETE',
    });
  }

  getAlbum(id: string): Promise<AlbumDetail> {
    return this.req(`/api/albums/${encodeURIComponent(id)}`);
  }

  /** Off-shelf album detail by provider uri (for song→album cards). */
  getProviderAlbum(uri: string): Promise<ProviderAlbumDetail> {
    return this.req(`/api/provider-album?uri=${encodeURIComponent(uri)}`);
  }

  getPlayers(): Promise<PlayersResponse> {
    return this.req('/api/players');
  }

  search(query: string, source?: string): Promise<SearchAlbum[]> {
    const s = source && source !== 'all' ? `&source=${encodeURIComponent(source)}` : '';
    return this.req(`/api/search?q=${encodeURIComponent(query)}${s}`);
  }
  /** Global search: albums + playlists + songs, optionally scoped to one source.
      `limit` is the per-section cap (raised to page in more results). */
  globalSearch(query: string, source?: string, limit?: number): Promise<GlobalSearchResponse> {
    const s = source && source !== 'all' ? `&source=${encodeURIComponent(source)}` : '';
    const l = limit ? `&limit=${limit}` : '';
    return this.req(`/api/search/global?q=${encodeURIComponent(query)}${s}${l}`);
  }

  /** An artist's albums (fast). */
  getArtistAlbums(providerUri: string): Promise<SearchAlbum[]> {
    return this.req(`/api/artist/albums?uri=${encodeURIComponent(providerUri)}`);
  }
  /** An artist's top songs, popularity-ranked. Pass the artist name so the server can
      rank via the provider's search (the ordering the streaming app itself shows). */
  getArtistTopSongs(providerUri: string, artistName?: string): Promise<SearchSong[]> {
    const q = artistName ? `&name=${encodeURIComponent(artistName)}` : '';
    return this.req(`/api/artist/songs?uri=${encodeURIComponent(providerUri)}${q}`);
  }

  play(body: PlayRequest): Promise<{ ok: true }> {
    return this.post('/api/play', body);
  }

  transport(body: TransportRequest): Promise<{ ok: true }> {
    return this.post('/api/transport', body);
  }

  setVolume(body: VolumeRequest): Promise<{ ok: true }> {
    return this.post('/api/volume', body);
  }

  setShuffle(body: ShuffleRequest): Promise<{ ok: true }> {
    return this.post('/api/shuffle', body);
  }

  setRepeat(body: RepeatRequest): Promise<{ ok: true }> {
    return this.post('/api/repeat', body);
  }

  group(body: GroupRequest): Promise<{ ok: true }> {
    return this.post('/api/group', body);
  }

  // --- Play queue ("Up Next") ---
  getQueue(playerId: string): Promise<QueueResponse> {
    return this.req(`/api/queue?player=${encodeURIComponent(playerId)}`);
  }
  queuePlay(playerId: string, index: number): Promise<{ ok: true }> {
    return this.post('/api/queue/play', { player: playerId, index });
  }
  queueMove(playerId: string, itemId: string, posShift: number): Promise<{ ok: true }> {
    return this.post('/api/queue/move', { player: playerId, itemId, posShift });
  }
  queueRemove(playerId: string, itemId: string): Promise<{ ok: true }> {
    return this.post('/api/queue/remove', { player: playerId, itemId });
  }
  queueClear(playerId: string): Promise<{ ok: true }> {
    return this.post('/api/queue/clear', { player: playerId });
  }
  /** Append a media item (album/playlist/track uri) to the end of a player's queue. */
  queueEnqueue(playerId: string, uri: string): Promise<{ ok: true }> {
    return this.post('/api/queue/enqueue', { player: playerId, uri });
  }

  addToShelf(body: AddToShelfRequest): Promise<{ ok: true; albumId: string; duplicate: boolean }> {
    return this.post('/api/shelf/add', body);
  }

  /** Connected streaming music sources (for the source filter). */
  getSources(): Promise<MusicSourceInfo[]> {
    return this.req('/api/sources');
  }
  /** A page of the user's library albums (source-scoped / searched / favorites). */
  listLibraryAlbums(opts: {
    source?: string;
    search?: string;
    favorite?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<LibraryAlbumsResponse> {
    const q = new URLSearchParams();
    if (opts.source) q.set('source', opts.source);
    if (opts.search) q.set('search', opts.search);
    if (opts.favorite) q.set('favorite', '1');
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return this.req(`/api/library/albums${qs ? `?${qs}` : ''}`);
  }
  /** Bulk-add every library album (optionally one source) to the shelf. */
  importLibrary(source?: string): Promise<LibraryImportResult> {
    return this.post('/api/library/import', source ? { source } : {});
  }

  /** The user's provider-library playlists, for the add picker. */
  listLibraryPlaylists(): Promise<LibraryPlaylist[]> {
    return this.req('/api/playlists/library');
  }
  /** Search playlists (library + provider-curated). */
  searchPlaylists(query: string): Promise<LibraryPlaylist[]> {
    return this.req(`/api/playlists/search?q=${encodeURIComponent(query)}`);
  }
  addPlaylist(providerUri: string): Promise<{ ok: true }> {
    return this.post('/api/playlists', { providerUri });
  }
  /** A playlist's tracks, for the play-now overlay. */
  getPlaylistTracks(uri: string): Promise<Track[]> {
    return this.req(`/api/playlists/tracks?uri=${encodeURIComponent(uri)}`);
  }
  /** Crate-local custom song order for a playlist shelf (doesn't touch the source playlist). */
  reorderPlaylistSongs(shelfId: string, trackUris: string[]): Promise<{ ok: true }> {
    return this.post(`/api/playlists/${encodeURIComponent(shelfId)}/songs/reorder`, { trackUris });
  }
  /** Hide (Crate-local) or restore one song in a playlist shelf. */
  hidePlaylistSong(shelfId: string, trackUri: string, hidden = true): Promise<{ ok: true }> {
    return this.post(`/api/playlists/${encodeURIComponent(shelfId)}/songs/hide`, { trackUri, hidden });
  }
  /** Start resolving a playlist's track art before opening its song shelf. */
  prewarmPlaylist(providerUri: string): Promise<{ ok: true }> {
    return this.post('/api/playlists/prewarm', { providerUri });
  }

  // --- Extra media: radio / podcasts / audiobooks (via MA) ---
  /** Search one media kind across the connected sources. */
  searchMedia(kind: ExtraMediaKind, query: string, source?: string): Promise<MediaSearchResponse> {
    const q = new URLSearchParams({ q: query });
    if (source && source !== 'all') q.set('source', source);
    return this.req(`/api/media/${kind}/search?${q.toString()}`);
  }
  /** A source's items of one kind already saved in the MA library. */
  listLibraryMedia(kind: ExtraMediaKind): Promise<MediaBrowseItem[]> {
    return this.req(`/api/media/${kind}/library`);
  }
  /** Save one item of a kind to its Crate shelf. */
  addMedia(kind: ExtraMediaKind, providerUri: string): Promise<{ ok: true }> {
    return this.post(`/api/media/${kind}`, { providerUri });
  }
  /** Pull a kind's saved MA-library items onto its shelf; returns how many were added. */
  syncMedia(kind: ExtraMediaKind): Promise<MediaSyncResult> {
    return this.post(`/api/media/${kind}/sync`, {});
  }
  /** A saved podcast's episodes. */
  podcastEpisodes(providerUri: string): Promise<PodcastEpisodesResponse> {
    return this.req(`/api/media/podcast/episodes?uri=${encodeURIComponent(providerUri)}`);
  }
  /** An audiobook's progress + chapters. */
  audiobookDetail(providerUri: string): Promise<AudiobookDetail> {
    return this.req(`/api/media/audiobook/detail?uri=${encodeURIComponent(providerUri)}`);
  }
  /** Toggle a podcast episode / audiobook played-state (feed providers persist it). */
  markPlayed(providerUri: string, played: boolean): Promise<{ ok: boolean }> {
    return this.req(`/api/media/played`, { method: 'POST', body: JSON.stringify({ uri: providerUri, played }) });
  }
  /** In-progress episodes/audiobooks of one kind, for "Continue listening". */
  continueListening(kind: ExtraMediaKind): Promise<MediaBrowseItem[]> {
    return this.req(`/api/media/continue?kind=${kind}`);
  }

  removeFromShelf(albumId: string): Promise<{ ok: true }> {
    return this.req(`/api/shelf/${encodeURIComponent(albumId)}`, { method: 'DELETE' });
  }
  /** Set the manual album order for the library, or a crate (shelf id). */
  reorderShelf(albumIds: string[], shelf?: string): Promise<{ ok: true }> {
    return this.post('/api/shelf/reorder', { albumIds, ...(shelf ? { shelf } : {}) });
  }

  putOverride(albumId: string, body: OverrideRequest): Promise<{ ok: true }> {
    return this.post(`/api/albums/${encodeURIComponent(albumId)}/override`, body);
  }

  /** Upload a custom spine or cover image (multipart). */
  async uploadArt(albumId: string, kind: 'spine' | 'cover', file: File): Promise<{ ok: true }> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${this.baseUrl}/api/albums/${encodeURIComponent(albumId)}/art/${kind}`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`upload ${kind} → ${res.status} ${res.statusText}`);
    return (await res.json()) as { ok: true };
  }

  getSettings(): Promise<Settings> {
    return this.req('/api/settings');
  }

  putSettings(settings: Partial<Settings>): Promise<Settings> {
    return this.req('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
  }

  // --- System / appliance (control center §6) ---
  getSystemStatus(): Promise<SystemStatus> {
    return this.req('/api/system/status');
  }

  /** Health of the three apps + Music Assistant for the System status view. */
  getServices(): Promise<ServicesStatus> {
    return this.req('/api/system/services');
  }

  setBrightness(level: number): Promise<SystemStatus> {
    return this.post('/api/system/brightness', { level });
  }

  setDisplaySleep(asleep: boolean): Promise<SystemStatus> {
    return this.post(`/api/system/display/${asleep ? 'sleep' : 'wake'}`, {});
  }

  refreshArtwork(): Promise<{ ok: true }> {
    return this.post('/api/system/artwork-refresh', {});
  }

  restartApp(): Promise<{ ok: boolean }> {
    return this.post('/api/system/restart', {});
  }

  reboot(): Promise<{ ok: boolean }> {
    return this.post('/api/system/reboot', {});
  }

  /** Restart one service: the server process, a front-end (reloads its clients), or
      Music Assistant (reconnects its websocket). */
  restartService(id: ServiceHealth['id']): Promise<{ ok: boolean }> {
    return this.post('/api/system/services/restart', { id });
  }

  /** Whether a newer Crate is available (git), plus MA-update topology. Read-only. */
  checkUpdate(): Promise<UpdateStatus> {
    return this.req('/api/system/update');
  }

  /** Start an in-place update (appliance only). Rebuilds + restarts Crate and/or
      updates the co-hosted Music Assistant image, preserving MA's data. */
  runUpdate(target: UpdateTarget = 'both'): Promise<{ ok: boolean; started: boolean }> {
    return this.post('/api/system/update', { target });
  }

  /** Live progress of an in-flight update (unit state + journal tail). */
  updateProgress(): Promise<UpdateProgress> {
    return this.req('/api/system/update/progress');
  }

  /** Scheduled auto-update config (mode/frequency/hour + last/next run). */
  getAutoUpdate(): Promise<AutoUpdateConfig> {
    return this.req('/api/system/update/auto');
  }
  setAutoUpdate(cfg: Partial<Pick<AutoUpdateConfig, 'mode' | 'frequency' | 'hour'>>): Promise<AutoUpdateConfig> {
    return this.req('/api/system/update/auto', { method: 'PUT', body: JSON.stringify(cfg) });
  }

  // --- Music Assistant management (Phase 5) ---
  /** MA connection + topology status for the Settings card. */
  getMaStatus(): Promise<MaStatus> {
    return this.req('/api/admin/ma/status');
  }
  /** Editable MA connection (URL + whether a token is stored + live state). */
  getMaConnection(): Promise<MaConnection> {
    return this.req('/api/admin/ma/connection');
  }
  /** Point Crate at a (new) MA URL/token and reconnect. Token is write-only (blank keeps it). */
  setMaConnection(cfg: { url?: string; token?: string }): Promise<MaConnection> {
    return this.req('/api/admin/ma/connection', { method: 'PUT', body: JSON.stringify(cfg) });
  }
  /** Verify a URL+token without changing the live connection. */
  testMaConnection(cfg: { url?: string; token?: string }): Promise<{ ok: boolean; serverVersion: string | null }> {
    return this.post('/api/admin/ma/connection/test', cfg);
  }
  /** Co-hosted: create the MA account if fresh, mint a long-lived token, and connect. */
  mintMaConnection(cfg: { url?: string; username?: string; password?: string }): Promise<MaConnection> {
    return this.post('/api/admin/ma/connection/mint', cfg);
  }
  /** Reachability + whether the co-hosted MA still needs its first admin account. */
  maSetupState(url?: string): Promise<{ reachable: boolean; needsSetup: boolean }> {
    return this.post('/api/admin/ma/connection/needs-setup', url ? { url } : {});
  }

  /** First-run onboarding state. */
  getOnboarding(): Promise<{ done: boolean }> {
    return this.req('/api/admin/onboarding');
  }
  completeOnboarding(): Promise<{ done: boolean }> {
    return this.post('/api/admin/onboarding/done', {});
  }

  // --- Admin auth (Phase 5) ---
  /** Whether the admin lock is enabled, and whether this session is signed in. */
  getAuthStatus(): Promise<{ enabled: boolean; authed: boolean }> {
    return this.req('/api/auth/status');
  }
  login(passphrase: string): Promise<{ ok: true }> {
    return this.post('/api/auth/login', { passphrase });
  }
  logout(): Promise<{ ok: true }> {
    return this.post('/api/auth/logout', {});
  }
  /** Set / change / (empty `next`) clear the admin passphrase. */
  setPassphrase(next: string, current?: string): Promise<{ ok: true; enabled: boolean }> {
    return this.post('/api/auth/passphrase', { next, ...(current ? { current } : {}) });
  }
  /** Clear a forgotten admin passphrase (recovery from the physically-present wall). */
  resetAuth(): Promise<{ ok: true; enabled: boolean }> {
    return this.post('/api/auth/reset', {});
  }
  /** All configured MA providers (filter to type 'music' for manageable sources). */
  getMaSources(): Promise<MaSource[]> {
    return this.req('/api/admin/ma/sources');
  }
  /** Music-provider types available to add. */
  getMaProviders(): Promise<MaProviderManifest[]> {
    return this.req('/api/admin/ma/providers');
  }
  /** Config-flow fields for adding/configuring a source. Re-call with `action` to advance
      an interactive step (e.g. an OAuth "Authenticate" button). */
  getMaSourceEntries(
    domain: string,
    opts: { instanceId?: string; action?: string; values?: Record<string, MaConfigValue> } = {},
  ): Promise<MaConfigEntry[]> {
    return this.post('/api/admin/ma/sources/entries', { domain, ...opts });
  }
  /** Poll for the authorize URL MA emits after an interactive-auth action is started. */
  getMaAuthUrl(sessionId: string): Promise<{ url: string | null }> {
    return this.req(`/api/admin/ma/auth-url?session=${encodeURIComponent(sessionId)}`);
  }
  /** Add (no instanceId) or update a source. */
  saveMaSource(domain: string, values: Record<string, MaConfigValue>, instanceId?: string): Promise<MaSource> {
    return this.post('/api/admin/ma/sources', { domain, values, ...(instanceId ? { instanceId } : {}) });
  }
  /** Remove a source, incl. MA's default `builtin` source. */
  removeMaSource(instanceId: string): Promise<{ ok: true }> {
    return this.req(`/api/admin/ma/sources/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
  }
  /** Reload a source. */
  reloadMaSource(instanceId: string): Promise<{ ok: true }> {
    return this.post(`/api/admin/ma/sources/${encodeURIComponent(instanceId)}/reload`, {});
  }
  /** Whether MA's builtin smart playlists (Random Album, Infinite Mix, …) are exposed to search. */
  getMaBuiltinPlaylists(): Promise<{ enabled: boolean }> {
    return this.req('/api/admin/ma/builtin-playlists');
  }
  setMaBuiltinPlaylists(enabled: boolean): Promise<{ ok: true; enabled: boolean }> {
    return this.post('/api/admin/ma/builtin-playlists', { enabled });
  }

  // --- Config backup / restore (Phase 5) ---
  /** Download the full config snapshot (settings, library, shelves, curation). */
  exportBackup(): Promise<CrateBackup> {
    return this.req('/api/admin/backup/export');
  }
  /** Restore from a backup (destructive replace of the user-authored config). */
  importBackup(data: CrateBackup): Promise<BackupImportResult> {
    return this.post('/api/admin/backup/import', data);
  }

  /** GitHub auto-backup config (token is never returned — only `hasToken`). */
  getGithubBackup(): Promise<GithubBackupConfig> {
    return this.req('/api/admin/backup/github');
  }
  setGithubBackup(cfg: { repo?: string; branch?: string; path?: string; token?: string; interval?: BackupInterval }): Promise<GithubBackupConfig> {
    return this.req('/api/admin/backup/github', { method: 'PUT', body: JSON.stringify(cfg) });
  }
  /** Repos the stored token can reach, for the repo picker. */
  listGithubRepos(): Promise<Array<{ fullName: string; private: boolean }>> {
    return this.req('/api/admin/backup/github/repos');
  }
  /** Commit the current config to GitHub now (skips when nothing changed). */
  pushGithubBackup(): Promise<BackupRunResult> {
    return this.post('/api/admin/backup/github/push', {});
  }
  /** Verify the token + repo are reachable, without committing. */
  testGithubBackup(): Promise<{ ok: true; repo: string; defaultBranch: string }> {
    return this.post('/api/admin/backup/github/test', {});
  }
  /** Restore from the backup file in the configured GitHub repo (destructive). */
  restoreGithubBackup(): Promise<BackupImportResult> {
    return this.post('/api/admin/backup/github/restore', {});
  }
  /** Clear the backup history log. */
  clearGithubHistory(): Promise<GithubBackupConfig> {
    return this.req('/api/admin/backup/github/history', { method: 'DELETE' });
  }
}
