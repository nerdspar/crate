/** REST + WebSocket contract between the device service and the frontends (§9). */

import type {
  Album,
  AlbumOverride,
  ExtraMediaKind,
  InkSize,
  InkWeight,
  LabelLayoutFixed,
  Player,
  PlayerState,
  RepeatMode,
  Settings,
  Shelf,
  ShelfItem,
  ShelfKind,
  SourceKinds,
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
  /** Which extra media kinds a connected source can serve (radio/podcast/audiobook) — the
      front-ends reveal each tab only when its kind is true (and not hidden in settings). */
  sourceKinds: SourceKinds;
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

/** Health of one Crate service (the three apps + Music Assistant) for the System view. */
export interface ServiceHealth {
  id: 'server' | 'shelf' | 'admin' | 'musicAssistant';
  name: string;
  /** Alive & serving: the server if responding, a front-end if the server serves its
      bundle (they have no process of their own), MA if its websocket is up. */
  online: boolean;
  /** Live `/ws` client count for this app — informational, separate from `online`. */
  connections?: number;
  /** Short context: uptime, version, served/built state, etc. */
  detail?: string;
  /** Whether this service can be restarted from a client (server: appliance only;
      front-ends: reload their clients; MA: reconnect its websocket). */
  restartable?: boolean;
}
export interface ServicesStatus {
  services: ServiceHealth[];
}

/** Software-update status for Settings → System. `current`/`latest` are short git
    SHAs of the checkout and its upstream tip; `updateAvailable` means it's behind.
    Updates only actually run on the appliance. */
export interface UpdateStatus {
  /** Running Crate's short git SHA, or the version string if it isn't a checkout. */
  current: string;
  /** Upstream (GitHub) tip short SHA after a fetch — Crate has no releases/tags. */
  latest: string | null;
  updateAvailable: boolean;
  behind: number;
  /** Crate's declared version (CRATE_VERSION, e.g. "0.1.0"), for a human-readable line. */
  crateVersion: string;
  /** True when Crate co-hosts Music Assistant, so it can update that container too. */
  managesMa: boolean;
  /** Running MA server version, if connected. */
  maVersion: string | null;
  /** Latest MA server version on GitHub (releases/latest), or null if unreachable. */
  maLatest: string | null;
  /** True when maLatest is newer than the running maVersion. */
  maUpdateAvailable: boolean;
  appliance: boolean;
  /** Set when the git check itself failed (offline, no git, container deploy, etc.). */
  error: string | null;
}

/** What to update: Crate, the co-hosted Music Assistant, or both. */
export type UpdateTarget = 'crate' | 'ma' | 'both';

/** Live progress of an in-flight update: whether the crate-update unit is still running,
    plus the tail of its journal so the admin can show what's happening. */
export interface UpdateProgress {
  active: boolean;
  log: string[];
}

/** Unattended-update behavior: 'off' never checks; 'notify' checks + flags a waiting update
    in the admin; 'install' downloads, applies and restarts on its own. Crate only (MA stays
    manual). */
export type AutoUpdateMode = 'off' | 'notify' | 'install';
export type AutoUpdateFrequency = 'daily' | 'weekly';

/** Scheduled auto-update config (mirrors the GitHub auto-backup config). Runs at `hour` (0–23,
    device-local) on the chosen cadence — a quiet hour, since an install restarts the wall. */
export interface AutoUpdateConfig {
  mode: AutoUpdateMode;
  frequency: AutoUpdateFrequency;
  hour: number;
  /** ISO time of the last scheduled check, or null. */
  lastCheckAt: string | null;
  /** ISO time the next scheduled check is due, or null when off. */
  nextRunAt: string | null;
  /** One-line result of the last check (e.g. "Up to date", "Installing update…"). */
  lastStatus: string | null;
  /** Notify-mode: an update was found and is waiting for a manual install. */
  pending: boolean;
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
  /** An explicit ordered list of track uris to play as the queue (a song tapped in
      a playlist shelf → the playlist continues in the shelf's curated order). When
      set, albumId/providerUri are ignored. */
  trackUris?: string[];
  /** Seek here (seconds) right after playback starts — used to start an audiobook/episode
      over (position 1) or jump to a chapter. Omit to let MA auto-resume from its saved spot. */
  position?: number;
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
  /** Display name of the source this album is from (e.g. "Apple Music", "Spotify"). */
  source: string;
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

export interface ShuffleRequest {
  playerId: string;
  enabled: boolean;
}

export interface RepeatRequest {
  playerId: string;
  mode: RepeatMode;
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

/** A connected streaming music source (for the search source dropdown + result badges). */
export interface MusicSourceInfo {
  instanceId: string;
  name: string;
  /** Provider domain (e.g. "apple_music") — the granularity results are attributed at. */
  domain?: string;
  /** Inline SVG for the source's icon (from MA's provider manifest), or null. */
  iconSvg?: string | null;
  /** MA `supported_features` (e.g. "library_albums", "library_radios") — used to decide which
      sources belong in an album/playlist vs radio source picker. */
  features?: string[];
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
  /** Whether raising the per-section fetch limit would likely yield more results — true when
      any source (or the library query) returned a full page. Drives the "Load more" button. */
  hasMore: { albums: boolean; playlists: boolean; songs: boolean };
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

/** A radio station (from a music-provider like TuneIn via MA), plus whether it's
    already saved to Crate's Radio shelf. Radio has no tracks — it's a live stream. */
/** A browsable extra-media item (radio station / podcast / audiobook) and whether it's saved.
    Radio is a live stream; a podcast is opened for its episodes; an audiobook plays directly. */
export interface MediaBrowseItem {
  providerUri: string;
  provider: string;
  name: string;
  /** Second line — station tagline, podcast publisher, or audiobook author(s); null if none. */
  description: string | null;
  artworkUrl: string | null;
  onShelf: boolean;
  /** Streaming source display name (e.g. "Spotify"); optional. */
  source?: string;
  kind?: ExtraMediaKind;
  /** Runtime in seconds (audiobooks); null for radio. */
  durationSec?: number | null;
  /** Playback progress into the item, ms; null/0 if unstarted (spoken-word kinds). */
  resumeMs?: number | null;
  /** True once finished. */
  fullyPlayed?: boolean;
}
/** @deprecated alias kept for the radio call sites. */
export type RadioStation = MediaBrowseItem;

/** Extra-media search: matching items across the connected sources, plus the source list. */
export interface MediaSearchResponse {
  items: MediaBrowseItem[];
  sources: MusicSourceInfo[];
}
export type RadioSearchResponse = MediaSearchResponse;

export interface AddMediaRequest {
  providerUri: string;
}
export type AddRadioRequest = AddMediaRequest;

/** Result of syncing a source's saved items of one kind into its Crate shelf. */
export interface MediaSyncResult {
  added: number;
  total: number;
}
export type RadioSyncResult = MediaSyncResult;

/** One podcast episode — rendered in the podcast's track-list view and playable by uri. */
export interface PodcastEpisode {
  /** Playable episode uri. */
  trackUri: string;
  title: string;
  /** Seconds, or null. */
  durationSec: number | null;
  /** Human date/subtitle line, or null. */
  subtitle: string | null;
  /** Playback progress into the episode, ms; null if unstarted. */
  resumeMs: number | null;
  /** True once finished. */
  fullyPlayed: boolean;
}
export interface PodcastEpisodesResponse {
  episodes: PodcastEpisode[];
}

/** One audiobook chapter — a labelled seek offset. */
export interface AudiobookChapter {
  title: string;
  /** Chapter start offset, in seconds. */
  startSec: number;
}
/** Audiobook detail fetched when its spine opens — progress + chapters for the reader view. */
export interface AudiobookDetail {
  durationSec: number | null;
  /** Playback progress into the book, ms; null/0 if unstarted. */
  resumeMs: number | null;
  fullyPlayed: boolean;
  chapters: AudiobookChapter[];
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
  | { type: 'system'; status: SystemStatus }
  /** Tell every connected client of one app to reload itself (a service "restart"). */
  | { type: 'reload'; app: 'shelf' | 'admin' };
