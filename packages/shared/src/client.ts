/** Minimal typed REST client used by the shelf and admin apps. */

import type {
  AddToShelfRequest,
  AlbumDetail,
  GroupRequest,
  OverrideRequest,
  PlayRequest,
  PlayersResponse,
  SearchAlbum,
  ShelfResponse,
  TransportRequest,
  VolumeRequest,
} from './api.js';
import type { Settings } from './domain.js';

export class CrateClient {
  constructor(private readonly baseUrl: string = '') {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
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

  getShelf(): Promise<ShelfResponse> {
    return this.req('/api/shelf');
  }

  getAlbum(id: string): Promise<AlbumDetail> {
    return this.req(`/api/albums/${encodeURIComponent(id)}`);
  }

  getPlayers(): Promise<PlayersResponse> {
    return this.req('/api/players');
  }

  search(query: string): Promise<SearchAlbum[]> {
    return this.req(`/api/search?q=${encodeURIComponent(query)}`);
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
}
