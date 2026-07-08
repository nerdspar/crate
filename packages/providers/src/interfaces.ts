/** Provider interfaces (§3), adapted to what the device service needs in Phase 1. */

import type { PlayerState, PlayerType, Track } from '@crate/shared';

export interface ProviderAlbum {
  /** Provider playback ref, e.g. `apple_music://album/594061854`. */
  providerUri: string;
  provider: string;
  title: string;
  artist: string;
  year: number | null;
  artworkUrl: string | null;
  /** Edition/version label from the provider (e.g. "Deluxe Edition", "Taylor's Version"), else null. */
  version: string | null;
  /** Explicit content: true/false, or null when the provider doesn't say. */
  explicit: boolean | null;
}

export interface ProviderLibraryAlbum extends ProviderAlbum {
  /** Streaming provider instance the album is saved under (e.g. a specific Apple
      Music account), from its MA provider mapping. Null if unknown. */
  sourceInstanceId: string | null;
}

export interface ProviderTrackHit {
  /** Resolvable provider track uri (album ref from search is name-based/unresolvable). */
  trackUri: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

export interface ProviderPlaylist {
  /** Provider playback ref, e.g. `library://playlist/9`. */
  providerUri: string;
  provider: string;
  name: string;
  /** Playlist curator/owner (shown where an album shows the artist). */
  owner: string | null;
  artworkUrl: string | null;
}

export interface ProviderPlayer {
  id: string;
  name: string;
  type: PlayerType;
  available: boolean;
  /** MA provider lookup key (e.g. "sonos"). */
  provider: string;
}

export type TransportCommand = 'play' | 'pause' | 'next' | 'previous' | 'seek';

/** A music metadata/catalog source (search, album, tracks). */
export interface MusicSource {
  readonly id: string;
  search(query: string, limit?: number, providerInstance?: string): Promise<ProviderAlbum[]>;
  /** Global search: albums, playlists and tracks in one call (optionally scoped). */
  searchAll(
    query: string,
    limit?: number,
    providerInstance?: string,
  ): Promise<{ albums: ProviderAlbum[]; playlists: ProviderPlaylist[]; tracks: ProviderTrackHit[] }>;
  /** Connected streaming music sources, for per-source search. */
  listMusicProviders(): Promise<Array<{ instanceId: string; name: string }>>;
  getAlbum(providerUri: string): Promise<ProviderAlbum | null>;
  getTracks(providerUri: string): Promise<Track[]>;
  /** The user's saved albums (library), optionally scoped to one source / filtered
      to favorites / text-searched, paged via limit+offset. */
  listLibraryAlbums(opts: {
    source?: string;
    search?: string;
    favorite?: boolean;
    limit: number;
    offset: number;
  }): Promise<ProviderLibraryAlbum[]>;
  /** The user's saved playlists (Apple Music library + MA-local), for the add picker. */
  listLibraryPlaylists(limit?: number): Promise<ProviderPlaylist[]>;
  /** Search playlists (library + provider-curated, e.g. Apple Music editorial). */
  searchPlaylists(query: string, limit?: number): Promise<ProviderPlaylist[]>;
  /** Resolve one playlist (title, curator, artwork) for ingestion. */
  getPlaylist(providerUri: string): Promise<ProviderPlaylist | null>;
}

/** A playback target (players, play, transport, volume, grouping, live state). */
export interface PlayerTarget {
  readonly id: string;
  listPlayers(): Promise<ProviderPlayer[]>;
  play(playerId: string, providerUri: string, opts?: { trackIndex?: number }): Promise<void>;
  transport(playerId: string, cmd: TransportCommand, positionSec?: number): Promise<void>;
  setVolume(playerId: string, level: number): Promise<void>;
  setMembers(targetPlayerId: string, add: string[], remove: string[]): Promise<void>;
  getState(): Promise<PlayerState[]>;
  /** Subscribe to live player/queue state. Returns an unsubscribe fn. */
  onState(cb: (states: PlayerState[]) => void): () => void;
}
