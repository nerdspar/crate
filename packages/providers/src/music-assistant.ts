/**
 * Music Assistant provider — implements both MusicSource and PlayerTarget.
 *
 * MA collapses the source/target split: it supplies Apple Music search,
 * metadata, and artwork, and it plays to Sonos (and everything else) with
 * correct per-account authorization. See docs/playback.md for why Crate uses
 * MA instead of node-sonos-http-api + iTunes.
 */

import type { PlaybackState, PlayerState, PlayerType, Track } from '@crate/shared';
import { MaClient, type MaClientOptions, type MaEvent, type MaServerInfo } from './ma-client.js';
import type {
  MusicSource,
  PlayerTarget,
  ProviderAlbum,
  ProviderPlayer,
  ProviderPlaylist,
  TransportCommand,
} from './interfaces.js';

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `apple_music://album/594061854` → { provider, type, id }. */
export function parseProviderUri(uri: string): { provider: string; type: string; id: string } | null {
  const m = /^([^:]+):\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) return null;
  return { provider: m[1]!, type: m[2]!, id: m[3]! };
}

function firstArtistName(item: Record<string, unknown>): string {
  const artists = arr(item['artists']);
  for (const a of artists) {
    const name = str(rec(a)['name']);
    if (name) return name;
  }
  const single = str(rec(item['artist'])['name']);
  return single ?? '(unknown artist)';
}

function mapPlayerType(provider: string, name: string): PlayerType {
  const p = provider.toLowerCase();
  const n = name.toLowerCase();
  if (p.includes('sonos')) return 'sonos';
  if (n.includes('homepod')) return 'homepod';
  if (p.includes('airplay')) return 'airplay';
  if (p.includes('cast')) return 'cast';
  if (p.includes('web') || p.includes('builtin')) return 'web';
  return 'other';
}

function mapPlaybackState(raw: string | undefined): PlaybackState {
  switch (raw) {
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'idle':
      return 'idle';
    default:
      return 'unknown';
  }
}

