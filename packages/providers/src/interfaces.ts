/** Provider interfaces (§3), adapted to what the device service needs in Phase 1. */

import type { PlayerState, PlayerType, RepeatMode, Track } from '@crate/shared';

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
  /** Saved in the user's provider library (MA "favorite") — distinguishes a
      library album from a catalog-only search hit. */
  inLibrary: boolean;
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
  explicit: boolean | null;
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

export interface ProviderArtist {
  /** Provider artist ref, e.g. `apple_music://artist/158038`. */
  providerUri: string;
  provider: string;
  name: string;
  artworkUrl: string | null;
}

/** A browsable extra-media item — radio station, podcast, or audiobook. Radio is a live
    stream; a podcast is a container (fetch its episodes); an audiobook plays directly. */
export interface ProviderMediaItem {
  /** Provider playback ref, e.g. `library://radio/1`, `spotify://podcast/…`, `…://audiobook/…`. */
  providerUri: string;
  provider: string;
  name: string;
  /** Second line — station tagline, podcast publisher, or audiobook author(s); null if none. */
  description: string | null;
  /** Full description/blurb (audiobook synopsis, podcast about); absent when it would just
      repeat the second line. Shown behind an expander on the card. */
  about?: string | null;
  artworkUrl: string | null;
  /** Runtime in seconds (audiobooks/episodes); null for radio. */
  durationSec?: number | null;
  /** Playback progress into the item, ms; null/0 if unstarted (spoken-word kinds). */
  resumeMs?: number | null;
  /** True once finished (MA's `fully_played`). */
  fullyPlayed?: boolean;
  /** Audiobook chapter markers, in order; absent for other kinds. */
  chapters?: ProviderChapter[];
}
/** @deprecated alias — radio is now one `ProviderMediaItem` kind. */
export type ProviderRadio = ProviderMediaItem;

/** One audiobook chapter — a labelled seek offset (MA `metadata.chapters`). */
export interface ProviderChapter {
  title: string;
  /** Chapter start offset, in seconds. */
  startSec: number;
}

/** One podcast episode (a playable child of a podcast container). */
export interface ProviderEpisode {
  trackUri: string;
  title: string;
  durationSec: number | null;
  subtitle: string | null;
  /** Episode release date (ISO), or null. */
  releaseDate: string | null;
  /** Playback progress into the episode, ms; null if unstarted. */
  resumeMs: number | null;
  /** True once finished. */
  fullyPlayed: boolean;
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
  /** Global search: artists, albums, playlists and tracks in one call (optionally scoped). */
  searchAll(
    query: string,
    limit?: number,
    providerInstance?: string,
  ): Promise<{ artists: ProviderArtist[]; albums: ProviderAlbum[]; playlists: ProviderPlaylist[]; tracks: ProviderTrackHit[] }>;
  /** An artist's albums (fast) and their top tracks (slow first call — cache upstream). */
  getArtistAlbums(providerUri: string): Promise<ProviderAlbum[]>;
  getArtistTopTracks(providerUri: string): Promise<ProviderTrackHit[]>;
  /** Connected streaming music sources, for per-source search. */
  listMusicProviders(): Promise<Array<{ instanceId: string; name: string; domain: string; iconSvg: string | null; features: string[] }>>;
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
  playTracks(playerId: string, trackUris: string[]): Promise<void>;
  transport(playerId: string, cmd: TransportCommand, positionSec?: number): Promise<void>;
  setVolume(playerId: string, level: number): Promise<void>;
  setMembers(targetPlayerId: string, add: string[], remove: string[]): Promise<void>;
  setShuffle(playerId: string, enabled: boolean): Promise<void>;
  setRepeat(playerId: string, mode: RepeatMode): Promise<void>;
  getState(): Promise<PlayerState[]>;
  /** Subscribe to live player/queue state. Returns an unsubscribe fn. */
  onState(cb: (states: PlayerState[]) => void): () => void;
}
