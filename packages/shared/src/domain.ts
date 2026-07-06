/** Core domain types shared across the device service, shelf, and admin. */

export type MediaKind = 'album' | 'playlist';

/** Extracted artwork palette (§4). Colors are `#rrggbb`. */
export interface Palette {
  dominant: string;
  muted: string;
  dark: string;
  light: string;
  /** Label ink color chosen from dominant luminance (prototype `pickInk`). */
  ink: InkColor;
}

export type InkColor = 'light' | 'dark';

export interface Album {
  /** Stable internal id (Crate's own, not the provider's). */
  id: string;
  /** Provider playback ref, e.g. `apple_music://album/594061854`. */
  providerUri: string;
  provider: string;
  title: string;
  artist: string;
  year: number | null;
  /** Remote artwork URL (from the provider / MA). */
  artworkUrl: string | null;
  /** Locally cached rendition path served by the device service, if built. */
  artworkPath: string | null;
  palette: Palette | null;
  addedAt: string;
  playCount: number;
}

export interface Track {
  index: number;
  title: string;
  artist: string;
  duration: number | null;
  uri: string | null;
}

export type PlayerType = 'sonos' | 'homepod' | 'airplay' | 'cast' | 'web' | 'other';

export interface Player {
  /** Provider player id (the Sonos RINCON uuid for Sonos players). */
  id: string;
  name: string;
  type: PlayerType;
  isDefault: boolean;
  displayOrder: number;
  available: boolean;
}

export type PlaybackState = 'playing' | 'paused' | 'idle' | 'unknown';

export interface NowPlaying {
  /** Resolved Crate album id if this maps to a shelf album, else null. */
  albumId: string | null;
  /** Provider album uri if known (for robust shelf matching), else null. */
  albumUri: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  trackIndex: number | null;
  duration: number | null;
  elapsed: number | null;
}

export interface PlayerState {
  playerId: string;
  state: PlaybackState;
  volume: number | null;
  muted: boolean;
  nowPlaying: NowPlaying | null;
}

/** Everything the shelf needs to render one spine (derived from Album + palette). */
export interface ShelfItem {
  albumId: string;
  kind: MediaKind;
  title: string;
  artist: string;
  /** Release year, for the spine catalog imprint. Null when unknown. */
  year: number | null;
  order: number;
  stackId: string | null;
  /** Spine gradient endpoints (`#rrggbb`). */
  primaryColor: string;
  darkColor: string;
  inkColor: InkColor;
  /** Base spine width in px (UI scales it); mirrors the prototype's per-album width. */
  spineWidth: number;
  /** Pre-rendered blurred art strip for spineMode `art`, else null. */
  spineStripUrl: string | null;
  /** Real spine scan (MusicBrainz CAA) for spineMode `scan`, else null. */
  spineScanUrl: string | null;
  /** User-uploaded spine image (per-album override) — wins over everything. */
  customSpineUrl: string | null;
  /** Per-album label overrides (null = use the generated defaults). */
  labelFont: string | null;
  labelTracking: string | null;
  artistColor: string | null;
  titleColor: string | null;
  /** Cover artwork URL (local cached path preferred, else remote). */
  artworkUrl: string | null;
}

export interface Stack {
  id: string;
  name: string;
  order: number;
}

export type SpineMode = 'palette' | 'art' | 'scan';
export type LabelStyle = 'uniform' | 'collected' | 'eclectic';
export type OpenMode = 'cover' | 'card';
export type SortBy = 'artist' | 'title' | 'added' | 'played' | 'year' | 'color';
export type SpineThickness = 'thin' | 'medium' | 'thick';
/** Spine text reading direction: top→bottom or bottom→top (classic US CD spine). */
export type SpineTextDir = 'ttb' | 'btt';
/** What happens to the open album after you hit play. */
export type AfterPlay = 'close' | 'linger' | 'stay';
/** Label ink strategy: guaranteed-contrast (white/black) vs match the album accent. */
export type InkMode = 'contrast' | 'match';

/** Per-album manual overrides (admin), all optional. */
export interface AlbumOverride {
  spinePath?: string | null;
  coverPath?: string | null;
  font?: string | null;
  tracking?: string | null;
  artistColor?: string | null;
  titleColor?: string | null;
}

export interface Settings {
  labelStyle: LabelStyle;
  openMode: OpenMode;
  spineMode: SpineMode;
  spineThickness: SpineThickness;
  spineTextDir: SpineTextDir;
  inkMode: InkMode;
  sortBy: SortBy;
  defaultPlayerId: string | null;
  longPressMs: number;
  afterPlay: AfterPlay;
  /** Seconds the card lingers before closing when afterPlay is 'linger'. */
  afterPlayLingerSec: number;
  idleAutoOpen: boolean;
  idleMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  labelStyle: 'uniform',
  openMode: 'cover',
  spineMode: 'art',
  spineThickness: 'medium',
  spineTextDir: 'ttb',
  inkMode: 'contrast',
  sortBy: 'artist',
  defaultPlayerId: null,
  longPressMs: 420,
  afterPlay: 'linger',
  afterPlayLingerSec: 8,
  idleAutoOpen: true,
  idleMinutes: 5,
};
