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
  ProviderLibraryAlbum,
  ProviderPlayer,
  ProviderPlaylist,
  ProviderTrackHit,
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
  // Short-lived album/playlist track-list cache. Opening a card resolves the tracks
  // (getProviderAlbum → getTracks); reusing them when you then hit play makes the play
  // path skip that round-trip, so playback starts sooner.
  private readonly trackCache = new Map<string, { tracks: Track[]; at: number }>();
  private static readonly TRACK_TTL_MS = 5 * 60_000;

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
    const explicit = rec(item['metadata'])['explicit'];
    return {
      providerUri: uri,
      provider: str(item['provider']) ?? parseProviderUri(uri)?.provider ?? 'unknown',
      title,
      artist: firstArtistName(item),
      year: num(item['year']) ?? null,
      artworkUrl: this.artworkUrl(item),
      version: str(item['version']) || null,
      explicit: typeof explicit === 'boolean' ? explicit : null,
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

  async search(query: string, limit = 20, providerInstance?: string): Promise<ProviderAlbum[]> {
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: ['album'],
        limit,
        library_only: false,
        ...(providerInstance ? { provider: providerInstance } : {}),
      }),
    );
    return arr(result['albums'])
      .map((a) => this.toProviderAlbum(rec(a)))
      .filter((a): a is ProviderAlbum => a !== null);
  }

  private toTrackHit(item: Record<string, unknown>): ProviderTrackHit | null {
    const uri = str(item['uri']);
    const title = str(item['name']);
    if (!uri || !title) return null;
    return {
      trackUri: uri,
      title,
      artist: firstArtistName(item),
      album: str(rec(item['album'])['name']) ?? '',
      artworkUrl: this.artworkUrl(item),
    };
  }

  async searchAll(
    query: string,
    limit = 20,
    providerInstance?: string,
  ): Promise<{ albums: ProviderAlbum[]; playlists: ProviderPlaylist[]; tracks: ProviderTrackHit[] }> {
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: ['album', 'playlist', 'track'],
        limit,
        library_only: false,
        ...(providerInstance ? { provider: providerInstance } : {}),
      }),
    );
    return {
      albums: arr(result['albums']).map((a) => this.toProviderAlbum(rec(a))).filter((a): a is ProviderAlbum => a !== null),
      playlists: arr(result['playlists']).map((p) => this.toProviderPlaylist(rec(p))).filter((p): p is ProviderPlaylist => p !== null),
      tracks: arr(result['tracks']).map((t) => this.toTrackHit(rec(t))).filter((t): t is ProviderTrackHit => t !== null),
    };
  }

  /** Connected streaming music sources (e.g. Apple Music accounts) — for searching
      each and labelling results by source. */
  async listMusicProviders(): Promise<Array<{ instanceId: string; name: string }>> {
    const raw = arr(await this.client.command('providers', {}));
    return raw
      .map(rec)
      .filter((p) => p['type'] === 'music' && p['is_streaming_provider'] === true && p['available'] !== false)
      .map((p) => ({ instanceId: str(p['instance_id']) ?? '', name: str(p['name']) ?? 'Music' }))
      .filter((p) => p.instanceId);
  }

  /** The user's saved albums. MA returns `library://album/N` uris (canonical + playable)
      with a provider mapping that tells us the real source instance (which Apple Music
      account, later Spotify, etc.). Paged, and optionally scoped/searched/favorites. */
  async listLibraryAlbums(opts: {
    source?: string;
    search?: string;
    favorite?: boolean;
    limit: number;
    offset: number;
  }): Promise<ProviderLibraryAlbum[]> {
    const raw = arr(
      await this.client.command('music/albums/library_items', {
        limit: opts.limit,
        offset: opts.offset,
        order_by: 'sort_name',
        ...(opts.source ? { provider: opts.source } : {}),
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.favorite ? { favorite: true } : {}),
      }),
    );
    const out: ProviderLibraryAlbum[] = [];
    for (const r of raw) {
      const item = rec(r);
      const base = this.toProviderAlbum(item);
      if (!base) continue;
      const mapping = arr(item['provider_mappings']).map(rec)[0] ?? {};
      out.push({ ...base, sourceInstanceId: str(mapping['provider_instance']) ?? null });
    }
    return out;
  }

  async getAlbum(providerUri: string): Promise<ProviderAlbum | null> {
    const item = rec(await this.client.command('music/item_by_uri', { uri: providerUri }));
    return this.toProviderAlbum(item);
  }

  async getTracks(providerUri: string): Promise<Track[]> {
    const parsed = parseProviderUri(providerUri);
    if (!parsed) return [];
    const cached = this.trackCache.get(providerUri);
    if (cached && Date.now() - cached.at < MusicAssistantProvider.TRACK_TTL_MS) return cached.tracks;
    if (parsed.type === 'playlist') {
      const pl = await this.getPlaylistTracks(parsed.provider, parsed.id);
      this.trackCache.set(providerUri, { tracks: pl, at: Date.now() });
      return pl;
    }
    const raw = await this.client.command('music/albums/album_tracks', {
      item_id: parsed.id,
      provider_instance_id_or_domain: parsed.provider,
      in_library_only: false,
    });
    const tracks = arr(raw).map((t, i): Track => {
      const item = rec(t);
      return {
        index: num(item['track_number']) ?? i + 1,
        title: str(item['name']) ?? `Track ${i + 1}`,
        artist: firstArtistName(item),
        duration: num(item['duration']) ?? null,
        uri: str(item['uri']) ?? null,
      };
    });
    this.trackCache.set(providerUri, { tracks, at: Date.now() });
    return tracks;
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

  async searchPlaylists(query: string, limit = 20): Promise<ProviderPlaylist[]> {
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: ['playlist'],
        limit,
        library_only: false,
      }),
    );
    return arr(result['playlists'])
      .map((p) => this.toProviderPlaylist(rec(p)))
      .filter((p): p is ProviderPlaylist => p !== null);
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
    const idx = opts?.trackIndex ?? 0;
    // Make end-of-queue deterministic regardless of the player's inherited MA settings — flow
    // mode can otherwise re-loop the final track. Fire-and-forget.
    void this.client.command('player_queues/repeat', { queue_id: playerId, repeat_mode: 'off' }).catch(() => {});
    // Whole album from the top: just queue it.
    if (idx <= 0) {
      await this.client.command('player_queues/play_media', { queue_id: playerId, media: providerUri, option: 'replace' });
      return;
    }
    const tracks = await this.getTracks(providerUri).catch((): Track[] => []);
    const startUri = tracks[idx]?.uri;
    if (!startUri) {
      await this.client.command('player_queues/play_media', { queue_id: playerId, media: providerUri, option: 'replace' });
      return;
    }
    // Play the exact tapped track immediately, then append the rest of the album in the
    // background so playback continues. This starts on the right song with NO track-0 blip
    // (unlike play_media(album)+play_index, which lets track 0 sound while the album loads).
    // NB: the "not encoded correctly" Sonos error on resume is an Apple-Music-to-Sonos
    // encoding bug (reproduces from the Music Assistant UI and even the native Sonos app),
    // independent of how we queue — so we keep the faster, blip-free path here.
    await this.client.command('player_queues/play_media', { queue_id: playerId, media: startUri, option: 'replace' });
    const rest = tracks.slice(idx + 1).map((t) => t.uri).filter((u): u is string => !!u);
    if (rest.length)
      void this.client.command('player_queues/play_media', { queue_id: playerId, media: rest, option: 'add' }).catch(() => {});
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
    // The player's OWN state + active source + current media — carries external sources
    // (TV, line-in, AirPlay) that live outside MA's queue, so we can still show what a
    // speaker is playing even when its queue is empty or holds a stale (paused) track.
    const playerById = new Map<string, { state: string; activeSource: string | null; media: Record<string, unknown> | null }>();
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
      playerById.set(id, {
        state: str(item['state']) ?? str(item['playback_state']) ?? 'idle',
        activeSource: str(item['active_source']) ?? null,
        media: item['current_media'] ? rec(item['current_media']) : null,
      });
    }
    // A player's active_source is a queue id (its own, or its group leader's) when it's
    // playing MA content; anything else (e.g. "tv", "line_in") is an EXTERNAL source.
    const queueIds = new Set(playerById.keys());

    return arr(queuesRaw)
      .map((q): PlayerState | null => {
        const queue = rec(q);
        const id = str(queue['queue_id']);
        if (!id) return null;
        const vol = volumeById.get(id) ?? { volume: null, muted: false };
        const current = rec(queue['current_item']);
        const media = rec(current['media_item']);
        const hasNow = str(media['name']) !== undefined || str(current['name']) !== undefined;
        // External source: the SPEAKER is playing something outside MA — TV audio, line-in,
        // AirPlay, Spotify Connect, etc. Detected by active_source not being a queue id
        // (its own or its group leader's). This takes priority over the queue, because a
        // speaker on the TV often still has a stale (paused) track sitting in its queue —
        // we must show the TV, not that leftover song.
        {
          const pi = playerById.get(id);
          const m = pi?.media ?? null;
          const extTitle = m ? str(m['title']) : undefined;
          const onExternal = !!pi?.activeSource && !queueIds.has(pi.activeSource);
          if (pi && onExternal && extTitle && (pi.state === 'playing' || pi.state === 'paused')) {
            return {
              playerId: id,
              state: pi.state === 'paused' ? 'paused' : 'playing',
              volume: vol.volume,
              muted: vol.muted,
              groupLeader: groupLeaderById.get(id) ?? id,
              nowPlaying: {
                albumId: null,
                albumUri: null,
                title: extTitle,
                artist: (m && str(m['artist'])) ?? null,
                album: (m && str(m['album'])) ?? null,
                trackIndex: null,
                trackUri: null,
                duration: (m && num(m['duration'])) ?? null,
                elapsed: (m && num(m['elapsed_time'])) ?? null,
                artworkUrl: (m && str(m['image_url'])) ?? null,
              },
            };
          }
        }
        // Some players (e.g. Sonos via MA) report a *paused* queue as 'idle' while
        // keeping the loaded track — treat "idle with a current item" as paused so it
        // stays resumable and survives a reload, instead of reading as "nothing playing".
        const rawState = mapPlaybackState(str(queue['state']));
        return {
          playerId: id,
          state: rawState === 'idle' && hasNow ? 'paused' : rawState,
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
                trackUri: str(media['uri']) ?? str(current['uri']) ?? null,
                duration: num(current['duration']) ?? num(media['duration']) ?? null,
                elapsed: num(queue['elapsed_time']) ?? null,
                artworkUrl: this.artworkUrl(media) ?? this.artworkUrl(current) ?? this.artworkUrl(rec(media['album'])),
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

  /** Fires (debounced) when the player roster/metadata changes — added, removed,
      or renamed in Music Assistant. */
  onPlayersChanged(cb: () => void): () => void {
    let deb: ReturnType<typeof setTimeout> | undefined;
    const relevant = new Set(['player_added', 'player_removed', 'player_updated']);
    return this.client.onEvent((e: MaEvent) => {
      if (!relevant.has(e.event)) return;
      if (deb) clearTimeout(deb);
      deb = setTimeout(cb, 800);
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
