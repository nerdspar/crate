/** REST + WebSocket contract between the device service and the frontends (§9). */

import type {
  Album,
  AlbumOverride,
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
}

export interface AddToShelfRequest {
  providerUri: string;
  /** Also add the album to this named shelf (besides the library). Omit/'all' = library only. */
  shelfId?: string;
}

/** A saved playlist from the provider library, plus whether it's already added. */
export interface LibraryPlaylist {
  providerUri: string;
  provider: string;
  name: string;
  owner: string | null;
  artworkUrl: string | null;
  onShelf: boolean;
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
