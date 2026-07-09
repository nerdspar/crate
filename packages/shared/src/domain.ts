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
  /** Explicit content: true/false, or null/undefined when the provider doesn't say. */
  explicit?: boolean | null;
  /** For playlist tracks: the provider uri of the track's album, so tapping a
      song can open its album with the track cued. Null for plain album tracks. */
  albumUri?: string | null;
}

export type PlayerType = 'sonos' | 'homepod' | 'airplay' | 'cast' | 'web' | 'other';

/** Player types that are real audio outputs — shown on the wall by default (web
    browsers / computers are hidden unless the admin explicitly exposes them). */
export const SPEAKER_TYPES: readonly PlayerType[] = ['sonos', 'homepod', 'airplay', 'cast'];
export function isSpeaker(type: PlayerType): boolean {
  return SPEAKER_TYPES.includes(type);
}

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
  /** Provider uri of the current track — lets the UI highlight the right row even when
      the queue index differs from the displayed track order (MA reorders on start_item). */
  trackUri: string | null;
  duration: number | null;
  elapsed: number | null;
  /** Cover art for the now-playing item (so the CC hero can show any room's
      content, even one not on the current shelf). */
  artworkUrl: string | null;
}

export interface PlayerState {
  playerId: string;
  state: PlaybackState;
  volume: number | null;
  muted: boolean;
  nowPlaying: NowPlaying | null;
  /** The player this one is synced to (its group leader). A solo player points
      to itself; players sharing a leader form a group. Derived from MA state. */
  groupLeader: string | null;
}

/** Everything the shelf needs to render one spine (derived from Album + palette). */
export interface ShelfItem {
  albumId: string;
  /** Provider uri of the album (for opening the play-now overlay off a search match). */
  providerUri: string | null;
  kind: MediaKind;
  title: string;
  artist: string;
  /** Release year, for the spine catalog imprint. Null when unknown. */
  year: number | null;
  order: number;
  stackId: string | null;
  /** ISO timestamp the album was shelved (for the 'added' sort). */
  addedAt: string;
  /** Lifetime play count (for the 'played' sort). */
  playCount: number;
  /** Spine gradient endpoints (`#rrggbb`). */
  primaryColor: string;
  darkColor: string;
  inkColor: InkColor;
  /** Base spine width in px (UI scales it); mirrors the prototype's per-album width. */
  spineWidth: number;
  /** Total album runtime in seconds (sum of track durations), or null if unknown.
      Drives duration-scaled spine widths when spineWidthMode is 'duration'. */
  durationSec: number | null;
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
  /** Per-album overrides (null = inherit the global setting). Year position is
      global-only, so it isn't here. */
  overrideSpineMode: SpineMode | null;
  overrideLayout: LabelLayoutFixed | null;
  overrideYearDisplay: YearDisplay | null;
  overrideInkSize: InkSize | null;
  overrideInkWeight: InkWeight | null;
  /** Cover artwork URL (local cached path preferred, else remote). */
  artworkUrl: string | null;
  /** Playlist song-spine only (single-playlist shelf): the provider uri of the
      song's album to open, and which track to cue, when the spine is tapped.
      Absent on album spines and playlist-case spines. */
  albumUri?: string | null;
  trackIndex?: number | null;
}

export interface Stack {
  id: string;
  name: string;
  order: number;
}

/** A shelf holds albums or playlists (never mixed). "All" is the virtual shelf
    of every album (id 'all'). */
export type ShelfKind = 'album' | 'playlist';
export interface Shelf {
  id: string;
  name: string;
  kind: ShelfKind;
  order: number;
}

export type SpineMode = 'palette' | 'art' | 'scan';
/** How the artist + title sit along the spine. 'varied' = random per album. */
export type LabelLayout = 'split' | 'center' | 'top' | 'bottom' | 'varied';
/** Whether every spine shares one type style or varies per artist. */
export type LabelVary = 'uniform' | 'varied';
export type OpenMode = 'cover' | 'card';
/** What a two-finger pinch on the shelf does: resize the spines (density), pop a
    magnifier loupe over them, or nothing. */
export type PinchZoom = 'spines' | 'loupe' | 'off';
export type SortBy = 'artist' | 'title' | 'added' | 'played' | 'year' | 'color' | 'custom';
export type SpineThickness = 'thin' | 'medium' | 'thick';
/** How spine widths are sized: one uniform CD width, or scaled by album runtime
    (a 78-min double album is visibly fatter than a 34-min record). */
export type SpineWidthMode = 'uniform' | 'duration';
/** Spine text reading direction: top→bottom or bottom→top (classic US CD spine). */
export type SpineTextDir = 'ttb' | 'btt';
/** What happens to the open album after you hit play. */
export type AfterPlay = 'close' | 'linger' | 'stay';
/** Unified idle / presence / sleep (§7). Timer + schedule work today; the sensor +
    ambient-light options are wired but dormant until that hardware exists. */
