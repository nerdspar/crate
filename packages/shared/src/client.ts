/** Minimal typed REST client used by the shelf and admin apps. */

import type {
  AddToShelfRequest,
  AlbumDetail,
  CreateShelfRequest,
  GlobalSearchResponse,
  GroupRequest,
  LibraryPlaylist,
  OverrideRequest,
  PlayRequest,
  PlayersResponse,
  ProviderAlbumDetail,
  SearchAlbum,
  ShelfResponse,
  SystemStatus,
  TransportRequest,
  VolumeRequest,
} from './api.js';
import type { Settings, Shelf } from './domain.js';

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

  search(query: string): Promise<SearchAlbum[]> {
    return this.req(`/api/search?q=${encodeURIComponent(query)}`);
  }
  /** Global search: albums + playlists + songs, optionally scoped to one source. */
  globalSearch(query: string, source?: string): Promise<GlobalSearchResponse> {
    const s = source && source !== 'all' ? `&source=${encodeURIComponent(source)}` : '';
    return this.req(`/api/search/global?q=${encodeURIComponent(query)}${s}`);
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

  group(body: GroupRequest): Promise<{ ok: true }> {
    return this.post('/api/group', body);
  }

  addToShelf(body: AddToShelfRequest): Promise<{ ok: true }> {
    return this.post('/api/shelf/add', body);
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
  /** Start resolving a playlist's track art before opening its song shelf. */
  prewarmPlaylist(providerUri: string): Promise<{ ok: true }> {
    return this.post('/api/playlists/prewarm', { providerUri });
  }

  removeFromShelf(albumId: string): Promise<{ ok: true }> {
    return this.req(`/api/shelf/${encodeURIComponent(albumId)}`, { method: 'DELETE' });
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
