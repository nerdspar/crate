/** REST + WebSocket contract between the device service and the frontends (§9). */

import type {
  Album,
  AlbumOverride,
  InkSize,
  InkWeight,
  LabelLayoutFixed,
  Player,
  PlayerState,
  Settings,
  Shelf,
  ShelfItem,
  ShelfKind,
  SpineMode,
  Stack,
  Track,
  YearDisplay,
} from './domain.js';

export interface AlbumDetail {
  album: Album;
  tracks: Track[];
  override: AlbumOverride;
}

/** Per-album label override (uploads go through a separate multipart endpoint). */
export interface OverrideRequest {
  spineMode?: SpineMode | null;
  font?: string | null;
  tracking?: string | null;
  artistColor?: string | null;
  titleColor?: string | null;
  layout?: LabelLayoutFixed | null;
  yearDisplay?: YearDisplay | null;
  size?: InkSize | null;
  weight?: InkWeight | null;
}

export interface ShelfResponse {
  items: ShelfItem[];
  stacks: Stack[];
  shelves: Shelf[];
}

export interface CreateShelfRequest {
  name: string;
  kind?: ShelfKind;
}
export interface ShelfAlbumRequest {
  albumId: string;
}

/** How the panel backlight is driven, in the plan's fallback order (§7). */
export type BrightnessMethod = 'ddcutil' | 'sysfs' | 'software';

/** Appliance/display state for the control center's system rows. */
export interface SystemStatus {
  /** 0–100. When method is 'software' the client applies a dim overlay. */
  brightness: number;
  brightnessMethod: BrightnessMethod;
  displayAsleep: boolean;
  /** LAN IPv4 of the device, or null if it can't be determined. */
  ip: string | null;
  /** True on the kiosk appliance, where restart/reboot actually work. */
  appliance: boolean;
  version: string;
}

export interface BrightnessRequest {
  /** 0–100. */
  level: number;
}

export interface PlayRequest {
  albumId: string;
  trackIndex?: number;
  playerId?: string;
  /** Off-shelf album to play by provider uri (a song tapped in a playlist song
      view). When set, albumId is ignored server-side. */
  providerUri?: string;
}

/** Detail for an off-shelf provider album (song→album card; not ingested). */
export interface ProviderAlbumDetail {
  providerUri: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  tracks: Track[];
  /** 0-based album track index the source song maps to, or -1 if unknown. */
  cueIndex: number;
  /** True if this album is already in the library (→ offer "Open on shelf"). */
  onShelf: boolean;
}

export type TransportCmd = 'play' | 'pause' | 'next' | 'previous' | 'seek';

export interface TransportRequest {
  playerId: string;
  cmd: TransportCmd;
  position?: number;
}

export interface VolumeRequest {
  playerId: string;
  level: number;
}

export interface GroupRequest {
  playerIds: string[];
}

/** A search hit (from the provider via MA), plus whether it's already shelved. */
export interface SearchAlbum {
  providerUri: string;
  provider: string;
  title: string;
  artist: string;
  year: number | null;
  artworkUrl: string | null;
  onShelf: boolean;
  /** Crate album id when already shelved (for managing / removing from search), else null. */
  albumId: string | null;
  /** Edition label (e.g. "Deluxe Edition") to tell identical-looking versions apart; null if none. */
  version: string | null;
  /** Explicit content: true/false, or null when unknown. */
  explicit: boolean | null;
  /** Saved in the user's provider library — separates a library hit from a catalog-only one. */
  inLibrary: boolean;
  /** Display name of the streaming source this hit came from (e.g. "Apple Music").
      For grouping results by source when several accounts/services are connected. */
  source: string;
}

export interface AddToShelfRequest {
  providerUri: string;
  /** Also add the album to this named shelf (besides the library). Omit/'all' = library only. */
  shelfId?: string;
}

/** A song hit from global search — tapping opens its album with the track cued. */
export interface SearchSong {
  /** Resolvable provider track uri (e.g. apple_music://track/123) → album + index. */
  trackUri: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  /** Explicit content: true/false, or null when unknown. */
  explicit: boolean | null;
  source: string;
}

/** An artist hit from global search — tapping opens the artist's albums + top songs. */
export interface SearchArtist {
  /** Provider artist ref, e.g. `apple_music://artist/158038`. */
  providerUri: string;
  provider: string;
  name: string;
  artworkUrl: string | null;
  source: string;
}

/** A connected streaming music source (for the search source dropdown). */
export interface MusicSourceInfo {
  instanceId: string;
  name: string;
}

/** An album from the user's provider library (Apple Music, etc.), plus whether it's
    already on a Crate shelf. `providerUri` is MA's canonical `library://album/N`. */
export interface LibraryAlbum {
  providerUri: string;
  title: string;
  artist: string;
  year: number | null;
  artworkUrl: string | null;
  onShelf: boolean;
  /** Crate album id when it's already shelved (for managing shelves / removing), else null. */
  albumId: string | null;
  /** Edition label (e.g. "Deluxe Edition"); null if none. */
  version: string | null;
  /** Explicit content: true/false, or null when unknown. */
  explicit: boolean | null;
  /** Display name of the source this album is saved under (e.g. "Apple Music"). */
  source: string;
  /** The source's provider-instance id (for scoping/filtering); null if unknown. */
  sourceInstanceId: string | null;
}

/** A page of library albums for the admin's "Add from library" browser. */
export interface LibraryAlbumsResponse {
  items: LibraryAlbum[];
  offset: number;
  /** True when another page likely exists (this page filled the requested limit). */
  hasMore: boolean;
  /** Connected sources, for the source filter. */
  sources: MusicSourceInfo[];
}

/** Result of bulk-importing a whole library (optionally one source). */
export interface LibraryImportResult {
  added: number;
  skipped: number;
  total: number;
}

/** Sonos-style global search: albums, playlists and songs at once, plus the list
    of connected sources for the dropdown. */
export interface GlobalSearchResponse {
  artists: SearchArtist[];
  albums: SearchAlbum[];
  playlists: LibraryPlaylist[];
  songs: SearchSong[];
  sources: MusicSourceInfo[];
}

/** A saved playlist from the provider library, plus whether it's already added. */
export interface LibraryPlaylist {
  providerUri: string;
  provider: string;
  name: string;
  owner: string | null;
  artworkUrl: string | null;
  onShelf: boolean;
  /** Streaming source display name (global search); optional elsewhere. */
  source?: string;
}

export interface AddPlaylistRequest {
  providerUri: string;
}

export interface PlayersResponse {
  players: Player[];
  state: PlayerState[];
}

/** Server → client push messages on `/ws`. */
export type WsMessage =
  | { type: 'state'; state: PlayerState[] }
  | { type: 'progress'; playerId: string; elapsed: number }
  | { type: 'shelf' }
  | { type: 'shelves' }
  | { type: 'players' }
  | { type: 'sync'; progress: number; message: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'system'; status: SystemStatus };