export class MusicAssistantProvider implements MusicSource, PlayerTarget {
  readonly id = 'music-assistant';
  private readonly client: MaClient;
  private readonly maBaseUrl: string;
  private stateDebounce: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: MaClientOptions) {
    this.client = new MaClient(opts);
    this.maBaseUrl = opts.url.replace(/\/+$/, '');
  }

  start(): Promise<MaServerInfo> {
    return this.client.start();
  }
  onConnect(cb: (info: MaServerInfo) => void): () => void {
    return this.client.onConnect(cb);
  }
  close(): void {
    this.client.close();
  }

  // --- Artwork ------------------------------------------------------------

  private artworkUrl(item: Record<string, unknown>): string | null {
    const image = rec(item['image']);
    const fallback = rec(arr(rec(item['metadata'])['images'])[0]);
    const img = str(image['path']) ? image : fallback;
    const path = str(img['path']);
    const provider = str(img['provider']);
    if (!path) return null;
    if (/^https?:\/\//.test(path)) return path;
    // Non-URL provider path → route through MA's image proxy.
    const q = new URLSearchParams({ path, size: '0' });
    if (provider) q.set('provider', provider);
    return `${this.maBaseUrl}/imageproxy?${q.toString()}`;
  }

  private toProviderAlbum(item: Record<string, unknown>): ProviderAlbum | null {
    const uri = str(item['uri']);
    const title = str(item['name']);
    if (!uri || !title) return null;
    return {
      providerUri: uri,
      provider: str(item['provider']) ?? parseProviderUri(uri)?.provider ?? 'unknown',
      title,
      artist: firstArtistName(item),
      year: num(item['year']) ?? null,
      artworkUrl: this.artworkUrl(item),
    };
  }

  private toProviderPlaylist(item: Record<string, unknown>): ProviderPlaylist | null {
    const uri = str(item['uri']);
    const name = str(item['name']);
    if (!uri || !name) return null;
    return {
      providerUri: uri,
      provider: str(item['provider']) ?? parseProviderUri(uri)?.provider ?? 'unknown',
      name,
      owner: str(item['owner']) ?? null,
      artworkUrl: this.artworkUrl(item),
    };
  }

  // --- MusicSource --------------------------------------------------------

  async search(query: string, limit = 20): Promise<ProviderAlbum[]> {
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: ['album'],
        limit,
        library_only: false,
      }),
    );
    return arr(result['albums'])
      .map((a) => this.toProviderAlbum(rec(a)))
      .filter((a): a is ProviderAlbum => a !== null);
  }

  async getAlbum(providerUri: string): Promise<ProviderAlbum | null> {
    const item = rec(await this.client.command('music/item_by_uri', { uri: providerUri }));
    return this.toProviderAlbum(item);
  }

  async getTracks(providerUri: string): Promise<Track[]> {
    const parsed = parseProviderUri(providerUri);
    if (!parsed) return [];
    if (parsed.type === 'playlist') return this.getPlaylistTracks(parsed.provider, parsed.id);
    const raw = await this.client.command('music/albums/album_tracks', {
      item_id: parsed.id,
      provider_instance_id_or_domain: parsed.provider,
      in_library_only: false,
    });
    return arr(raw).map((t, i): Track => {
      const item = rec(t);
      return {
        index: num(item['track_number']) ?? i + 1,
        title: str(item['name']) ?? `Track ${i + 1}`,
        artist: firstArtistName(item),
        duration: num(item['duration']) ?? null,
        uri: str(item['uri']) ?? null,
      };
    });
  }

  private async getPlaylistTracks(provider: string, id: string): Promise<Track[]> {
    const raw = await this.client.command('music/playlists/playlist_tracks', {
      item_id: id,
      provider_instance_id_or_domain: provider,
    });
    // Playlists have no track numbering of their own — use playlist position.
    // `artists` is often empty in this list payload, and the track's `album.uri`
    // is a name-based ref that won't resolve — so carry the track's own (real)
    // uri and resolve its album lazily on tap (getTrackAlbum).
    return arr(raw).map((t, i): Track => {
      const item = rec(t);
      return {
        index: num(item['position']) ?? i + 1,
        title: str(item['name']) ?? `Track ${i + 1}`,
        artist: arr(item['artists']).length ? firstArtistName(item) : '',
        duration: num(item['duration']) ?? null,
        uri: str(item['uri']) ?? null,
        albumUri: str(item['uri']) ?? null,
      };
    });
  }

  /** Resolve a track uri to its real album uri + 0-based album position. Playlist
      tracks carry an unresolvable name-based album ref; the full track has the real one. */
  async getTrackAlbum(trackUri: string): Promise<{ albumUri: string; trackIndex: number } | null> {
    const parsed = parseProviderUri(trackUri);
    if (!parsed) return null;
    const full = rec(
      await this.client.command('music/tracks/get_track', {
        item_id: parsed.id,
        provider_instance_id_or_domain: parsed.provider,
      }),
    );
    const albumUri = str(rec(full['album'])['uri']);
    const trackNumber = num(full['track_number']) ?? 0;
    return albumUri ? { albumUri, trackIndex: trackNumber > 0 ? trackNumber - 1 : -1 } : null;
  }

  /** Resolve one playlist track's real metadata (playlist_tracks omits artists and
      gives a broken album ref): artist, real album uri, cover art, album position. */
  async enrichTrack(
    trackUri: string,
  ): Promise<{ artist: string; albumUri: string | null; artworkUrl: string | null; albumIndex: number } | null> {
    const parsed = parseProviderUri(trackUri);
    if (!parsed) return null;
    const full = rec(
      await this.client.command('music/tracks/get_track', {
        item_id: parsed.id,
        provider_instance_id_or_domain: parsed.provider,
      }),
    );
    const album = rec(full['album']);
    const trackNumber = num(full['track_number']) ?? 0;
    return {
      artist: firstArtistName(full),
      albumUri: str(album['uri']) ?? null,
      artworkUrl: this.artworkUrl(full) ?? this.artworkUrl(album),
      albumIndex: trackNumber > 0 ? trackNumber - 1 : -1,
    };
  }

  async listLibraryPlaylists(limit = 200): Promise<ProviderPlaylist[]> {
    const raw = await this.client.command('music/playlists/library_items', { limit, favorite: false });
    const items = Array.isArray(raw) ? raw : arr(rec(raw)['items']);
    return items.map((p) => this.toProviderPlaylist(rec(p))).filter((p): p is ProviderPlaylist => p !== null);
  }

  async getPlaylist(providerUri: string): Promise<ProviderPlaylist | null> {
    const item = rec(await this.client.command('music/item_by_uri', { uri: providerUri }));
    return this.toProviderPlaylist(item);
  }

  // --- PlayerTarget -------------------------------------------------------

  async listPlayers(): Promise<ProviderPlayer[]> {
    const raw = await this.client.command('players/all', { return_unavailable: true });
    return arr(raw).map((p): ProviderPlayer => {
      const item = rec(p);
      const id = str(item['player_id']) ?? '';
      const name = str(item['display_name']) ?? str(item['name']) ?? id;
      const provider = str(item['provider']) ?? 'unknown';
      return { id, name, type: mapPlayerType(provider, name), available: item['available'] !== false, provider };
    });
  }

  async play(playerId: string, providerUri: string, opts?: { trackIndex?: number }): Promise<void> {
    await this.client.command('player_queues/play_media', {
      queue_id: playerId,
      media: providerUri,
      option: 'replace',
    });
    if (opts?.trackIndex !== undefined && opts.trackIndex > 0) {
      // Best-effort: jump to the requested track after the album is queued.
      await this.client.command('player_queues/play_index', { queue_id: playerId, index: opts.trackIndex });
    }
  }

  async transport(playerId: string, cmd: TransportCommand, positionSec?: number): Promise<void> {
    const map: Record<TransportCommand, string> = {
      // `resume` continues from the last position whether the queue was paused or
      // stopped; `play` alone can restart. In Crate, transport 'play' always means
      // "continue" (a fresh start goes through play_media).
      play: 'player_queues/resume',
      pause: 'player_queues/pause',
      next: 'player_queues/next',
      previous: 'player_queues/previous',
      seek: 'player_queues/seek',
    };
    const args: Record<string, unknown> = { queue_id: playerId };
    if (cmd === 'seek') args['position'] = Math.max(0, Math.floor(positionSec ?? 0));
    await this.client.command(map[cmd], args);
  }

  async setVolume(playerId: string, level: number): Promise<void> {
    await this.client.command('players/cmd/volume_set', {
      player_id: playerId,
      volume_level: Math.max(0, Math.min(100, Math.round(level))),
    });
  }

  async setMembers(targetPlayerId: string, add: string[], remove: string[]): Promise<void> {
    await this.client.command('players/cmd/set_members', {
      target_player: targetPlayerId,
      player_ids_to_add: add,
      player_ids_to_remove: remove,
    });
  }

  async getState(): Promise<PlayerState[]> {
    const [playersRaw, queuesRaw] = await Promise.all([
      this.client.command('players/all', { return_unavailable: true }),
      this.client.command('player_queues/all'),
    ]);

    const volumeById = new Map<string, { volume: number | null; muted: boolean }>();
    const groupLeaderById = new Map<string, string | null>();
    for (const p of arr(playersRaw)) {
      const item = rec(p);
      const id = str(item['player_id']);
      if (!id) continue;
      volumeById.set(id, { volume: num(item['volume_level']) ?? null, muted: item['volume_muted'] === true });
      // MA: `synced_to` = the leader this player follows; `group_childs` = members
      // when this player IS the leader. Solo players lead themselves.
      const syncedTo = str(item['synced_to']);
      const childs = arr(item['group_childs']);
      groupLeaderById.set(id, syncedTo ?? (childs.length ? id : id));
    }

    return arr(queuesRaw)
      .map((q): PlayerState | null => {
        const queue = rec(q);
        const id = str(queue['queue_id']);
        if (!id) return null;
        const vol = volumeById.get(id) ?? { volume: null, muted: false };
        const current = rec(queue['current_item']);
        const media = rec(current['media_item']);
        const hasNow = str(media['name']) !== undefined || str(current['name']) !== undefined;
        return {
          playerId: id,
          state: mapPlaybackState(str(queue['state'])),
          volume: vol.volume,
          muted: vol.muted,
          groupLeader: groupLeaderById.get(id) ?? id,
          nowPlaying: hasNow
            ? {
                albumId: null,
                albumUri: str(rec(media['album'])['uri']) ?? null,
                title: str(media['name']) ?? str(current['name']) ?? null,
                artist: firstArtistName(media),
                album: str(rec(media['album'])['name']) ?? null,
                trackIndex: num(queue['current_index']) ?? null,
                duration: num(current['duration']) ?? num(media['duration']) ?? null,
                elapsed: num(queue['elapsed_time']) ?? null,
              }
            : null,
        };
      })
      .filter((s): s is PlayerState => s !== null);
  }

  /** Subscribe to frequent elapsed-time ticks (MA `queue_time_updated`). */
  onProgress(cb: (playerId: string, elapsed: number) => void): () => void {
    return this.client.onEvent((e: MaEvent) => {
      if (e.event !== 'queue_time_updated' || !e.object_id) return;
      const elapsed = typeof e.data === 'number' ? e.data : num(rec(e.data)['elapsed_time']);
      if (elapsed !== undefined) cb(e.object_id, elapsed);
    });
  }

  onState(cb: (states: PlayerState[]) => void): () => void {
    const refetch = (): void => {
      if (this.stateDebounce) clearTimeout(this.stateDebounce);
      this.stateDebounce = setTimeout(() => {
        this.getState()
          .then(cb)
          .catch(() => {
            /* transient — next event will retry */
          });
      }, 400);
    };
    const relevant = new Set(['queue_updated', 'player_updated', 'player_added', 'player_removed']);
    return this.client.onEvent((e: MaEvent) => {
      if (relevant.has(e.event)) refetch();
    });
  }
}
