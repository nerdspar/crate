/** Minimal typed REST client used by the shelf and admin apps. */

import type {
  AddToShelfRequest,
  AlbumDetail,
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
  ProviderAlbumDetail,
  RepeatRequest,
  SearchAlbum,
  SearchSong,
  ServicesStatus,
  ShelfResponse,
  ShuffleRequest,
  SystemStatus,
  TransportRequest,
  VolumeRequest,
} from './api.js';
import type { Settings, Shelf, Track } from './domain.js';

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
}
