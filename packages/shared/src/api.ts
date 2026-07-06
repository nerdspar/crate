/** REST + WebSocket contract between the device service and the frontends (§9). */

import type {
  Album,
  AlbumOverride,
  Player,
  PlayerState,
  Settings,
  ShelfItem,
  Stack,
  Track,
} from './domain.js';

export interface AlbumDetail {
  album: Album;
  tracks: Track[];
  override: AlbumOverride;
}

/** Per-album label override (uploads go through a separate multipart endpoint). */
export interface OverrideRequest {
  font?: string | null;
  tracking?: string | null;
  artistColor?: string | null;
  titleColor?: string | null;
}

export interface ShelfResponse {
  items: ShelfItem[];
  stacks: Stack[];
}

export interface PlayRequest {
  albumId: string;
  trackIndex?: number;
  playerId?: string;
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
  | { type: 'players' }
  | { type: 'sync'; progress: number; message: string }
  | { type: 'settings'; settings: Settings };