export type IdleScreen = 'on' | 'dim' | 'off'; // what the display does when idle
export type IdleContent = 'nothing' | 'nowPlaying' | 'currentShelf' | 'shelf' | 'autoOpen'; // what it shows
// 'currentShelf' = close any open album, stay on whatever shelf is showing; 'shelf' = jump to a chosen one
export type AutoOpenPool = 'all' | 'current' | 'shelf';
/** One weekday's lights-out window (index 0 = Sunday). */
export interface DaySchedule {
  on: boolean;
  sleep: string; // 'HH:MM'
  wake: string; // 'HH:MM'
}
/** Label ink strategy: guaranteed-contrast (white/black) vs match the album accent. */
export type InkMode = 'contrast' | 'match';
/** Global scale for the spine-label text size. */
export type InkSize = 'small' | 'medium' | 'large';
/** Global adjustment to the spine-label font weight. */
export type InkWeight = 'light' | 'regular' | 'bold';
/** Album-open ambient glow: how far the halo spreads / how bright it is. */
export type GlowRadius = 'small' | 'medium' | 'large';
export type GlowIntensity = 'soft' | 'medium' | 'bold';
/** Album-year catalog imprint: hidden, or shown vertical/horizontal. */
export type YearDisplay = 'off' | 'vertical' | 'horizontal';
/** Which end of the spine the year imprint sits at. */
export type YearPos = 'top' | 'bottom';
/** Year imprint legibility: 'thin' = the faint ported catalog stamp; 'bold' =
    larger and more opaque, readable from across the room on a wall kiosk. */
export type YearEmphasis = 'thin' | 'bold';

/** A concrete label layout (per-album; no 'varied'). */
export type LabelLayoutFixed = 'split' | 'center' | 'top' | 'bottom';

/** Per-album manual overrides (admin), all optional; null/absent = inherit global.
    Year *position* is intentionally global-only (drives the shared gutter). */
export interface AlbumOverride {
  spinePath?: string | null;
  coverPath?: string | null;
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

/** A named speaker group the wall offers as a one-tap chip in the play-target picker. */
export interface GroupPreset {
  id: string;
  name: string;
  /** Player ids that form this group (leader = the first one). */
  playerIds: string[];
}

export interface Settings {
  labelLayout: LabelLayout;
  labelVary: LabelVary;
  openMode: OpenMode;
  spineMode: SpineMode;
  spineThickness: SpineThickness;
  spineWidthMode: SpineWidthMode;
  spineTextDir: SpineTextDir;
  inkMode: InkMode;
  inkSize: InkSize;
  inkWeight: InkWeight;
  /** Ambient halo behind an opened album's cover. */
  glowEnabled: boolean;
  glowRadius: GlowRadius;
  glowIntensity: GlowIntensity;
  yearDisplay: YearDisplay;
  yearPos: YearPos;
  yearEmphasis: YearEmphasis;
  sortBy: SortBy;
  defaultPlayerId: string | null;
  longPressMs: number;
  afterPlay: AfterPlay;
  /** Seconds the card lingers before closing when afterPlay is 'linger'. */
  afterPlayLingerSec: number;

  // --- Idle / presence / sleep (unified §7) ---
  /** Go idle after this many minutes of no touch (0 = never). */
  idleAfterMin: number;
  /** Also trigger idle from the proximity sensor seeing nobody (inert until hardware). */
  idleUseSensor: boolean;
  /** What the display does when idle. */
  idleScreen: IdleScreen;
  /** Brightness % when idleScreen is 'dim'. */
  idleDimPercent: number;
  /** What the shelf shows when idle. */
  idleContent: IdleContent;
  /** Shelf id for idleContent 'shelf' (and autoOpen pool 'shelf'); null = All. */
  idleShelf: string | null;
  /** Auto-open (attract) cadence, source pool, and order. */
  autoOpenEverySec: number;
  autoOpenPool: AutoOpenPool;
  autoOpenRandom: boolean;
  /** Wake from the proximity sensor too (touch always wakes). Inert until hardware. */
  wakeOnSensor: boolean;
  /** Drive brightness from an ambient-light sensor (inert until hardware). */
  autoBrightness: boolean;
  /** When playback starts from outside Crate, flip that album open (then follow the idle
      rules; suppressed while the wall is in active use or in the sleep window). */
  openOnExternalPlay: boolean;
  /** Per-weekday lights-out windows (index 0 = Sunday). */
  sleepSchedule: DaySchedule[];

  // --- Players (chunk D) ---
  /** Named speaker groups offered as one-tap chips in the play-target picker. */
  groupPresets: GroupPreset[];
  /** Player ids the wall may target/show; null or empty = expose every player. */
  exposedPlayers: string[] | null;
  /** What a two-finger pinch does on the shelf. */
  pinchZoom: PinchZoom;
}

export const DEFAULT_SETTINGS: Settings = {
  labelLayout: 'center',
  labelVary: 'uniform',
  openMode: 'cover',
  spineMode: 'art',
  spineThickness: 'medium',
  spineWidthMode: 'uniform',
  spineTextDir: 'ttb',
  inkMode: 'contrast',
  inkSize: 'medium',
  inkWeight: 'regular',
  glowEnabled: true,
  glowRadius: 'medium',
  glowIntensity: 'medium',
  yearDisplay: 'vertical',
  yearPos: 'bottom',
  yearEmphasis: 'thin',
  sortBy: 'artist',
  defaultPlayerId: null,
  longPressMs: 420,
  afterPlay: 'linger',
  afterPlayLingerSec: 8,
  idleAfterMin: 5,
  idleUseSensor: false,
  idleScreen: 'dim',
  idleDimPercent: 20,
  idleContent: 'nowPlaying',
  idleShelf: null,
  autoOpenEverySec: 25,
  autoOpenPool: 'all',
  autoOpenRandom: true,
  wakeOnSensor: false,
  autoBrightness: false,
  openOnExternalPlay: false,
  sleepSchedule: [0, 1, 2, 3, 4, 5, 6].map(() => ({ on: false, sleep: '23:00', wake: '07:00' })),
  groupPresets: [],
  exposedPlayers: null,
  pinchZoom: 'spines',
};
