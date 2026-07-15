/**
 * Crate shelf — ported from spine-shelf.html.
 *
 * The prototype's gesture model and visual design are the spec (§5, §12). The
 * gesture engine below (open/step/scroll, settledLeft, smoothScrollTo, and the
 * pointer handlers) is preserved verbatim; only the data layer changed: the
 * mock LIBRARY + CONFIG block is replaced by the device-service REST API and a
 * live WebSocket. Do not rework the gesture logic without flagging a real
 * touchscreen issue (see conventions).
 */

import { CrateClient, DEFAULT_SETTINGS, EXTRA_MEDIA, isSpeaker, type PodcastEpisode, type AudiobookChapter, type MediaKind, type MediaBrowseItem, type MediaSearchResponse, type MusicSourceInfo, type ExtraMediaKind, type SourceKinds, type AfterAlbum, type AfterPlay, type IdleContent, type InkMode, type InkSize, type InkWeight, type GlowRadius, type GlowIntensity, type GroupPreset, type LabelLayout, type LabelVary, type GlobalSearchResponse, type LibraryPlaylist, type OpenMode, type ProviderAlbumDetail, type Player, type PlayerState, type RepeatMode, type SearchAlbum, type SearchArtist, type SearchSong, type ServiceHealth, type Settings, type Shelf, type ShelfItem, type ShelfKind, type SortBy, type SpineMode, type SpineTextDir, type SpineThickness, type SpineWidthMode, type SystemStatus, type Track, type WsMessage, type YearDisplay, type YearEmphasis, type YearPos } from '@crate/shared';
// Fonts bundled locally (§12) — the kiosk must not depend on Google Fonts.
// Weights span light→heavy so the ink-weight setting has real range to move across.
import '@fontsource/archivo-narrow/400.css';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource/oswald/300.css';
import '@fontsource/oswald/400.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/600.css';
import '@fontsource/oswald/700.css';
import '@fontsource-variable/newsreader/standard.css';
import '@fontsource-variable/newsreader/standard-italic.css';
import './styles.css';

const client = new CrateClient('');

// --- Live data (was CONFIG + LIBRARY) --------------------------------------
let items: ShelfItem[] = [];
let players: Player[] = [];
let rooms: Player[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS };
/** Named shelves ("crates") and which one the wall currently shows. */
let shelves: Shelf[] = [];
let activeShelf = 'all';
let shelfTab: ShelfKind = 'album';
let sourceKinds: SourceKinds = { radio: false, podcast: false, audiobook: false }; // which extra kinds a source serves
/** Virtual (non-editable) shelf ids: the built-ins plus the extra-media shelves. */
const VIRTUAL_SHELVES = new Set<string>(['all', 'playlists', ...EXTRA_MEDIA.map((m) => m.shelfId)]);
let shelfAdding = false; // showing the inline "name this shelf" box

/** Show each extra-media find-tab (Radio/Podcasts/Audiobooks) only when a capable source is
    connected AND the user hasn't hidden it in settings. If the active tab hides, fall back to
    Albums. Called whenever a shelf response lands (carries sourceKinds). */
const ALL_TABS: ShelfKind[] = ['album', 'playlist', 'radio', 'podcast', 'audiobook'];
/** Show/hide the five find-shelf tabs. Album/playlist are gated on the user toggle only; the
    extra-media tabs also need a capable connected source. A guard keeps ≥1 tab visible, and if the
    active tab hides we fall back to the first visible one. */
function updateMediaTabs(): void {
  const on = (k: ShelfKind): boolean => settings.mediaTabs?.[k] ?? true;
  const capable = (k: ShelfKind): boolean => k === 'album' || k === 'playlist' || !!sourceKinds[k as ExtraMediaKind];
  const visible = (k: ShelfKind): boolean => on(k) && capable(k);
  const anyVisible = ALL_TABS.some(visible);
  for (const k of ALL_TABS) {
    const show = anyVisible ? visible(k) : k === 'album'; // never leave zero tabs
    const tab = document.querySelector<HTMLElement>(`.find-shelf-tab[data-kind="${k}"]`);
    if (tab) tab.style.display = show ? '' : 'none';
  }
  const shown = (k: ShelfKind): boolean => (anyVisible ? visible(k) : k === 'album');
  if (!shown(shelfTab)) {
    const next = ALL_TABS.find(shown) ?? 'album';
    shelfTab = next;
    document.querySelectorAll('.find-shelf-tab').forEach((t) => t.classList.toggle('on', (t as HTMLElement).dataset['kind'] === next));
    const target = canonicalShelfId(next) ?? 'all';
    if (activeShelf !== target) void switchShelf(target);
    else renderShelfList();
  }
}
let shelfDeleteArmed: string | null = null; // shelf id whose ✕ is armed for confirm
let shelfRenaming: string | null = null; // shelf id whose name is being edited
let shelfLoadToken = 0; // guards against concurrent shelf loads clobbering each other

type ResolvedLayout = 'split' | 'center' | 'top' | 'bottom';
/** Resolve the artist/title layout for an album; 'varied' picks one deterministically. */
function resolveLayout(a: ShelfItem): ResolvedLayout {
  if (settings.labelLayout !== 'varied') return settings.labelLayout;
  const opts: ResolvedLayout[] = ['split', 'center', 'top', 'bottom'];
  return opts[hashStr(a.artist + a.title) % opts.length]!;
}

/* Per-album typography (SPINE_RENDERING §3): six label identities across Archivo
   Narrow / Oswald / Newsreader. Assignment is deterministic per artist so an
   artist's albums share a "label identity" and the shelf always renders the same.
   'Newsreader Variable' matches the locally-bundled font family. */
interface TypeStyle {
  font: string;
  weight: number;
  transform: string;
  tracking: string;
}
const TYPE_STYLES: TypeStyle[] = [
  { font: "'Archivo Narrow', sans-serif", weight: 600, transform: 'uppercase', tracking: '0.08em' },
  { font: "'Oswald', sans-serif", weight: 500, transform: 'uppercase', tracking: '0.12em' },
  { font: "'Oswald', sans-serif", weight: 400, transform: 'none', tracking: '0.05em' },
  { font: "'Newsreader Variable', serif", weight: 500, transform: 'none', tracking: '0.03em' },
  { font: "'Archivo Narrow', sans-serif", weight: 700, transform: 'none', tracking: '0.04em' },
  { font: "'Newsreader Variable', serif", weight: 400, transform: 'uppercase', tracking: '0.16em' },
];
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Polished volume icons (speaker + 1/2 sound waves) and a mini now-playing EQ.
const VOL_LOW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3.5L12 19V5L7.5 9H4Z" fill="currentColor" stroke="none"/><path d="M15.4 9.3a3.2 3.2 0 0 1 0 5.4"/></svg>';
const VOL_HIGH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3.5L12 19V5L7.5 9H4Z" fill="currentColor" stroke="none"/><path d="M15.4 9.3a3.2 3.2 0 0 1 0 5.4"/><path d="M18.4 6.8a6.5 6.5 0 0 1 0 10.4"/></svg>';
// Transport icons as inline SVG (unicode ▶/⏸/⏮/⏭ render as color emoji on iOS — bug fix).
const ICON_PLAY = '<svg class="tico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>';
const ICON_PAUSE = '<svg class="tico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.1"/></svg>';
const ICON_PREV = '<svg class="tico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5.5" width="2.5" height="13" rx="1"/><path d="M20 6.4v11.2a1 1 0 0 1-1.53.85l-8.5-5.6a1 1 0 0 1 0-1.7l8.5-5.6A1 1 0 0 1 20 6.4Z"/></svg>';
const ICON_NEXT = '<svg class="tico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="16.5" y="5.5" width="2.5" height="13" rx="1"/><path d="M4 6.4v11.2a1 1 0 0 0 1.53.85l8.5-5.6a1 1 0 0 0 0-1.7L5.53 5.55A1 1 0 0 0 4 6.4Z"/></svg>';
const ICON_SHUFFLE = '<svg class="tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>';
const ICON_REPEAT = '<svg class="tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
// Skip back / forward 10 seconds (spoken-word transport): a circular arrow with "10".
const ICON_BACK10 = '<svg class="tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M3 4v4h4"/><text x="12.5" y="15.5" font-size="8" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle" font-family="system-ui,sans-serif">10</text></svg>';
const ICON_FWD10 = '<svg class="tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M21 4v4h-4"/><text x="11.5" y="15.5" font-size="8" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle" font-family="system-ui,sans-serif">10</text></svg>';
const ICON_ARROW = '<svg class="tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h15"/><path d="M13 6l6 6-6 6"/></svg>';
// Cover-art placeholder for external sources (TV audio, line-in, AirPlay…) that carry no artwork.
const ICON_SOURCE = '<svg class="cc-art-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><path d="M8.8 8.8a4.5 4.5 0 0 0 0 6.4"/><path d="M15.2 8.8a4.5 4.5 0 0 1 0 6.4"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4"/><path d="M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>';
/** How long to hold a spine before its long-press (group-select) fires. Fixed — a quarter second. */
const LONG_PRESS_MS = 250;
const TRACK_EQ = '<span class="track-eq"><i></i><i></i><i></i></span>';
// Shown in place of the EQ on the just-played album until the target room actually
// reports playing — a "connecting" spinner so a slow queue-load doesn't look dead.
const NOW_SPINNER = '<span class="np-spin" aria-label="Starting"></span>';
let openMode: OpenMode = 'cover';

const shelf = document.getElementById('shelf') as HTMLDivElement;
const toast = document.getElementById('toast') as HTMLDivElement;
let openIdx: number | null = null;
let playingIdx: number | null = null;
let activePlayerId: string | null = null;
let activeSolo = false; // the target was picked as an individual speaker (vs a group)
let userPickedPlayer = false; // true once the user taps a room this session; until then the wall follows the admin default speaker
let volume = 42;

/** Live now-playing state, driven by WS state + progress ticks. */
interface NowState {
  playerId: string | null;
  albumId: string | null;
  trackIndex: number;
  /** Uri of the playing track — highlight rows by this, since the queue index can differ
      from the displayed track order (MA reorders when starting mid-album via start_item). */
  trackUri: string | null;
  elapsed: number;
  duration: number;
  state: 'playing' | 'paused' | 'idle';
  /** What kind of media is playing — drives the transport controls (radio hides
      shuffle/repeat; podcast/audiobook swap them for ±10s skip). */
  mediaKind: MediaKind | null;
  at: number; // performance.now() at last elapsed sample
}
let now: NowState = { playerId: null, albumId: null, trackIndex: 0, trackUri: null, elapsed: 0, duration: 0, state: 'idle', mediaKind: null, at: performance.now() };
/** Is the track at row `ti` (uri `uri`) the one playing? Match by uri when we have it —
    the queue index can differ from the displayed order (MA reorders on start_item) — else
    fall back to the index. */
function isNowTrack(uri: string | null | undefined, ti: number): boolean {
  return now.trackUri && uri ? uri === now.trackUri : ti === now.trackIndex;
}
/** Latch: the user paused. Some MA player providers report a paused queue as
    'idle', so we hold the now-playing paused until resume / a new play. */
let userPaused = false;
/** After a user pause/resume, ignore stale frames for this player until this time
    (the command hasn't propagated through MA yet): pauseGuard drops stale
    'playing' frames, resumeGuard drops stale non-playing frames. */
let pauseGuardUntil = 0;
let resumeGuardUntil = 0;
/** After hitting play, the album's queue can take a few seconds to load (during which
    other rooms' frames churn the now-state). Force this album's card to read as playing
    until the real state catches up, so the controls don't flicker to Play. */
let playPendingIdx = -1;
let playPendingUntil = 0;
/** The album provider uri we just asked to play — used to confirm the target room is
    really playing THIS album (playback frames carry albumUri, not the Crate albumId). */
let playPendingUri: string | null = null;
/** The album NAME we just asked to play — a fallback confirmation for when MA reports a
    different uri than we sent (catalog → library normalization), so the spinner still clears
    when audio starts rather than riding the full latch. */
let playPendingAlbum: string | null = null;
/** Album-view shuffle intent: a live control that resets to off each time a *different*
    album opens. When the open album is the one playing it reflects/drives the live queue;
    otherwise it's the pre-play choice applied on the next Play. (Repeat is not a per-album
    intent — the repeat button drives the global afterAlbum setting; see cycleAfterAlbum.) */
let cardShuffle = false;
/** "Open on outside playback": track the last now-playing album so we can tell when a NEW
    one starts; `lastTouchAt` gates against interrupting active use; `selfPlayUntil` marks a
    Crate-initiated play so it isn't mistaken for external; `firstStateSeen` skips the first
    (boot) state so we don't auto-open whatever was already playing at load. */
let lastNowAlbumId: string | null = null;
let firstStateSeen = false;
let lastTouchAt = 0;
let selfPlayUntil = 0;
/** The album+target we last started, watched so 'afterAlbum' can act when it ends. */
let afterAlbumWatch: { albumId: string; playerId: string | null } | null = null;
const AUTO_OPEN_TOUCH_GRACE_MS = 20000; // don't auto-open if the wall was touched this recently

const trackCache = new Map<string, Track[]>();
/** For playlist song spines: cached off-shelf album detail (keyed by album uri)
    and the resolved album-track index each song cues to. */
const albumDetailCache = new Map<string, ProviderAlbumDetail>();
const songCue = new Map<string, number>();
/** Drop the cued-track memory for the currently-open album (e.g. after a skip changes the
    live track) so the transport keeps showing Pause instead of reverting to the Play button. */
function clearOpenCue(): void {
  const it = openIdx !== null ? items[openIdx] : undefined;
  if (it) songCue.delete(it.albumId);
}

/** Live shelf search (control center). Empty = everything matches; non-matches
    collapse to slivers via spineWidthPx. */
let filterQuery = ''; // the search box text — drives the results list only
let shelfFilter = ''; // committed filter applied to the shelf spines (via "Filter shelf")
function matchesQuery(a: ShelfItem, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return a.title.toLowerCase().includes(s) || a.artist.toLowerCase().includes(s);
}
function matchesFilter(a: ShelfItem): boolean {
  return matchesQuery(a, shelfFilter);
}

function roomName(id: string | null): string {
  return players.find((p) => p.id === id)?.name ?? 'player';
}

let coverWCache = { h: -1, v: 0 };
function coverW(): number {
  // The open cover fills the spine's rendered height (`.spine { height: 93% }` of #shelf's
  // CONTENT box, i.e. minus padding). Return exactly that so the cover comes out SQUARE — album
  // art is square, so a non-square cover box (the old `clientHeight * 0.89` ignored the padding
  // and came out wider than tall) crops the art, and that crop "pops" as the flip flattens.
  // Cached on clientHeight (padding is vh-based, so it only changes when the height does) —
  // coverW() is called per-spine during a build, and getComputedStyle every time thrashes reflow.
  if (shelf.clientHeight !== coverWCache.h) {
    const cs = getComputedStyle(shelf);
    const contentH = shelf.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    coverWCache = { h: shelf.clientHeight, v: contentH }; // = `.spine { height: 100% }` of the content box → square cover
  }
  return coverWCache.v;
}
function panelW(): number {
  return Math.round(coverW() * 0.66); // the extended card's text panel ≈ 2/3 the album cover's width
}
/** Base spine width, proportional to a real CD jewel case (~10mm spine on a
    ~117mm case ≈ 9% of the case height). This is the uniform "every CD is the
    same size" width, and the anchor a duration-scaled width flexes around. */
const THICKNESS_RATIO: Record<SpineThickness, number> = { thin: 0.05, medium: 0.062, thick: 0.082 };
function spineBaseW(): number {
  return Math.round(Math.max(26, Math.min(coverW() * THICKNESS_RATIO[settings.spineThickness], 92)));
}
/** Two widths only, like physical cases: a single spine, or a double-wide one for
    releases too long to fit on a single disc (a 2-disc / double album). A CD tops out
    around 80 min, so anything past that gets the double case. */
const DOUBLE_WIDE_SEC = 4800; // 80 minutes
const SLIVER_W = 0; // search non-matches are hidden (.sliver → display:none); width 0 keeps settledLeft exact
/** Effective spine width (px) for one album, honoring the width mode and the
    live search filter. Deterministic → layout math (settledLeft) stays exact. */
function spineWidthPx(a: ShelfItem): number {
  if (!matchesFilter(a)) return SLIVER_W;
  const base = spineBaseW();
  if (settings.spineWidthMode !== 'duration' || !a.durationSec) return base;
  return a.durationSec > DOUBLE_WIDE_SEC ? base * 2 : base; // double-wide past 80 min, else regular
}

/** Ink-match test (inkMode 'match'): color the title with the album's accent,
    biased to the readable side of the spine. May not contrast on every album —
    that's the point of it being a test / per-album override territory. */
function matchInk(a: ShelfItem): string {
  return a.inkColor === 'light' ? a.primaryColor : a.darkColor;
}

/* ---------- Build the shelf ---------- */
/** Ambient backlight rendered behind all spines — shows the opened album's
    blurred art in the gaps/margins around it, never over neighbor art. */
const shelfGlow = document.createElement('div');
shelfGlow.className = 'shelf-glow';

let glowTrackRaf = 0;
/** Album-open glow tuning per setting. `spread` scales the halo margin (as a fraction of the
    cover height), `blurVh` its softness, `opacity`/`sat` its brightness — set from the global
    Glow radius/intensity controls. */
const GLOW_RADIUS: Record<GlowRadius, { spread: number; blurVh: number }> = {
  small: { spread: 0.03, blurVh: 3 },
  medium: { spread: 0.05, blurVh: 4 },
  large: { spread: 0.08, blurVh: 5.5 },
};
const GLOW_INTENSITY: Record<GlowIntensity, { opacity: number; sat: number }> = {
  soft: { opacity: 0.48, sat: 1.3 },
  medium: { opacity: 0.68, sat: 1.5 },
  bold: { opacity: 0.9, sat: 1.9 },
};
/** A soft square halo centred on the open cover. The cover swings out on a 3D flap (so its
    real position isn't a clean offset) and the shelf scrolls to it — so we read the cover's
    actual rect and track it for the open animation, keeping the halo centred throughout. */
function positionGlow(i: number): void {
  const a = items[i];
  const el = shelf.children[i] as HTMLElement | undefined;
  if (!a || !el) return;
  if (!settings.glowEnabled) {
    cancelAnimationFrame(glowTrackRaf);
    shelfGlow.classList.remove('on');
    return;
  }
  const rad = GLOW_RADIUS[settings.glowRadius] ?? GLOW_RADIUS.medium;
  const inten = GLOW_INTENSITY[settings.glowIntensity] ?? GLOW_INTENSITY.medium;
  const cover = el.querySelector('.face-cover') as HTMLElement | null;
  shelfGlow.style.backgroundImage = a.artworkUrl ? `url('${a.artworkUrl}')` : 'none';
  if (!a.artworkUrl) shelfGlow.style.backgroundColor = a.primaryColor;
  shelfGlow.style.filter = `blur(${rad.blurVh}vh) saturate(${inten.sat})`;
  shelfGlow.style.setProperty('--glow-op', String(inten.opacity));
  shelfGlow.classList.add('on');
  // #shelf-viewport clips vertically (overflow-y:hidden for the horizontal scroller), so the
  // short wall has only a small vertical gap above/below the cover while the sides have room.
  const clip = shelf.parentElement ?? shelf;
  const place = (): string => {
    const sr = shelf.getBoundingClientRect();
    const clr = clip.getBoundingClientRect();
    const cr = (cover ?? el).getBoundingClientRect();
    // A uniform square margin on every side, but clamped so the halo (plus its blur) never spills
    // past the shelf's top/bottom edges — that keeps the top bleed equal to the sides on the wall.
    const blur = (rad.blurVh / 100) * window.innerHeight; // keep in step with the CSS blur
    const room = Math.min(cr.top - clr.top, clr.bottom - cr.bottom) - blur;
    const d = Math.max(0, Math.min(rad.spread * cr.height, room));
    // The glow's offsetParent is #shelf, whose live rect already reflects the viewport scroll —
    // so (cr - sr) is the cover's position within it; no scrollLeft term needed.
    shelfGlow.style.left = `${cr.left - sr.left - d}px`;
    shelfGlow.style.top = `${cr.top - sr.top - d}px`;
    shelfGlow.style.width = `${cr.width + 2 * d}px`;
    shelfGlow.style.height = `${cr.height + 2 * d}px`;
    return `${Math.round(cr.left)},${Math.round(cr.top)},${Math.round(cr.width)}`;
  };
  cancelAnimationFrame(glowTrackRaf);
  let stable = 0, last = '';
  const step = (): void => {
    const key = place();
    if (key === last) stable++; else { stable = 0; last = key; }
    // Follow the open + scroll-to-centre animation, then stop once it settles (10 steady frames).
    if (openIdx === i && stable < 10) glowTrackRaf = requestAnimationFrame(step);
  };
  step();
}

function buildShelf(): void {
  shelf.innerHTML = '';
  items.forEach((a, i) => {
    const spineW = spineWidthPx(a); // uniform, duration-scaled, or a search sliver
    // Spine source precedence: uploaded custom spine → real scan → cover
    // edge-slice → flat gradient. A custom spine keeps the label (with overrides);
    // only a real scan (its own text baked in) suppresses the generated label.
    const spineMode = a.overrideSpineMode ?? settings.spineMode; // per-album override wins
    const useCustom = !!a.customSpineUrl;
    const useScan = !useCustom && spineMode === 'scan' && !!a.spineScanUrl;
    const useStrip = !useCustom && !useScan && spineMode !== 'palette' && !!a.spineStripUrl;
    // A playlist song: render a dimmed LEFT slice of its album cover (like album
    // 'art' spines) instead of the whole busy cover.
    const isSong = a.kind === 'playlist' && !!a.albumUri && !!a.spineStripUrl;
    const layout = a.overrideLayout ?? resolveLayout(a); // per-album override wins
    const el = document.createElement('div');
    el.className = `spine layout-${layout}` + (useScan ? ' scan' : '') + (matchesFilter(a) ? '' : ' sliver');
    el.dataset['idx'] = String(i);
    el.style.width = spineW + 'px';
    el.style.setProperty('--spine-w', spineW + 'px');

    // Typography: 'uniform' = one shared style, 'varied' = per-artist identity.
    // Per-album overrides (font, tracking, colors) win over the generated defaults.
    const ts = settings.labelVary === 'uniform' ? TYPE_STYLES[0]! : TYPE_STYLES[hashStr(a.artist) % TYPE_STYLES.length]!;
    const baseW = spineW / 2;
    const font = a.labelFont ?? ts.font;
    const tracking = a.labelTracking ?? ts.tracking;
    // Ink size/weight scale the generated label — a per-album override wins over the global.
    const inkSize = a.overrideInkSize ?? settings.inkSize;
    const inkWeight = a.overrideInkWeight ?? settings.inkWeight;
    // Same three terms, shifted up a notch: the old "small" is gone and there's a bigger max,
    // so Small/Medium/Large now map to 1.0 / 1.25 / 1.5.
    const sizeMul = inkSize === 'small' ? 1 : inkSize === 'large' ? 1.5 : 1.25;
    const fontSize = Math.min(baseW * (font.includes('Newsreader') ? 0.66 : 0.6), 19) * sizeMul;
    // Ink weight shifts the whole label across the bundled weight range; the title always
    // sits a step heavier than the artist for hierarchy. These weights are applied to the
    // text spans directly (below) so the setting actually renders — the .artist/.title CSS
    // no longer pins a fixed weight that would override it.
    const wShift = inkWeight === 'light' ? -200 : inkWeight === 'bold' ? 150 : 0;
    const clampW = (n: number): number => Math.max(200, Math.min(800, n));
    const artistWeight = clampW(ts.weight - 100 + wShift);
    const titleWeight = clampW(ts.weight + 100 + wShift);
    const labelWeight = clampW(ts.weight + wShift);
    const baseInk = a.inkColor === 'dark' ? 'rgba(20,18,16,0.88)' : 'rgba(240,236,228,0.92)';
    const artistCol = a.artistColor ?? baseInk;
    const titleCol = a.titleColor ?? (settings.inkMode === 'match' ? matchInk(a) : baseInk);

    const spineBg = isSong
      ? `background:linear-gradient(90deg, rgba(16,15,18,0.62), rgba(16,15,18,0.42)), url('${a.spineStripUrl}') left center / auto 100% no-repeat`
      : useCustom
        ? `background-image:url('${a.customSpineUrl}')`
        : useScan
          ? `background-image:url('${a.spineScanUrl}')`
          : useStrip
            ? `background-image:url('${a.spineStripUrl}')`
            : `background:linear-gradient(90deg, ${a.darkColor}, ${a.primaryColor} 45%, ${a.darkColor})`;
    const coverArt = a.artworkUrl ? ` has-art" style="background-image:url('${a.artworkUrl}')` : '';
    // Year display/orientation is per-album; position is global (drives the shared gutter).
    const yearDisplay = a.overrideYearDisplay ?? settings.yearDisplay;
    const yearOn = yearDisplay !== 'off' && !useScan && a.year;
    const cat = yearOn
      ? `<div class="cat cat-${settings.yearPos}${yearDisplay === 'horizontal' ? ' horizontal' : ''}" style="color:${baseInk}">${a.year}</div>`
      : '';

    // Split layout puts the artist and title at opposite ends of the spine;
    // the others render them together (positioned by the layout-* class).
    const labelCss = `font-size:calc(${fontSize}px * var(--zoom, 1)); font-family:${font}; font-weight:${labelWeight}; text-transform:${ts.transform}; letter-spacing:${tracking}`;
    const artistSpan = `<span class="artist" style="color:${artistCol}; font-weight:${artistWeight}">${escapeHtml(a.artist)}</span>`;
    const titleSpan = `<span class="title" style="color:${titleCol}; font-weight:${titleWeight}">${escapeHtml(a.title)}</span>`;
    const labelHtml =
      layout === 'split'
        ? `<div class="spine-label artist-label" style="${labelCss}">${artistSpan}</div>` +
          `<div class="spine-label title-label" style="${labelCss}">${titleSpan}</div>`
        : `<div class="spine-label" style="${labelCss}; color:${baseInk}">${artistSpan}&nbsp;&nbsp;${titleSpan}</div>`;

    // Transport side-controls by kind: albums/playlists get shuffle+repeat; podcasts/audiobooks
    // get −10s/+10s skip; radio (a live stream) gets neither.
    // −10s/+10s are live-transport controls (like ⏮/⏭): hidden until the stream is playing.
    const spoken = a.kind === 'podcast' || a.kind === 'audiobook';
    const leftCtl = spoken
      ? `<button class="card-mode card-back10" aria-label="Back 10 seconds" hidden>${ICON_BACK10}</button>`
      : a.kind === 'radio'
        ? ''
        : `<button class="card-mode card-shuffle" aria-label="Shuffle">${ICON_SHUFFLE}</button>`;
    const rightCtl = spoken
      ? `<button class="card-mode card-fwd10" aria-label="Forward 10 seconds" hidden>${ICON_FWD10}</button>`
      : a.kind === 'radio'
        ? ''
        : `<button class="card-mode card-repeat" aria-label="Repeat">${ICON_REPEAT}</button>`;

    el.innerHTML = `
      <div class="flap">
        <div class="face face-spine" style="${spineBg}">
          ${labelHtml}
          ${cat}
        </div>
        <div class="face face-cover${coverArt || `" style="background:linear-gradient(145deg, ${a.primaryColor}, ${a.darkColor} 85%)`}">
          <div class="cover-type" style="color:${baseInk}">${escapeHtml(a.title)}</div>
        </div>
      </div>
      <button class="cover-btn cover-play" aria-label="Play">${ICON_PLAY}</button>
      <button class="cover-btn cover-menu" aria-label="More">⋯</button>
      <div class="panel">
        <button class="panel-menu" aria-label="More">⋯</button>
        <div class="panel-pop" hidden></div>
        <div class="eyebrow">From your library</div>
        <h1>${escapeHtml(a.title)}</h1>
        <h2>${escapeHtml(a.artist)}</h2>
        <div class="nowbar" hidden>
          <div class="seek"><div class="seek-fill"></div></div>
          <div class="times"><span class="cur">0:00</span><span class="dur">0:00</span></div>
        </div>
        <div class="actions">
          <div class="transport">
            ${leftCtl}
            <button class="np-btn np-prev" aria-label="Previous track" hidden>${ICON_PREV}</button>
            <button class="play">Play</button>
            <button class="np-btn np-next" aria-label="Next track" hidden>${ICON_NEXT}</button>
            ${rightCtl}
          </div>
          <div class="rooms"></div>
          <div class="vol">
            <span class="vol-ico">${VOL_LOW_SVG}</span>
            <input type="range" min="0" max="100" value="42">
            <span class="vol-ico">${VOL_HIGH_SVG}</span>
            <button class="vol-caret" aria-label="Group volumes" hidden>▾</button>
            <div class="vol-members" hidden></div>
          </div>
        </div>
        <div class="tracks"></div>
      </div>
      <div class="eq"><i></i><i></i><i></i></div>`;

    const stop = (e: Event): void => e.stopPropagation();
    el.querySelector('.cover-play')!.addEventListener('pointerdown', stop);
    el.querySelector('.cover-play')!.addEventListener('click', (e) => {
      stop(e);
      void playCard(i);
    });
    el.querySelector('.cover-menu')!.addEventListener('pointerdown', stop);
    el.querySelector('.cover-menu')!.addEventListener('click', (e) => {
      stop(e);
      expand(el, true);
    });
    el.querySelector('.panel')!.addEventListener('pointerdown', stop);
    el.querySelector('.play')!.addEventListener('click', (e) => {
      stop(e);
      void onPlayButton(i);
    });
    // Shuffle/repeat exist only for albums & playlists; podcasts/audiobooks get ±10s skip instead.
    el.querySelector('.card-shuffle')?.addEventListener('click', (e) => {
      stop(e);
      toggleShuffle();
    });
    el.querySelector('.card-repeat')?.addEventListener('click', (e) => {
      stop(e);
      cycleAfterAlbum();
    });
    el.querySelector('.card-back10')?.addEventListener('click', (e) => {
      stop(e);
      skipSeconds(-10);
    });
    el.querySelector('.card-fwd10')?.addEventListener('click', (e) => {
      stop(e);
      skipSeconds(10);
    });
    // Tapping the artist name opens the search with that name typed in.
    el.querySelector('.panel h2')?.addEventListener('click', (e) => {
      stop(e);
      const a = items[i];
      if (a) openFindWithQuery(a.artist);
    });
    // Now-playing transport (skip only; play/pause + retarget is the big Play button).
    el.querySelector('.np-prev')!.addEventListener('click', (e) => {
      stop(e);
      clearOpenCue(); // a skip changes the track — drop the stale cue so the button stays Pause
      if (now.playerId) void client.transport({ playerId: now.playerId, cmd: 'previous' }).catch(() => {});
    });
    el.querySelector('.np-next')!.addEventListener('click', (e) => {
      stop(e);
      clearOpenCue();
      if (now.playerId) void client.transport({ playerId: now.playerId, cmd: 'next' }).catch(() => {});
    });
    // ⋯ menu on the card — content is kind-aware (renderCardMenu). Toggles the popover.
    const panelPop = el.querySelector('.panel-pop') as HTMLElement;
    el.querySelector('.panel-menu')!.addEventListener('click', (e) => {
      stop(e);
      panelPop.hidden = !panelPop.hidden;
      if (!panelPop.hidden) renderCardMenu(panelPop, a);
    });
    panelPop.addEventListener('pointerdown', stop); // taps inside the popover don't bubble to the card
    wireVol(el.querySelector('.vol') as HTMLElement);
    const seek = el.querySelector('.seek') as HTMLElement;
    seek.addEventListener('pointerdown', stop);
    seek.addEventListener('click', (e) => {
      e.stopPropagation();
      if (playingIdx !== i || now.duration <= 0 || !now.playerId) return;
      const rect = seek.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, ((e as MouseEvent).clientX - rect.left) / rect.width));
      const pos = Math.floor(ratio * now.duration);
      now.elapsed = pos;
      now.at = performance.now();
      updateNowbar();
      void client.transport({ playerId: now.playerId, cmd: 'seek', position: pos }).catch(() => {});
    });
    shelf.appendChild(el);
  });
  shelf.appendChild(shelfGlow); // last child, but z-index puts it behind the spines
  if (openIdx !== null) positionGlow(openIdx);
  else shelfGlow.classList.remove('on');
  sizeFaces(); // apply the current spine-zoom to the freshly-built spines
  renderChoices();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Spine-density zoom factor (pinch, when pinchZoom==='spines'): scales spine widths
    and — via the --zoom CSS var — their labels. Covers stay height-fit. */
let spineZoom = 1;
const SPINE_ZOOM_MIN = 0.55;
const SPINE_ZOOM_MAX = 2.2;

function sizeFaces(): void {
  const cw = coverW();
  const pw = panelW();
  shelf.style.setProperty('--zoom', String(spineZoom));
  document.querySelectorAll<HTMLElement>('.spine').forEach((el) => {
    const a = items[+el.dataset['idx']!];
    const sw = (a ? spineWidthPx(a) : spineBaseW()) * spineZoom;
    el.style.setProperty('--cover-w', cw + 'px');
    el.style.setProperty('--panel-w', pw + 'px');
    el.style.setProperty('--spine-w', sw + 'px');
    el.style.width = el.classList.contains('open') ? openWidth(el) + 'px' : sw + 'px';
  });
  cumLeft = null; // spine widths just changed — settledLeft's cache is stale
}
window.addEventListener('resize', sizeFaces);

function openWidth(el: HTMLElement): number {
  // spine (binding, stays) + cover swung out to its right + optional details panel
  const sw = parseFloat(el.style.getPropertyValue('--spine-w')) || 0;
  return sw + coverW() + (el.classList.contains('expanded') ? panelW() : 0);
}

/* ---------- Open / close / expand ---------- */
function openAlbum(i: number, autoscroll = true): void {
  if (openIdx === i) return;
  closeAlbum();
  const el = shelf.children[i] as HTMLElement;
  openIdx = i;
  // Shuffle/repeat reset to off for each newly-opened album — nothing carries over.
  // (renderCardModes below still shows the live queue if this album is what's playing.)
  cardShuffle = false;
  // Opening the album that's actually playing → snap the picker + cued track to where
  // it's really playing (overrides any sticky room pick), so the card reflects reality.
  const it = items[i];
  if (it && now.playerId && now.state !== 'idle' && now.albumId === it.albumId) {
    activePlayerId = now.playerId;
    activeSolo = groupMembers(leaderOf(now.playerId)).length < 2;
    songCue.set(it.albumId, now.trackIndex);
  }
  renderRooms(el);
  void renderTracks(el, i);
  syncVol(el.querySelector('.vol'));
  handleState(lastStates); // refocus now-playing on the newly-opened album
  renderCardModes();
  el.classList.add('open');
  if (openMode === 'card') el.classList.add('expanded');
  el.style.width = openWidth(el) + 'px';
  positionGlow(i);
  if (!autoscroll) return;
  requestAnimationFrame(() => {
    const target = openScrollTarget(i);
    if (Math.abs(target - vp.scrollLeft) > 1) smoothScrollTo(vp, target); // open in place unless it'd overflow
  });
}

/** A shelf holding a single spine always shows flipped open — a lone closed spine is pointless.
    Opens straight into the extended card view (cover + details panel), regardless of the global
    openMode, since there's nothing else on the shelf to make room for. Called after each shelf
    (re)load; a no-op unless there's exactly one item and none is open. */
function autoOpenIfSingle(): void {
  if (openIdx === null && items.length === 1) {
    openAlbum(0, false);
    const el = shelf.children[0] as HTMLElement | undefined;
    if (el && !el.classList.contains('expanded')) expand(el, true);
  }
}

function expand(el: HTMLElement, on: boolean): void {
  el.classList.toggle('expanded', on);
  el.style.width = openWidth(el) + 'px'; // grows to the right, pushing later spines along
  if (on && openIdx !== null) {
    requestAnimationFrame(() => {
      const target = openScrollTarget(openIdx!); // the now-wider panel may need to scroll into view
      if (Math.abs(target - vp.scrollLeft) > 1) smoothScrollTo(vp, target);
    });
  }
}

function closeAlbum(): void {
  if (openIdx === null) return;
  const el = shelf.children[openIdx] as HTMLElement;
  el.classList.remove('open', 'expanded');
  el.style.width = el.style.getPropertyValue('--spine-w');
  cancelAnimationFrame(glowTrackRaf);
  shelfGlow.classList.remove('on');
  openIdx = null;
  groupSelect = null; // leaving the card exits any in-progress grouping
}

// Cumulative left offset of every spine (paddingLeft + Σ spine-w + gap). Caching it makes each
// drag-step lookup O(1) instead of a getComputedStyle (style recalc) + per-child parse every call.
// Rebuilt lazily; invalidated by sizeFaces (widths change) and by a spine-count mismatch.
let cumLeft: number[] | null = null;
function rebuildCumLeft(): void {
  const cs = getComputedStyle(shelf);
  const gap = parseFloat(cs.columnGap) || 3;
  const n = shelf.children.length;
  const arr = new Array<number>(n + 1);
  let x = parseFloat(cs.paddingLeft) || 0;
  for (let j = 0; j < n; j++) {
    arr[j] = x;
    x += (parseFloat((shelf.children[j] as HTMLElement).style.getPropertyValue('--spine-w')) || 0) + gap;
  }
  arr[n] = x;
  cumLeft = arr;
}
function settledLeft(i: number): number {
  if (!cumLeft || cumLeft.length !== shelf.children.length + 1) rebuildCumLeft();
  const c = cumLeft as number[];
  return c[Math.max(0, Math.min(i, c.length - 1))] as number;
}

/** Minimal scroll for an opened album: keep it exactly in place unless the flipped-open
    card would run past an edge. Only then scroll — just enough to fit the card past the
    right edge (the common case), or to reveal its left edge if it started off-screen left.
    Tapping a visible album never yanks the shelf sideways. */
function openScrollTarget(i: number): number {
  const el = shelf.children[i] as HTMLElement;
  const left = settledLeft(i);
  const cardRight = left + openWidth(el);
  const viewLeft = vp.scrollLeft;
  const viewRight = vp.scrollLeft + vp.clientWidth;
  const margin = vp.clientWidth * 0.03;
  if (cardRight > viewRight) return vp.scrollLeft + (cardRight - viewRight) + margin; // overflow right → fit
  if (left < viewLeft) return Math.max(0, left - margin); // spine off-screen left → reveal it
  return vp.scrollLeft; // fits in the current view → don't move
}

let scrollToken = 0;
function smoothScrollTo(el: HTMLElement, target: number, dur = 380): void {
  const token = ++scrollToken;
  const start = el.scrollLeft,
    dist = target - start,
    t0 = performance.now();
  (function step(t: number) {
    if (token !== scrollToken) return;
    const p = Math.min((t - t0) / dur, 1);
    el.scrollLeft = start + dist * (1 - Math.pow(1 - p, 3));
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

/** The album currently shown by the card/overlay (shelf spine or play-now overlay). */
function openCardAlbumId(): string | null {
  if (openIdx !== null) return items[openIdx]?.albumId ?? null;
  if (!albumModal.hidden && modalAlbumUri) return albumIdFromUri(modalAlbumUri);
  return null;
}
/** Provider album uri of the card/overlay album — off-shelf content has no crate id
    (server reports albumId null), so we also match rooms by album uri. */
function openCardAlbumUri(): string | null {
  if (openIdx !== null) return items[openIdx]?.providerUri ?? null;
  if (!albumModal.hidden) return modalAlbumUri;
  return null;
}
/** Whether a room is playing THIS album, some OTHER music, or nothing — so the picker
    can mark which are safe to take over. */
function roomPlayState(id: string): 'this' | 'other' | 'idle' | 'buffering' {
  const hereId = openCardAlbumId();
  // The FOCUSED room (the one this card controls) keeps its EQ when playing OR paused —
  // frozen while paused so its chip tracks the song row + Pause button. This also serves
  // as the optimistic marker for the room we just told to play, before its frame lands.
  // Other rooms only qualify when actively playing (below), so a background room you've
  // moved away from — left paused on this album — does NOT keep a stale EQ.
  if (id === now.playerId && (now.state === 'playing' || now.state === 'paused') && !!now.albumId && now.albumId === hereId)
    return playBuffering() ? 'buffering' : 'this'; // 'connecting' until the room really plays
  // Any OTHER room must be ACTIVELY playing to get a marker: its EQ if it's on this
  // album, else the busy dot for other music. A paused background room shows nothing.
  const s = lastStates.find((x) => x.playerId === id && x.state === 'playing' && x.nowPlaying);
  if (!s) return 'idle';
  const np = s.nowPlaying;
  const matches = (!!np?.albumId && np.albumId === hereId) || (!!np?.albumUri && np.albumUri === openCardAlbumUri());
  return matches ? 'this' : 'other';
}
/** A group's play state = whatever any member is doing (they share the queue). */
function groupPlayState(members: Player[]): 'this' | 'other' | 'idle' | 'buffering' {
  let other = false;
  let buffering = false;
  for (const m of members) {
    const ps = roomPlayState(m.id);
    if (ps === 'this') return 'this';
    if (ps === 'buffering') buffering = true;
    if (ps === 'other') other = true;
  }
  return buffering ? 'buffering' : other ? 'other' : 'idle';
}
/** Prefix for a picker chip: animated EQ if it's playing this album, a spinner while a
    fresh play is connecting, a hollow dot if it's playing other music, nothing if idle. */
function playMarker(ps: 'this' | 'other' | 'idle' | 'buffering'): string {
  return ps === 'this' ? TRACK_EQ : ps === 'buffering' ? NOW_SPINNER : ps === 'other' ? '<span class="room-busy"></span>' : '';
}

/** If the picked room is playing the OPEN album, follow it so the card shows THAT
    room's current track — several rooms can play one album at different points. */
function followIfPlayingOpenAlbum(id: string): void {
  const openAlbumId = openIdx !== null ? (items[openIdx]?.albumId ?? null) : null;
  if (openAlbumId && lastStates.some((s) => s.playerId === id && s.state !== 'idle' && s.nowPlaying?.albumId === openAlbumId)) {
    focusedPlayerId = id;
    handleState(lastStates); // re-derive `now` from the new focus → card shows its track
  }
}

/** Album-card play-target picker: chips for each real group AND every individual
    speaker. Group management + volume live in the control center; here you just
    choose where this album plays. */
function renderRooms(el: HTMLElement): void {
  const wrap = el.querySelector('.rooms') as HTMLElement;
  wrap.innerHTML = '';
  wrap.classList.toggle('grouping', groupSelect !== null);

  // --- Multi-select grouping mode: tick speakers, then Apply (or Cancel to discard). ---
  if (groupSelect) {
    rooms.forEach((r) => {
      const on = groupSelect!.has(r.id);
      const b = document.createElement('button');
      b.className = 'room room-sel' + (on ? ' sel' : '');
      b.innerHTML = `<span class="room-check">${on ? '✓' : '+'}</span>` + escapeHtml(r.name);
      b.onclick = (e) => {
        e.stopPropagation();
        toggleGroupSel(r.id, el);
      };
      wrap.appendChild(b);
    });
    // Trailing actions: Apply commits at any size (1 = ungroup); Cancel discards the staging.
    const n = groupSelect.size;
    const onlyId = n === 1 ? [...groupSelect][0]! : null;
    const onlyGrouped = onlyId ? groupMembers(leaderOf(onlyId)).length >= 2 : false;
    const apply = document.createElement('button');
    apply.className = 'room room-group on';
    apply.textContent = n >= 2 ? `Group ${n}` : onlyGrouped ? 'Ungroup' : 'Done';
    apply.onclick = (e) => {
      e.stopPropagation();
      commitGroupSelection(el);
    };
    wrap.appendChild(apply);
    const cancel = document.createElement('button');
    cancel.className = 'room room-ctl';
    cancel.textContent = 'Cancel';
    cancel.onclick = (e) => {
      e.stopPropagation();
      groupSelect = null;
      renderRooms(el);
    };
    wrap.appendChild(cancel);
    syncVol(el.querySelector('.vol'));
    return;
  }

  // --- Normal mode: presets + group chips + individual speakers pick the play target. ---
  // Saved presets lead — one tap forms that group and targets it.
  for (const preset of settings.groupPresets) {
    if (presetRooms(preset).length === 0) continue; // none of its speakers are pickable now
    const b = document.createElement('button');
    b.className = 'room room-preset' + (presetIsActive(preset) ? ' on' : '');
    b.innerHTML = `<span class="preset-star">✦</span>${escapeHtml(preset.name)}`;
    b.onclick = (e) => {
      e.stopPropagation();
      applyPreset(preset, el);
    };
    wrap.appendChild(b);
  }
  // Group chips next — play to a live group (targets its leader).
  for (const leader of [...new Set(rooms.map((r) => leaderOf(r.id)))]) {
    const members = groupMembers(leader);
    if (members.length < 2) continue;
    const name = rooms.find((r) => r.id === leader)?.name ?? 'Group';
    const b = document.createElement('button');
    b.className = 'room room-group' + (!activeSolo && activePlayerId === leader ? ' on' : '');
    b.innerHTML = playMarker(groupPlayState(members)) + escapeHtml(`${name} +${members.length - 1}`);
    b.onclick = (e) => {
      e.stopPropagation();
      activePlayerId = leader;
      activeSolo = false;
      userPickedPlayer = true;
      followIfPlayingOpenAlbum(leader);
      renderRooms(el);
      updatePlayButton();
    };
    attachRoomLongPress(b, leader, el);
    wrap.appendChild(b);
  }
  // Outline the targeted group's members (only when a GROUP is the target).
  const activeGroup = !activeSolo ? groupMembers(leaderOf(activePlayerId ?? '')) : [];
  const inActiveGroup = new Set(activeGroup.length >= 2 ? activeGroup.map((r) => r.id) : []);
  // Then every individual speaker. Picking a grouped one just selects it — it's
  // only pulled out of its group when you actually hit Play (so a mis-tap is safe).
  rooms.forEach((r) => {
    const b = document.createElement('button');
    // The current Play target is always highlighted — including the default the wall
    // follows before you pick anything (inActiveGroup is only set when a GROUP is targeted).
    const isTarget = r.id === activePlayerId && inActiveGroup.size === 0;
    b.className = 'room' + (isTarget ? ' on' : inActiveGroup.has(r.id) ? ' in-group' : '');
    // A member of a multi-speaker group shows a small static dot ONLY while its group is
    // actually playing (a quiet "in progress" marker, without the distracting EQ — the
    // group chip carries the EQ). Nothing when the group is idle.
    const inGroup = groupMembers(leaderOf(r.id)).length >= 2;
    const marker = inGroup
      ? groupPlayState(groupMembers(leaderOf(r.id))) === 'idle'
        ? ''
        : '<span class="room-grouped" aria-hidden="true"></span>'
      : playMarker(roomPlayState(r.id));
    b.innerHTML = marker + escapeHtml(r.name) + (r.id === settings.defaultPlayerId ? '<span class="room-def">default</span>' : '');
    b.onclick = (e) => {
      e.stopPropagation();
      activePlayerId = r.id;
      activeSolo = true;
      userPickedPlayer = true;
      volume = roomVol(r.id); // adopt the picked player's level so the slider updates instantly
      followIfPlayingOpenAlbum(r.id);
      renderRooms(el);
      updatePlayButton(); // label flips to "Play" when this differs from what's playing
      updateModalTransport();
    };
    attachRoomLongPress(b, r.id, el); // hold a room → jump into grouping with it selected
    wrap.appendChild(b);
  });
  // A trailing "Group" pill enters multi-select grouping (only worth showing for ≥2 rooms).
  if (rooms.length >= 2) {
    const g = document.createElement('button');
    g.className = 'room room-ctl room-groupbtn';
    g.innerHTML = '<span class="room-check">+</span>Group';
    g.onclick = (e) => {
      e.stopPropagation();
      enterGroupSelect(null, el);
    };
    wrap.appendChild(g);
  }
  syncVol(el.querySelector('.vol')); // picking a group vs solo room flips the vol control
  syncEqs(); // keep the picker's EQ chips in phase with the track/spine EQs
}

/** Long-press a room chip → open grouping mode with that room (and the current target)
    preselected. A move/scroll or a quick tap cancels the hold (tap keeps its click). */
function attachRoomLongPress(b: HTMLElement, id: string, el: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  b.addEventListener('pointerdown', (e) => {
    if (groupSelect) return; // already grouping
    held = false;
    timer = setTimeout(() => {
      held = true;
      if (navigator.vibrate) navigator.vibrate(15);
      enterGroupSelect(id, el);
    }, LONG_PRESS_MS);
    (e.target as HTMLElement).setPointerCapture?.((e as PointerEvent).pointerId);
  });
  b.addEventListener('pointermove', clear);
  b.addEventListener('pointercancel', clear);
  b.addEventListener('pointerup', clear);
  // Swallow the click that follows a completed long-press so it doesn't also select.
  b.addEventListener('click', (e) => {
    if (held) {
      e.stopPropagation();
      e.preventDefault();
      held = false;
    }
  }, true);
}

/** Episodes of the currently-open podcast, keyed by shelf-item id — so the card's Play
    button can play the resume/newest episode without a container play (which MA rejects). */
const podcastEpisodeCache = new Map<string, PodcastEpisode[]>();
const audiobookChaptersCache = new Map<string, AudiobookChapter[]>(); // for the card Play button (cued chapter)
/** Single tap on a track row selects/cues it (highlight + Play-button target) — a quick
    double-tap is what actually plays. Shared by album tracks, playlist songs, podcast episodes
    and audiobook chapters so every track list behaves the same way. */
function wireTrackSelect(row: HTMLElement, wrap: HTMLElement, albumId: string, ti: number): void {
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    songCue.set(albumId, ti);
    wrap.querySelectorAll('.track').forEach((r, idx) => {
      if (!r.classList.contains('now')) r.classList.toggle('cued', idx === ti);
    });
    updatePlayButton(); // a different track than what's playing → the Play button plays the selection
  });
}

/** A dim description block (podcast/audiobook synopsis) clamped to a few lines, with a
    "More"/"Less" toggle when the text overflows. */
function aboutBlock(text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'md-about';
  const p = document.createElement('div');
  p.className = 'md-about-text';
  p.textContent = text;
  wrap.appendChild(p);
  if (text.length > 160) {
    const btn = document.createElement('button');
    btn.className = 'md-about-toggle';
    btn.textContent = 'More';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.textContent = wrap.classList.toggle('open') ? 'Less' : 'More';
    });
    wrap.appendChild(btn);
  } else {
    wrap.classList.add('open'); // short blurb: show in full, no toggle
  }
  return wrap;
}

/** Format an episode's ISO release date compactly (e.g. "May 5, 2023"); '' if missing/invalid. */
function fmtEpDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function renderTracks(el: HTMLElement, i: number): Promise<void> {
  const item = items[i]!;
  const wrap = el.querySelector('.tracks') as HTMLElement;
  // A radio station is a live stream — no track list. Show a single "live" row instead.
  if (item.kind === 'radio') {
    wrap.innerHTML = `<div class="track radio-live"><span class="n">◉</span><span class="tt">Live radio stream</span></div>`;
    return;
  }
  // An audiobook plays as one resumable item — show progress + chapters; the card's Play button
  // resumes, "Start over" restarts, and tapping a chapter jumps to it.
  if (item.kind === 'audiobook') {
    wrap.innerHTML = `<div class="track"><span class="tt">Loading…</span></div>`;
    const uri = item.providerUri;
    const detail = uri ? await client.audiobookDetail(uri).catch(() => null) : null;
    if (openIdx !== i) return;
    wrap.innerHTML = '';
    const dur = detail?.durationSec ?? 0;
    const resumeSec = detail?.resumeMs != null ? detail.resumeMs / 1000 : 0;
    const inProgress = !!detail && !detail.fullyPlayed && resumeSec > 0 && dur > 0;
    const hrs = (s: number): string => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.max(1, Math.round(s / 60))}m`);
    const head = document.createElement('div');
    head.className = 'ab-head';
    const status = detail?.fullyPlayed ? 'Finished' : inProgress ? `${hrs(dur - resumeSec)} left of ${hrs(dur)}` : dur ? hrs(dur) : 'Audiobook';
    head.innerHTML = `<span class="ab-status">${escapeHtml(status)}</span>`;
    if (inProgress) {
      const over = document.createElement('button');
      over.className = 'ab-over';
      over.textContent = 'Start over';
      over.addEventListener('click', (e) => {
        e.stopPropagation();
        void playAudiobook(i, 1);
      });
      head.appendChild(over);
    }
    wrap.appendChild(head);
    if (detail?.about) wrap.appendChild(aboutBlock(detail.about));
    const chapters = detail?.chapters ?? [];
    audiobookChaptersCache.set(item.albumId, chapters); // so the card Play button can play the cued chapter
    chapters.forEach((ch, ci) => {
      const next = chapters[ci + 1]?.startSec ?? dur;
      const isCur = inProgress && resumeSec >= ch.startSec && resumeSec < next;
      const len = next > ch.startSec ? fmtDur(next - ch.startSec) : '';
      const row = document.createElement('div');
      row.className = 'track ch' + (isCur ? ' now' : '');
      row.innerHTML = `<span class="n">${isCur ? TRACK_EQ : ci + 1}</span><span class="tt">${escapeHtml(ch.title)}</span><span class="dur">${len}</span>`;
      wireTrackSelect(row, wrap, item.albumId, ci); // tap = select; double-tap = play from here
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        void playAudiobook(i, Math.floor(ch.startSec));
      });
      wrap.appendChild(row);
    });
    return;
  }
  // A podcast is a container of episodes — list them with progress; tap to play (resumes).
  if (item.kind === 'podcast') {
    wrap.innerHTML = `<div class="track"><span class="tt">Loading episodes…</span></div>`;
    const uri = item.providerUri;
    const resp = uri
      ? await client.podcastEpisodes(uri).catch(() => ({ episodes: [] as PodcastEpisode[], about: null }))
      : { episodes: [] as PodcastEpisode[], about: null };
    if (openIdx !== i) return;
    const episodes = resp.episodes;
    podcastEpisodeCache.set(item.albumId, episodes); // for the card Play button
    if (!episodes.length) {
      wrap.innerHTML = `<div class="track"><span class="tt">No episodes.</span></div>`;
      return;
    }
    wrap.innerHTML = '';
    if (resp.about) wrap.appendChild(aboutBlock(resp.about));
    episodes.forEach((ep, ti) => {
      const isNow = playingIdx === i && !!ep.trackUri && now.trackUri === ep.trackUri;
      const resumeSec = ep.resumeMs != null ? ep.resumeMs / 1000 : 0;
      const inProgress = !ep.fullyPlayed && resumeSec > 0 && !!ep.durationSec;
      const pct = inProgress ? Math.min(100, (resumeSec / (ep.durationSec ?? 1)) * 100) : 0;
      const right = ep.fullyPlayed
        ? 'Played'
        : inProgress
          ? `${Math.max(1, Math.round(((ep.durationSec ?? 0) - resumeSec) / 60))} min left`
          : ep.durationSec
            ? fmtDur(ep.durationSec)
            : '';
      const date = fmtEpDate(ep.releaseDate);
      const row = document.createElement('div');
      row.className = 'track ep' + (ep.fullyPlayed ? ' done' : '') + (isNow ? ' now' : '');
      if (ep.trackUri) row.dataset.uri = ep.trackUri;
      row.innerHTML =
        `<span class="n">${ep.fullyPlayed ? '✓' : isNow ? TRACK_EQ : ti + 1}</span>` +
        `<span class="tt">${escapeHtml(ep.title)}${date ? `<span class="ep-date">${date}</span>` : ''}</span>` +
        `<span class="dur">${right}</span>` +
        (inProgress ? `<div class="ep-fill" style="width:${pct}%"></div>` : '');
      wireTrackSelect(row, wrap, item.albumId, ti); // tap = select; double-tap = play
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        void playEpisode(i, ep);
      });
      wrap.appendChild(row);
    });
    return;
  }
  const draw = (tracks: Track[], cueIdx: number): void => {
    wrap.innerHTML = '';
    tracks.forEach((t, ti) => {
      const row = document.createElement('div');
      const isNow = playingIdx === i && isNowTrack(t.uri, ti);
      row.className = 'track' + (isNow ? ' now' : ti === cueIdx ? ' cued' : '');
      if (t.uri) row.dataset.uri = t.uri;
      const dur = t.duration ? fmtDur(t.duration) : '';
      row.innerHTML = `<span class="n">${isNow ? TRACK_EQ : ti + 1}</span><span class="tt">${escapeHtml(t.title)}${t.explicit ? ' <span class="ex-badge" title="Explicit">E</span>' : ''}</span><span class="dur">${dur}</span>`;
      // Tap = select/highlight only; the card's Play button plays the selected track.
      wireTrackSelect(row, wrap, item.albumId, ti);
      // Double-tap plays this track immediately on the current player selection.
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        void play(i, ti);
      });
      wrap.appendChild(row);
    });
  };
  // Song spine (single-playlist shelf) → open its ALBUM, cued to this song.
  if (item.albumUri) {
    const apply = (d: ProviderAlbumDetail): void => {
      applyAlbumToCard(el, d);
      const cue = d.cueIndex >= 0 ? d.cueIndex : Math.max(0, d.tracks.findIndex((t) => t.title === item.title));
      songCue.set(item.albumId, cue);
      draw(d.tracks, cue);
    };
    const cached = albumDetailCache.get(item.albumUri);
    if (cached) {
      apply(cached);
      return;
    }
    try {
      const d = await client.getProviderAlbum(item.albumUri);
      albumDetailCache.set(item.albumUri, d);
      if (openIdx === i) apply(d);
    } catch {
      /* leave empty */
    }
    return;
  }
  const selected = songCue.get(item.albumId) ?? -1; // keep any tapped selection on re-render
  const cached = trackCache.get(item.albumId);
  if (cached) {
    draw(cached, selected);
    return;
  }
  try {
    const detail = await client.getAlbum(item.albumId);
    trackCache.set(item.albumId, detail.tracks);
    if (openIdx === i) draw(detail.tracks, selected);
  } catch {
    /* leave empty */
  }
}

/** Repaint an opened song spine's card with its album's cover/title/artist. */
function applyAlbumToCard(el: HTMLElement, d: ProviderAlbumDetail): void {
  const cover = el.querySelector('.face-cover') as HTMLElement | null;
  if (cover && d.artworkUrl) {
    cover.style.backgroundImage = `url('${d.artworkUrl}')`;
    cover.style.backgroundSize = 'cover';
    cover.classList.add('has-art');
  }
  const coverType = el.querySelector('.cover-type') as HTMLElement | null;
  if (coverType) coverType.textContent = d.title;
  const h1 = el.querySelector('.panel h1') as HTMLElement | null;
  if (h1) h1.textContent = d.title;
  const h2 = el.querySelector('.panel h2') as HTMLElement | null;
  if (h2) h2.textContent = d.artist;
}

function fmtDur(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- Playback ---------- */
/** Has the user picked a different room or track than what's currently playing? Then
    the Play button commits that change (plays the selection) instead of pausing. */
function selectionChanged(i: number): boolean {
  const item = items[i];
  if (!item) return false;
  const cued = songCue.get(item.albumId);
  const roomChanged = activePlayerId != null && activePlayerId !== now.playerId;
  const trackChanged = cued != null && cued !== now.trackIndex;
  return roomChanged || trackChanged;
}

/** Panel Play button: plays the current selection (cued track on the chosen room) —
    this is how you retarget the speaker or jump songs. Only when this album is already
    playing AND nothing's changed does it toggle pause/resume. Skip lives in the nowbar. */
async function onPlayButton(i: number): Promise<void> {
  if (playingIdx === i && now.playerId && now.state !== 'idle' && !selectionChanged(i)) {
    const playerId = now.playerId;
    const pausing = now.state === 'playing';
    // Freeze at the displayed (interpolated) position so pause doesn't jump back.
    now.elapsed = liveElapsed();
    now.at = performance.now();
    now.state = pausing ? 'paused' : 'playing';
    userPaused = pausing;
    pauseGuardUntil = pausing ? performance.now() + 3000 : 0;
    resumeGuardUntil = pausing ? 0 : performance.now() + 8000;
    if (!pausing) {
      // Resume gets the same protection as a fresh play: latch the controls in the
      // transport state so they don't flash to the big Play button while MA propagates
      // the resume (Sonos briefly reports the queue idle before it lands).
      playPendingIdx = i;
      playPendingUntil = performance.now() + 8000;
      // Resuming a room that was paused on this album is still a "move" — stop any OTHER
      // room playing this same album (e.g. the one you switched away from), unless it's
      // grouped with this one. (Pausing never stops anyone else.)
      const keep = new Set(groupMembers(leaderOf(playerId)).map((r) => r.id));
      keep.add(playerId);
      stopOtherRoomsPlayingAlbum(now.albumId ?? '', openCardAlbumUri() ?? undefined, keep);
    }
    applyNow();
    await client.transport({ playerId, cmd: pausing ? 'pause' : 'play' }).catch(() => {});
    return;
  }
  await playCard(i);
}

/** On Play, if a still-grouped speaker was picked individually, pull it out of its
    group first (deferred from selection so a mis-tap doesn't disband the group). */
async function ungroupActiveSoloIfNeeded(): Promise<void> {
  if (!activePlayerId || !activeSolo) return;
  const solo = activePlayerId;
  const members = groupMembers(leaderOf(solo)).map((r) => r.id);
  if (members.length < 2) return;
  const remaining = members.filter((x) => x !== solo);
  setLeaderLocal(solo, solo);
  remaining.forEach((m) => setLeaderLocal(m, remaining[0] ?? solo));
  armGroupGuard();
  renderRoomUIs();
  await client.group({ playerIds: remaining }).catch(() => {});
  // The speakers we left behind keep the old queue playing — stop them, since we're
  // redirecting playback to the pulled-out speaker.
  if (remaining[0]) void client.transport({ playerId: remaining[0], cmd: 'pause' }).catch(() => {});
}

/** "Move" semantics: starting an album on the selected room/group stops any OTHER
    room that was playing this SAME album, so playback moves rather than duplicating.
    Grouping (the +1 chips) stays the way to play in several rooms at once; rooms on a
    DIFFERENT album are left alone (that's independent playback, not a move). */
function stopOtherRoomsPlayingAlbum(albumId: string, albumUri: string | undefined, keep: Set<string>): void {
  for (const s of lastStates) {
    if (keep.has(s.playerId) || (s.state !== 'playing' && s.state !== 'paused')) continue;
    const np = s.nowPlaying;
    if (!np) continue;
    const onAlbum = (!!np.albumId && np.albumId === albumId) || (!!albumUri && !!np.albumUri && np.albumUri === albumUri);
    if (onAlbum) void client.transport({ playerId: s.playerId, cmd: 'pause' }).catch(() => {});
  }
}

async function play(i: number, trackIndex?: number, opts?: { autoAdvance?: boolean }): Promise<void> {
  const item = items[i]!;
  // Latch the controls to "playing this" up front (before any await) so they never
  // flicker — even for the one frame before the optimistic now-state is set below.
  playPendingIdx = i;
  playPendingUntil = performance.now() + 8000;
  if (activePlayerId) focusedPlayerId = activePlayerId;
  if (openIdx === i) updatePlayButton();
  await ungroupActiveSoloIfNeeded();

  // A playlist-shelf song plays the PLAYLIST from here on — the tapped song then the rest
  // of the shelf's songs in its curated order — so it continues through the playlist rather
  // than rolling into the tapped song's album. (Each playlist song spine carries its own
  // track uri in `albumUri`; the shelf order is the curation.)
  if (item.kind === 'playlist' && item.albumUri) {
    const uris = items
      .slice(i)
      .filter((it) => it.kind === 'playlist' && it.albumUri)
      .map((it) => it.albumUri as string);
    userPaused = false;
    pauseGuardUntil = 0;
    resumeGuardUntil = performance.now() + 8000;
    selfPlayUntil = performance.now() + 8000;
    songCue.delete(item.albumId);
    now = { playerId: activePlayerId, albumId: item.albumId, trackIndex: 0, trackUri: item.albumUri, elapsed: 0, duration: 0, state: 'playing', mediaKind: 'playlist', at: performance.now() };
    applyNow();
    if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
    if (!opts?.autoAdvance) scheduleAfterPlayClose();
    showToast(`Sent to ${roomName(activePlayerId)}…`);
    afterAlbumWatch = null; // the playlist queue continues on its own
    playPendingUri = item.albumUri; // the tapped track's uri confirms the room started
    playPendingAlbum = null; // a playlist song reports its track's album, not a name we know here
    client
      .play({ albumId: item.albumId, ...(activePlayerId ? { playerId: activePlayerId } : {}), trackUris: uris })
      .catch((e) => {
        console.error('play failed', e);
        showPlayError(e);
      });
    return;
  }

  // A song spine plays its ALBUM: resolve the real album uri (its `albumUri` is
  // the track uri) and cue either the explicitly-tapped row or the song's index.
  const song = !!item.albumUri;
  let providerUri: string | undefined;
  let cue = trackIndex ?? songCue.get(item.albumId) ?? 0; // the tapped/selected track
  if (song) {
    let d = albumDetailCache.get(item.albumUri as string);
    if (!d) {
      try {
        d = await client.getProviderAlbum(item.albumUri as string);
        albumDetailCache.set(item.albumUri as string, d);
      } catch {
        /* fall back to playing the track itself */
      }
    }
    if (d) {
      providerUri = d.providerUri;
      if (trackIndex === undefined) cue = songCue.get(item.albumId) ?? (d.cueIndex >= 0 ? d.cueIndex : 0);
    } else {
      providerUri = item.albumUri as string;
      cue = 0;
    }
  }
  // Optimistic now-state FIRST (before the network call, which can take a few seconds
  // while the album queue populates) so the controls flip to "playing this" instantly
  // and don't reflect the stale/loading state. The guard holds it through the load.
  userPaused = false;
  pauseGuardUntil = 0;
  resumeGuardUntil = performance.now() + 8000;
  selfPlayUntil = performance.now() + 8000; // Crate started this — not "external"
  // (focus pin + play latch were set up front, before the awaits above.)
  // Selection is now committed to playback — clear it so the transient where the player
  // is still on the old track doesn't read as a pending change (flipping Pause→Play).
  songCue.delete(item.albumId);
  now = { playerId: activePlayerId, albumId: item.albumId, trackIndex: cue, trackUri: null, elapsed: 0, duration: 0, state: 'playing', mediaKind: item.kind, at: performance.now() };
  // Move, don't duplicate: stop other rooms already on this album that aren't part of
  // the target group (its EQ then clears once the pause lands — background paused rooms
  // show no marker). Grouped members stay, so a group keeps playing together.
  if (activePlayerId) {
    const keep = new Set(groupMembers(leaderOf(activePlayerId)).map((r) => r.id));
    keep.add(activePlayerId);
    stopOtherRoomsPlayingAlbum(item.albumId, providerUri ?? item.providerUri ?? undefined, keep);
  }
  applyNow();
  if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement); // target room EQ now
  if (!opts?.autoAdvance) scheduleAfterPlayClose();
  showToast(`Sent to ${roomName(activePlayerId)}…`);
  // Watch for this album ending so we can roll on to the next spine (afterAlbum='next').
  afterAlbumWatch = { albumId: item.albumId, playerId: activePlayerId };
  playPendingUri = providerUri ?? item.providerUri ?? null; // to confirm the room really started
  playPendingAlbum = item.title; // name fallback when MA reports a normalized uri
  client
    .play({
      albumId: item.albumId,
      ...(activePlayerId ? { playerId: activePlayerId } : {}),
      ...(providerUri ? { providerUri } : {}),
      ...(cue > 0 ? { trackIndex: cue } : {}),
    })
    .then(() => applyPlayModes(activePlayerId))
    .catch((e) => {
      console.error('play failed', e);
      showPlayError(e);
    });
}

/** Apply the album view's shuffle + the global after-album behavior to the just-started
    queue: shuffle is set explicitly; queue repeat loops only when afterAlbum is 'repeat'
    (leaving it off so 'next'/'stop' can fire). */
function applyPlayModes(playerId: string | null): void {
  if (!playerId) return;
  void client.setShuffle({ playerId, enabled: cardShuffle }).catch(() => {});
  void client.setRepeat({ playerId, mode: settings.afterAlbum === 'repeat' ? 'all' : 'off' }).catch(() => {});
}

/* ---- Album-view shuffle + after-album (repeat) controls ---- */
/** Is the open album i the one actually playing on the mode target room right now? */
function albumIsPlayingHere(i: number): boolean {
  const it = items[i];
  if (!it) return false;
  const s = lastStates.find((x) => x.playerId === modeTarget());
  if (!s || s.state === 'idle') return false;
  return (
    (!!s.nowPlaying?.albumId && s.nowPlaying.albumId === it.albumId) ||
    (!!it.providerUri && s.nowPlaying?.albumUri === it.providerUri)
  );
}
// The repeat button cycles the global "when an album ends" behavior (synced with admin).
const AFTERALBUM_CYCLE: AfterAlbum[] = ['stop', 'repeat', 'next'];
/** True if whatever surface is showing (the open card OR the play-now overlay) is showing
    the album that's actually playing — so its shuffle button reflects the live queue. */
function shownAlbumIsPlaying(): boolean {
  if (openIdx !== null) return albumIsPlayingHere(openIdx);
  if (!albumModal.hidden) return modalIsPlaying();
  return false;
}
/** Render the shuffle + after-album buttons inside one card/overlay root. Both surfaces
    read the same shared state (cardShuffle + settings.afterAlbum), so they never drift. */
function renderModesIn(root: HTMLElement | null, playing: boolean): void {
  const shuf = root?.querySelector('.card-shuffle');
  const rep = root?.querySelector('.card-repeat') as HTMLElement | null;
  if (!shuf || !rep) return;
  if (!shuf.querySelector('svg')) shuf.innerHTML = ICON_SHUFFLE; // overlay button starts empty
  shuf.classList.toggle('on', playing ? queueModes().shuffle : cardShuffle);
  const aa = settings.afterAlbum;
  rep.classList.toggle('on', aa !== 'stop');
  rep.innerHTML = aa === 'next' ? ICON_ARROW : ICON_REPEAT;
  rep.setAttribute('aria-label', aa === 'next' ? 'Play next album' : aa === 'repeat' ? 'Repeat album' : 'Stop after album');
}
/** Reflect the shuffle + after-album buttons on every surface currently showing. */
function renderCardModes(): void {
  if (openIdx !== null) renderModesIn(shelf.children[openIdx] as HTMLElement, albumIsPlayingHere(openIdx));
  if (!albumModal.hidden) renderModesIn(albumModal.querySelector('.am-card') as HTMLElement, modalIsPlaying());
}
/** Toggle shuffle (shared across card + overlay); drive the live queue if what's shown
    is playing, else it's the pre-play intent applied on the next Play. */
function toggleShuffle(): void {
  const playing = shownAlbumIsPlaying();
  cardShuffle = !(playing ? queueModes().shuffle : cardShuffle);
  if (playing) {
    const pid = modeTarget();
    if (pid) void client.setShuffle({ playerId: pid, enabled: cardShuffle }).catch(() => {});
  }
  renderCardModes();
}
/** Cycle the after-album behavior (stop → repeat → next), persist it (syncs with the
    admin + the other surface), and reflect repeat on the live queue if what's shown plays. */
function cycleAfterAlbum(): void {
  const next = AFTERALBUM_CYCLE[(AFTERALBUM_CYCLE.indexOf(settings.afterAlbum) + 1) % AFTERALBUM_CYCLE.length]!;
  settings.afterAlbum = next;
  void client.putSettings({ afterAlbum: next }).catch(() => {});
  if (shownAlbumIsPlaying()) {
    const pid = modeTarget();
    if (pid) void client.setRepeat({ playerId: pid, mode: next === 'repeat' ? 'all' : 'off' }).catch(() => {});
  }
  renderCardModes();
}

/** Skip the current playback by ±N seconds (spoken-word transport). Optimistically moves the
    seek bar, then seeks the real player. */
function skipSeconds(delta: number): void {
  if (!now.playerId || now.duration <= 0) return;
  const pos = Math.max(0, Math.min(now.duration, Math.round(liveElapsed() + delta)));
  now.elapsed = pos;
  now.at = performance.now();
  applyNow();
  void client.transport({ playerId: now.playerId, cmd: 'seek', position: pos }).catch(() => {});
}

let afterPlayTimer: ReturnType<typeof setTimeout> | undefined;
/** After play, close the card immediately, after a linger, or leave it open
    (setting). 'stay' will later also auto-close on the proximity sensor (§7). */
function scheduleAfterPlayClose(): void {
  if (afterPlayTimer) clearTimeout(afterPlayTimer);
  if (settings.afterPlay === 'close') {
    closeAlbum();
  } else if (settings.afterPlay === 'linger') {
    afterPlayTimer = setTimeout(() => closeAlbum(), Math.max(1, settings.afterPlayLingerSec) * 1000);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

/** Toast a playback error with the real reason when it's a stream failure — e.g. Music Assistant
    returns "Failed to stream audio" when a source (notably Spotify) can't stream to this speaker,
    which otherwise looked like a mysterious "Playback failed". */
function showPlayError(e: unknown): void {
  const msg = String((e as Error)?.message ?? e);
  showToast(/failed to stream|stream audio/i.test(msg) ? "Couldn't stream — this source can't play to that speaker" : 'Playback failed');
}

/* ---------- Settings ---------- */
const settingsEl = document.getElementById('settings') as HTMLElement;
/** Open the Settings sheet (launched from the Find bar). Device status
    (brightness/IP/appliance) lives in Settings now, so refresh it on open. */
function openSettings(): void {
  settingsEl.classList.add('open');
  refreshSystem();
}
const settingsCard = document.getElementById('settings-card') as HTMLElement;
(document.getElementById('settings-close') as HTMLElement).onclick = () => settingsEl.classList.remove('open');
// Tap any black space (the overlay padding or empty areas of the card/panes) to close.
// But releasing a slider drag off the track fires a click whose target is the pane
// (the common ancestor of press-on-slider + release-on-pane), which would wrongly
// close. Track whether the gesture began on a slider and swallow that one click.
let settingsSliderGesture = false;
settingsEl.addEventListener('pointerdown', (e) => {
  settingsSliderGesture = !!(e.target as HTMLElement).closest('input[type="range"]');
});
settingsEl.addEventListener('click', (e) => {
  if (settingsSliderGesture) {
    settingsSliderGesture = false;
    return;
  }
  const t = e.target as HTMLElement;
  if (t === settingsEl || t === settingsCard || t.classList.contains('set-pane')) settingsEl.classList.remove('open');
});

/** Close an open sheet when the user swipes it back the way it came (opposite of
    the opening swipe). Ignores drags that begin on a slider so volume still works. */
function swipeToClose(sheet: HTMLElement, dir: 'up' | 'down' | 'left' | 'right', close: () => void): void {
  let start = 0;
  let active = false;
  const horiz = dir === 'left' || dir === 'right';
  sheet.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('input[type="range"]')) {
      active = false;
      return;
    }
    active = true;
    start = horiz ? e.clientX : e.clientY;
  });
  sheet.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    const d = (horiz ? e.clientX : e.clientY) - start;
    const shouldClose = dir === 'up' || dir === 'left' ? d < -45 : d > 45;
    if (shouldClose) close();
  });
}

function applyTextDir(): void {
  shelf.classList.toggle('text-btt', settings.spineTextDir === 'btt');
}

/** Reserve a uniform year gutter (global) so every label aligns and never
    collides with the year. Only the year's side is padded; off = no gutter. */
function applyYearGutter(): void {
  shelf.classList.remove('ygut-top', 'ygut-bottom');
  if (settings.yearDisplay !== 'off') {
    shelf.classList.add(settings.yearPos === 'top' ? 'ygut-top' : 'ygut-bottom');
  }
}

/** Year imprint legibility (global): 'bold' bumps size/opacity via a shelf class
    (styling only, so no rebuild is needed). */
function applyYearEmphasis(): void {
  shelf.classList.toggle('year-bold', settings.yearEmphasis === 'bold');
}

function choiceRow(
  wrapId: string,
  opts: ReadonlyArray<readonly [string, string, string]>,
  isOn: (key: string) => boolean,
  onPick: (key: string) => void,
): void {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const [key, name] of opts) {
    const b = document.createElement('button');
    b.className = 'choice' + (isOn(key) ? ' on' : '');
    b.textContent = name; // compact, uniform buttons — explanations move to the "?" tooltip
    b.onclick = () => onPick(key);
    wrap.appendChild(b);
  }
  attachHelp(wrapId);
}

/** One concise explanation per setting — every setting gets a "?" for uniformity. */
const SETTING_HELP: Record<string, string> = {
  'spine-choices': 'Use a real scanned spine when one is available, otherwise generate one from the cover art.',
  'thickness-choices': 'How thick each CD spine looks on the shelf.',
  'width-choices': "Give every spine the same width, or scale each by the album's runtime.",
  'dir-choices': 'Which way the spine text reads — top-to-bottom or bottom-to-top.',
  'ink-choices': "Guaranteed-contrast white/black label text, or tint the title with the album's accent color.",
  'inksize-choices': 'Size of the spine label text.',
  'inkweight-choices': 'Thickness of the spine label text.',
  'year-choices': 'Show the release year on the spine (vertical or horizontal), or hide it.',
  'yearpos-choices': 'Which end of the spine the year sits at.',
  'yearemph-choices': 'A faint catalog stamp, or bolder text readable from across the room.',
  'layout-choices': 'Where the artist and title sit along the spine.',
  'vary-choices': 'One shared font for every spine, or a different type style per artist.',
  'open-choices': 'Tapping a spine shows just the cover, or a full details card.',
  'pinchzoom-choices': 'What a two-finger pinch on the shelf does — resize the whole shelf, show a magnifier loupe, or nothing.',
  'afterplay-choices': 'What the open card does after you hit play.',
  'afterplaylinger-choices': 'How long the card lingers before closing, when “After playing” is set to Linger.',
  'afteralbum-choices': "When an album's last track ends: play the next album on the shelf, repeat it, or stop.",
  'glow-choices': "A soft halo of the cover's art cast behind an opened album.",
  'glowradius-choices': 'How far the glow spreads out around the cover.',
  'glowintensity-choices': 'How bright and saturated the glow is.',
  'autobright-choices': 'Adjust screen brightness automatically from the ambient-light sensor.',
  'sensor-idle-choices': 'Go idle when the proximity sensor stops seeing anyone nearby.',
  'sensor-wake-choices': 'Wake from idle when the proximity sensor detects someone.',
  'idle-after-choices': 'How long with no interaction before the wall goes idle. “Never” keeps it awake.',
  'idle-dim-choices': 'Dim the screen while idle (to the brightness set below).',
  'screen-off-choices': 'Second stage: turn the screen off after this long idle, so the wall can show something for a while and then sleep. “Never” keeps it on.',
  'idle-content-choices': 'What the wall shows when idle — nothing, the now-playing album, the current shelf, a chosen shelf, or a slideshow that flips through albums.',
  'idle-shelf-choices': 'The shelf shown for “A shelf”, or the slideshow’s source when it’s set to a shelf.',
  'autoopen-every-choices': 'How often the slideshow advances to the next album.',
  'autoopen-pool-choices': 'Which albums the slideshow draws from — all, the current shelf, or a chosen shelf.',
  'autoopen-random-choices': 'Slideshow order — shuffle, or follow shelf order.',
  'extopen-choices': "When music starts from another app, the idle wall flips that album open so it matches what's playing.",
};

/* ---------- Settings help tooltip ---------- */
const setTip = document.getElementById('set-tip') as HTMLElement;
let tipAnchor: HTMLElement | null = null;
function showTip(anchor: HTMLElement, text: string): void {
  if (tipAnchor === anchor) {
    hideTip();
    return;
  }
  setTip.textContent = text;
  setTip.classList.add('show');
  const r = anchor.getBoundingClientRect();
  let left = r.left + r.width / 2 - setTip.offsetWidth / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - setTip.offsetWidth - 8));
  let top = r.bottom + 8;
  if (top + setTip.offsetHeight > window.innerHeight - 8) top = r.top - setTip.offsetHeight - 8;
  setTip.style.left = `${left}px`;
  setTip.style.top = `${top}px`;
  tipAnchor = anchor;
}
function hideTip(): void {
  setTip.classList.remove('show');
  tipAnchor = null;
}
window.addEventListener('click', (e) => {
  if (tipAnchor && e.target !== tipAnchor && !setTip.contains(e.target as Node)) hideTip();
});

/** Add a "?" next to a setting's label that reveals its explanation on tap
    (kept out of the buttons so they stay compact). Every setting gets one. */
function attachHelp(wrapId: string): void {
  const label = document.getElementById(wrapId)?.closest('.setting-row')?.querySelector('.label') as HTMLElement | null;
  const text = SETTING_HELP[wrapId];
  if (!label || !text || label.querySelector('.tip-btn')) return;
  const q = document.createElement('button');
  q.className = 'tip-btn';
  q.type = 'button';
  q.textContent = '?';
  q.setAttribute('aria-label', 'What is this?');
  q.onclick = (e) => {
    e.stopPropagation();
    showTip(q, text);
  };
  label.appendChild(q);
}

/* ---------- Settings tabs (Shelf / Device) ---------- */
document.querySelectorAll<HTMLElement>('.set-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const pane = tab.dataset['pane'];
    document.querySelectorAll('.set-tab').forEach((t) => t.classList.toggle('on', t === tab));
    document
      .querySelectorAll<HTMLElement>('.set-pane')
      .forEach((p) => p.classList.toggle('on', p.dataset['pane'] === pane));
  });
});

function renderChoices(): void {
  choiceRow(
    'spine-choices',
    [
      ['scan', 'Real when available', 'Scanned spines, generated fallback'],
      ['art', 'Generated', 'Spine from the album cover edge'],
    ],
    (k) => (k === 'scan' ? settings.spineMode === 'scan' : settings.spineMode !== 'scan'),
    (k) => {
      settings.spineMode = k as SpineMode;
      buildShelf();
      sizeFaces();
      void client.putSettings({ spineMode: settings.spineMode }).catch(() => {});
    },
  );

  choiceRow(
    'thickness-choices',
    [['thin', 'Thin', ''], ['medium', 'Medium', ''], ['thick', 'Thick', '']],
    (k) => settings.spineThickness === k,
    (k) => {
      settings.spineThickness = k as SpineThickness;
      buildShelf();
      sizeFaces();
      void client.putSettings({ spineThickness: settings.spineThickness }).catch(() => {});
    },
  );

  choiceRow(
    'width-choices',
    [
      ['uniform', 'Uniform', 'Every CD the same width'],
      ['duration', 'By length', 'Double-wide past 80 min (a 2-disc set)'],
    ],
    (k) => settings.spineWidthMode === k,
    (k) => {
      settings.spineWidthMode = k as SpineWidthMode;
      buildShelf();
      sizeFaces();
      void client.putSettings({ spineWidthMode: settings.spineWidthMode }).catch(() => {});
    },
  );

  choiceRow(
    'dir-choices',
    [['ttb', 'Top → bottom', ''], ['btt', 'Bottom → top', '']],
    (k) => settings.spineTextDir === k,
    (k) => {
      settings.spineTextDir = k as SpineTextDir;
      applyTextDir();
      renderChoices();
      void client.putSettings({ spineTextDir: settings.spineTextDir }).catch(() => {});
    },
  );

  choiceRow(
    'ink-choices',
    [
      ['contrast', 'Contrast', 'White or black — always readable'],
      ['match', 'Match accent', 'Title in the album color (test)'],
    ],
    (k) => settings.inkMode === k,
    (k) => {
      settings.inkMode = k as InkMode;
      buildShelf();
      sizeFaces();
      void client.putSettings({ inkMode: settings.inkMode }).catch(() => {});
    },
  );

  choiceRow(
    'inksize-choices',
    [['small', 'Small', ''], ['medium', 'Medium', ''], ['large', 'Large', '']],
    (k) => settings.inkSize === k,
    (k) => {
      settings.inkSize = k as InkSize;
      buildShelf();
      sizeFaces();
      void client.putSettings({ inkSize: settings.inkSize }).catch(() => {});
    },
  );

  choiceRow(
    'inkweight-choices',
    [['light', 'Light', ''], ['regular', 'Regular', ''], ['bold', 'Bold', '']],
    (k) => settings.inkWeight === k,
    (k) => {
      settings.inkWeight = k as InkWeight;
      buildShelf();
      sizeFaces();
      void client.putSettings({ inkWeight: settings.inkWeight }).catch(() => {});
    },
  );

  choiceRow(
    'glow-choices',
    [['1', 'On', ''], ['0', 'Off', '']],
    (k) => (settings.glowEnabled ? '1' : '0') === k,
    (k) => {
      settings.glowEnabled = k === '1';
      updateConditionalRows();
      if (openIdx !== null) positionGlow(openIdx);
      void client.putSettings({ glowEnabled: settings.glowEnabled }).catch(() => {});
    },
  );

  choiceRow(
    'glowradius-choices',
    [['small', 'Small', ''], ['medium', 'Medium', ''], ['large', 'Large', '']],
    (k) => settings.glowRadius === k,
    (k) => {
      settings.glowRadius = k as GlowRadius;
      if (openIdx !== null) positionGlow(openIdx);
      void client.putSettings({ glowRadius: settings.glowRadius }).catch(() => {});
    },
  );

  choiceRow(
    'glowintensity-choices',
    [['soft', 'Soft', ''], ['medium', 'Medium', ''], ['bold', 'Bold', '']],
    (k) => settings.glowIntensity === k,
    (k) => {
      settings.glowIntensity = k as GlowIntensity;
      if (openIdx !== null) positionGlow(openIdx);
      void client.putSettings({ glowIntensity: settings.glowIntensity }).catch(() => {});
    },
  );

  choiceRow(
    'year-choices',
    [['off', 'Off', ''], ['vertical', 'Vertical', ''], ['horizontal', 'Horizontal', '']],
    (k) => settings.yearDisplay === k,
    (k) => {
      settings.yearDisplay = k as YearDisplay;
      applyYearGutter();
      updateConditionalRows();
      buildShelf();
      sizeFaces();
      void client.putSettings({ yearDisplay: settings.yearDisplay }).catch(() => {});
    },
  );

  choiceRow(
    'yearpos-choices',
    [['top', 'Top', ''], ['bottom', 'Bottom', '']],
    (k) => settings.yearPos === k,
    (k) => {
      settings.yearPos = k as YearPos;
      applyYearGutter();
      buildShelf();
      sizeFaces();
      void client.putSettings({ yearPos: settings.yearPos }).catch(() => {});
    },
  );

  choiceRow(
    'yearemph-choices',
    [
      ['thin', 'Thin', 'Faint catalog stamp'],
      ['bold', 'Bold', 'Readable from across the room'],
    ],
    (k) => settings.yearEmphasis === k,
    (k) => {
      settings.yearEmphasis = k as YearEmphasis;
      applyYearEmphasis();
      renderChoices();
      void client.putSettings({ yearEmphasis: settings.yearEmphasis }).catch(() => {});
    },
  );

  choiceRow(
    'layout-choices',
    [
      ['split', 'Split', 'Artist top · title bottom'],
      ['center', 'Centered', 'Together, middle'],
      ['top', 'Top', 'Together, at the top'],
      ['bottom', 'Bottom', 'Together, at the base'],
      ['varied', 'Varied', 'Random per album'],
    ],
    (k) => settings.labelLayout === k,
    (k) => {
      settings.labelLayout = k as LabelLayout;
      buildShelf();
      sizeFaces();
      void client.putSettings({ labelLayout: settings.labelLayout }).catch(() => {});
    },
  );

  choiceRow(
    'vary-choices',
    [
      ['uniform', 'Uniform', 'One font for every spine'],
      ['varied', 'Varied', 'A different type style per artist'],
    ],
    (k) => settings.labelVary === k,
    (k) => {
      settings.labelVary = k as LabelVary;
      buildShelf(); // font variation is baked at build
      sizeFaces();
      void client.putSettings({ labelVary: settings.labelVary }).catch(() => {});
    },
  );

  choiceRow(
    'open-choices',
    [
      ['cover', 'Cover only', 'Art with play + menu buttons'],
      ['card', 'Full card', 'Cover plus details panel'],
    ],
    (k) => openMode === k,
    (k) => {
      openMode = k as OpenMode;
      renderChoices();
      void client.putSettings({ openMode }).catch(() => {});
    },
  );

  choiceRow(
    'afterplay-choices',
    [
      ['close', 'Close', 'Card closes right away'],
      ['linger', 'Linger', `Stays ~${settings.afterPlayLingerSec}s`],
      ['stay', 'Stay open', 'Until you close it'],
    ],
    (k) => settings.afterPlay === k,
    (k) => {
      settings.afterPlay = k as AfterPlay;
      renderChoices();
      updateConditionalRows(); // the linger-duration row only applies to "Linger"
      void client.putSettings({ afterPlay: settings.afterPlay }).catch(() => {});
    },
  );
  choiceRow(
    'afterplaylinger-choices',
    [['3', '3s', ''], ['5', '5s', ''], ['8', '8s', ''], ['15', '15s', ''], ['30', '30s', '']],
    (k) => String(settings.afterPlayLingerSec) === k,
    (k) => {
      settings.afterPlayLingerSec = Number(k);
      renderChoices(); // the "After playing → Linger ~Ns" hint reflects this
      void client.putSettings({ afterPlayLingerSec: settings.afterPlayLingerSec }).catch(() => {});
    },
  );
  choiceRow(
    'pinchzoom-choices',
    [
      ['spines', 'Resize spines', 'Scale the whole shelf'],
      ['loupe', 'Magnifier', 'A zoom lens follows your fingers'],
      ['off', 'Off', 'Disabled'],
    ],
    (k) => settings.pinchZoom === k,
    (k) => {
      settings.pinchZoom = k as typeof settings.pinchZoom;
      void client.putSettings({ pinchZoom: settings.pinchZoom }).catch(() => {});
    },
  );
  choiceRow(
    'afteralbum-choices',
    [
      ['next', 'Play next', 'Roll to the next album on the shelf'],
      ['repeat', 'Repeat', 'Loop this album'],
      ['stop', 'Stop', 'Stop when it ends'],
    ],
    (k) => settings.afterAlbum === k,
    (k) => {
      settings.afterAlbum = k as typeof settings.afterAlbum;
      void client.putSettings({ afterAlbum: settings.afterAlbum }).catch(() => {});
    },
  );
  choiceRow(
    'idle-after-choices',
    [['0', 'Never', ''], ['1', '1 min', ''], ['5', '5 min', ''], ['10', '10 min', ''], ['30', '30 min', ''], ['60', '1 hr', '']],
    (k) => String(settings.idleAfterMin) === k,
    (k) => {
      settings.idleAfterMin = Number(k);
      void client.putSettings({ idleAfterMin: settings.idleAfterMin }).catch(() => {});
      restartIdleWatch();
      updateConditionalRows(); // idle rows depend on whether idle can fire at all
    },
  );
  // Second idle stage — power the screen off after N minutes idle ("Never" = stays on).
  choiceRow(
    'screen-off-choices',
    [['0', 'Never', ''], ['10', '10 min', ''], ['30', '30 min', ''], ['60', '1 hr', ''], ['120', '2 hr', '']],
    (k) => String(settings.screenOffAfterMin) === k,
    (k) => {
      settings.screenOffAfterMin = Number(k);
      void client.putSettings({ screenOffAfterMin: settings.screenOffAfterMin }).catch(() => {});
      restartIdleWatch();
    },
  );
  // Dim while idle (on/off); the brightness slider below applies when it's on.
  choiceRow(
    'idle-dim-choices',
    [['1', 'On', ''], ['0', 'Off', '']],
    (k) => (settings.idleDim ? '1' : '0') === k,
    (k) => {
      settings.idleDim = k === '1';
      void client.putSettings({ idleDim: settings.idleDim }).catch(() => {});
      updateConditionalRows(); // show/hide the dim brightness slider
    },
  );
  if (idleDimSlider) {
    idleDimSlider.value = String(settings.idleDimPercent);
    if (idleDimVal) idleDimVal.textContent = `${settings.idleDimPercent}%`;
  }
  choiceRow(
    'idle-content-choices',
    [
      ['nothing', 'Nothing', ''],
      ['nowPlaying', 'Now playing', ''],
      ['currentShelf', 'Current shelf', ''],
      ['shelf', 'A shelf', ''],
      ['slideshow', 'Slideshow', ''],
    ],
    (k) => settings.idleContent === k,
    (k) => {
      settings.idleContent = k as IdleContent;
      void client.putSettings({ idleContent: settings.idleContent }).catch(() => {});
      updateConditionalRows();
    },
  );
  // One shelf picker (All + every album shelf) — drives idleShelf for either the "A shelf"
  // idle content or a shelf-sourced slideshow (only one is active at a time).
  const shelfOpts = (): ReadonlyArray<readonly [string, string, string]> => [
    ['all', 'All', ''],
    ...shelves.filter((s) => s.kind === 'album' && s.id !== 'all').map((s) => [s.id, s.name, ''] as const),
  ];
  choiceRow('idle-shelf-choices', shelfOpts(), (k) => (settings.idleShelf ?? 'all') === k, (k) => {
    settings.idleShelf = k === 'all' ? null : k;
    void client.putSettings({ idleShelf: settings.idleShelf }).catch(() => {});
    renderChoices();
  });
  choiceRow(
    'autoopen-every-choices',
    [['10', '10s', ''], ['15', '15s', ''], ['25', '25s', ''], ['45', '45s', ''], ['90', '90s', '']],
    (k) => String(settings.autoOpenEverySec) === k,
    (k) => {
      settings.autoOpenEverySec = Number(k);
      void client.putSettings({ autoOpenEverySec: settings.autoOpenEverySec }).catch(() => {});
    },
  );
  choiceRow(
    'autoopen-pool-choices',
    [['all', 'All albums', ''], ['current', 'Current shelf', ''], ['shelf', 'A shelf', '']],
    (k) => settings.autoOpenPool === k,
    (k) => {
      settings.autoOpenPool = k as import('@crate/shared').AutoOpenPool;
      void client.putSettings({ autoOpenPool: settings.autoOpenPool }).catch(() => {});
      updateConditionalRows();
    },
  );
  choiceRow(
    'autoopen-random-choices',
    [['1', 'Shuffle', ''], ['0', 'In order', '']],
    (k) => (settings.autoOpenRandom ? '1' : '0') === k,
    (k) => {
      settings.autoOpenRandom = k === '1';
      void client.putSettings({ autoOpenRandom: settings.autoOpenRandom }).catch(() => {});
    },
  );
  const toggleRow = (id: string, get: () => boolean, set: (v: boolean) => void): void =>
    choiceRow(id, [['1', 'On', ''], ['0', 'Off', '']], (k) => (get() ? '1' : '0') === k, (k) => set(k === '1'));
  toggleRow('sensor-idle-choices', () => settings.idleUseSensor, (v) => {
    settings.idleUseSensor = v;
    void client.putSettings({ idleUseSensor: v }).catch(() => {});
  });
  toggleRow('sensor-wake-choices', () => settings.wakeOnSensor, (v) => {
    settings.wakeOnSensor = v;
    void client.putSettings({ wakeOnSensor: v }).catch(() => {});
  });
  toggleRow('autobright-choices', () => settings.autoBrightness, (v) => {
    settings.autoBrightness = v;
    void client.putSettings({ autoBrightness: v }).catch(() => {});
  });
  toggleRow('extopen-choices', () => settings.openOnExternalPlay, (v) => {
    settings.openOnExternalPlay = v;
    void client.putSettings({ openOnExternalPlay: v }).catch(() => {});
  });
  renderWallSchedule();
  renderPlayersPane();
  updateConditionalRows();
}

/* ---- Players settings pane (default speaker + exposure + group presets), mirrors admin ---- */
/** Whether a player is exposed to the wall: an explicit list wins, else real speakers only. */
function isExposedWall(p: Player): boolean {
  const ex = settings.exposedPlayers;
  return ex && ex.length ? ex.includes(p.id) : isSpeaker(p.type);
}
function renderPlayersPane(): void {
  const defWrap = document.getElementById('wall-default-player');
  const expWrap = document.getElementById('wall-exposed-players');
  if (!defWrap || !expWrap) return;

  // Default speaker — "Auto" (first available) + each exposed player.
  defWrap.innerHTML = '';
  const mkDef = (id: string | null, label: string): void => {
    const b = document.createElement('button');
    b.className = 'choice' + ((settings.defaultPlayerId ?? null) === id ? ' on' : '');
    b.textContent = label;
    b.onclick = () => {
      settings.defaultPlayerId = id;
      void client.putSettings({ defaultPlayerId: id }).catch(() => {});
      renderPlayersPane();
    };
    defWrap.appendChild(b);
  };
  mkDef(null, 'Auto');
  for (const p of players.filter(isExposedWall)) mkDef(p.id, p.name);

  // Shown on the wall — speakers first, then other devices; toggling stores an explicit
  // list (or null when it's back to the plain speaker default).
  expWrap.innerHTML = '';
  const speakerDefault = new Set(players.filter((p) => isSpeaker(p.type)).map((p) => p.id));
  const sameAsDefault = (s: Set<string>): boolean => s.size === speakerDefault.size && [...s].every((id) => speakerDefault.has(id));
  for (const p of [...players].sort((a, b) => Number(isSpeaker(b.type)) - Number(isSpeaker(a.type)))) {
    const b = document.createElement('button');
    b.className = 'choice' + (isExposedWall(p) ? ' on' : '') + (isSpeaker(p.type) ? '' : ' choice-other');
    b.textContent = p.available ? p.name : `${p.name} (offline)`;
    b.onclick = () => {
      const cur = new Set(players.filter(isExposedWall).map((x) => x.id));
      if (cur.has(p.id)) cur.delete(p.id);
      else cur.add(p.id);
      const next = cur.size === 0 || sameAsDefault(cur) ? null : [...cur];
      settings.exposedPlayers = next;
      void client.putSettings({ exposedPlayers: next }).catch(() => {});
      computeRooms();
      renderPlayersPane();
      if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
    };
    expWrap.appendChild(b);
  }

  renderWallPresets();
}
function renderWallPresets(): void {
  const wrap = document.getElementById('wall-presets');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!settings.groupPresets) settings.groupPresets = [];
  const save = (): void => void client.putSettings({ groupPresets: settings.groupPresets }).catch(() => {});
  settings.groupPresets.forEach((preset, i) => {
    const card = document.createElement('div');
    card.className = 'wall-preset';
    const top = document.createElement('div');
    top.className = 'wall-preset-top';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = preset.name;
    name.placeholder = 'Preset name';
    name.onchange = () => {
      preset.name = name.value.trim() || 'Group';
      save();
    };
    const del = document.createElement('button');
    del.className = 'choice wall-preset-del';
    del.textContent = '✕';
    del.onclick = () => {
      settings.groupPresets = settings.groupPresets.filter((_, j) => j !== i);
      save();
      renderWallPresets();
    };
    top.append(name, del);
    card.appendChild(top);
    const chips = document.createElement('div');
    chips.className = 'choices';
    for (const p of players.filter((p) => isExposedWall(p) || preset.playerIds.includes(p.id))) {
      const chip = document.createElement('button');
      chip.className = 'choice' + (preset.playerIds.includes(p.id) ? ' on' : '');
      chip.textContent = p.name;
      chip.onclick = () => {
        preset.playerIds = preset.playerIds.includes(p.id) ? preset.playerIds.filter((x) => x !== p.id) : [...preset.playerIds, p.id];
        chip.classList.toggle('on', preset.playerIds.includes(p.id));
        save();
      };
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    wrap.appendChild(card);
  });
  const add = document.createElement('button');
  add.className = 'choice wall-preset-add';
  add.textContent = '+ New preset';
  add.onclick = () => {
    settings.groupPresets = [...settings.groupPresets, { id: 'gp-' + Math.random().toString(36).slice(2, 9), name: 'New group', playerIds: [] }];
    save();
    renderWallPresets();
  };
  wrap.appendChild(add);
}

/* Per-weekday sleep schedule editor for the wall — mirrors the admin one. */
const SCHED_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function renderWallSchedule(): void {
  const wrap = document.getElementById('wall-schedule');
  if (!wrap) return;
  wrap.innerHTML = '';
  const sched = settings.sleepSchedule ?? [];
  const save = (): void => void client.putSettings({ sleepSchedule: settings.sleepSchedule }).catch(() => {});
  SCHED_DAYS.forEach((name, i) => {
    const day = sched[i] ?? { on: false, sleep: '23:00', wake: '07:00' };
    const row = document.createElement('div');
    row.className = 'sched-row' + (day.on ? '' : ' sched-off');
    const toggle = document.createElement('button');
    toggle.className = 'sched-day choice' + (day.on ? ' on' : '');
    toggle.textContent = name;
    toggle.onclick = () => {
      settings.sleepSchedule[i] = { ...day, on: !day.on };
      save();
      renderWallSchedule();
    };
    const sleep = document.createElement('input');
    sleep.type = 'time';
    sleep.value = day.sleep;
    sleep.onchange = () => {
      settings.sleepSchedule[i] = { ...settings.sleepSchedule[i]!, sleep: sleep.value };
      save();
    };
    const wake = document.createElement('input');
    wake.type = 'time';
    wake.value = day.wake;
    wake.onchange = () => {
      settings.sleepSchedule[i] = { ...settings.sleepSchedule[i]!, wake: wake.value };
      save();
    };
    const times = document.createElement('div');
    times.className = 'sched-times';
    const off = document.createElement('span');
    off.textContent = 'off at';
    const on = document.createElement('span');
    on.textContent = 'on at';
    times.append(off, sleep, on, wake);
    row.append(toggle, times);
    wrap.appendChild(row);
  });
}

/** Hide settings that only apply in another setting's state — the year position
    and emphasis are meaningless when the year is off. */
function updateConditionalRows(): void {
  const yearOn = settings.yearDisplay !== 'off';
  for (const id of ['yearpos-choices', 'yearemph-choices']) {
    document.getElementById(id)?.closest('.setting-row')?.classList.toggle('hidden-row', !yearOn);
  }
  // Radius/intensity only matter when the glow is on.
  for (const id of ['glowradius-choices', 'glowintensity-choices']) {
    document.getElementById(id)?.closest('.setting-row')?.classList.toggle('hidden-row', !settings.glowEnabled);
  }
  const show = (id: string, on: boolean): void =>
    void document.getElementById(id)?.closest('.setting-row')?.classList.toggle('hidden-row', !on);
  // The linger duration only applies when "After playing" is Linger.
  show('afterplaylinger-choices', settings.afterPlay === 'linger');
  // The "when idle" behaviors only matter if idle can ever trigger (a timer or the sensor).
  const idleOn = settings.idleAfterMin > 0 || settings.idleUseSensor;
  // Dim toggle + brightness slider live in one .setting-keep block: hide the whole block
  // when idle is off, and hide the brightness row unless dimming is on.
  document.querySelector('.setting-keep')?.classList.toggle('hidden-row', !idleOn);
  show('idle-dim-slider', settings.idleDim);
  show('screen-off-choices', idleOn);
  show('idle-content-choices', idleOn);
  // Slideshow cadence/source/order show only for the 'slideshow' idle content.
  const slideshow = idleOn && settings.idleContent === 'slideshow';
  for (const id of ['autoopen-every-choices', 'autoopen-pool-choices', 'autoopen-random-choices'])
    show(id, slideshow);
  // The single shelf picker applies to "A shelf" content or a shelf-sourced slideshow.
  const needsShelf = settings.idleContent === 'shelf' || (slideshow && settings.autoOpenPool === 'shelf');
  show('idle-shelf-choices', idleOn && needsShelf);
}

/* =====================================================================
   Control center (§6): a swipe-down top sheet with now-playing + transport,
   per-room volume & grouping, live shelf search, and sort. Opened from a thin
   top-edge grip so the horizontal shelf gesture engine below stays untouched.
   Brightness / display / system rows are deferred to the appliance layer.
   ===================================================================== */
const cc = document.getElementById('cc') as HTMLElement;
const ccGrip = document.getElementById('cc-grip') as HTMLElement;
const ccHandle = cc.querySelector('.cc-handle') as HTMLElement;
const ccArt = document.getElementById('cc-art') as HTMLElement;
const ccTitle = document.getElementById('cc-title') as HTMLElement;
const ccArtistEl = document.getElementById('cc-artist') as HTMLElement;
const ccSeekEl = document.getElementById('cc-seek') as HTMLElement;
const ccSeekFill = document.getElementById('cc-seek-fill') as HTMLElement;
const ccCur = document.getElementById('cc-cur') as HTMLElement;
const ccDur = document.getElementById('cc-dur') as HTMLElement;
const ccPlayPauseBtn = document.getElementById('cc-playpause') as HTMLElement;

/** Tap the now-playing hero → get back into what's playing: open it on the shelf if
    it's there, otherwise open the play-now overlay for it. */
function openNowPlaying(): void {
  if (now.state === 'idle') return;
  // Pin the hero/now-state to the player we're opening, so the card reflects its live
  // track + pause state (not another room that's also playing).
  if (now.playerId) focusedPlayerId = now.playerId;
  if (playingIdx !== null) {
    const i = playingIdx;
    closeCC();
    openAlbum(i);
    expand(shelf.children[i] as HTMLElement, true); // open the full extended card
    return;
  }
  const np = lastStates.find((s) => s.playerId === now.playerId)?.nowPlaying;
  if (np?.albumUri) {
    closeCC();
    // Bind to the playing room (like openAlbum does) so the overlay's volume slider tracks
    // external Sonos/speaker changes live, not just the extended card.
    if (now.playerId) {
      activePlayerId = now.playerId;
      activeSolo = groupMembers(leaderOf(now.playerId)).length < 2;
    }
    void openProviderAlbum(np.albumUri);
  }
}
[ccArt, ccTitle, ccArtistEl].forEach((el) => {
  el.style.cursor = 'pointer';
  el.addEventListener('click', openNowPlaying);
});

/** Which player's playback the now-playing hero follows (for multi-room). Null =
    auto-pick whatever's playing. Set by tapping a room name. */
let focusedPlayerId: string | null = null;
/** Which group cells have their member list expanded (by leader id) — per-group. */
const expandedGroups = new Set<string>();
/** 2-tap grouping: the "armed" room waiting for a second one to group with. */
let pendingGroup: string | null = null;
/** Album-card multi-select grouping: non-null = grouping mode is active in the
    play-target picker; the set holds the speaker ids chosen to become one group.
    Entered via the "Group" pill or a long-press on a room chip. */
let groupSelect: Set<string> | null = null;
/** Optimistic grouping guard: hold the just-applied grouping through stale MA
    frames for a moment so it doesn't flash apart and back. */
let groupOverride: Map<string, string> | null = null;
let groupGuardUntil = 0;

function ccIsOpen(): boolean {
  return cc.classList.contains('open');
}
function openCC(): void {
  // Grouping persists across open/close — don't reset it here.
  cc.classList.add('open');
  renderCCNow();
  renderCCRooms();
  renderSleepTimer(); // reflect the armed state + remaining time
}

/* ---- Sleep timer: pause playback after N minutes, or at the end of the current track. Pure
   client-side — the wall is an always-on kiosk, so a setTimeout is enough. ---- */
const ccSleepBtn = document.getElementById('cc-sleep-btn') as HTMLButtonElement;
const ccSleepRem = ccSleepBtn.querySelector('.cc-sleep-rem') as HTMLElement;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let sleepFireAt = 0; // performance.now() ms when it fires
let sleepChoice = 0; // selected data-min: 0 = off, -1 = end of track, else minutes
function clearSleepTimer(): void {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepFireAt = 0;
  sleepChoice = 0;
}
function fireSleep(): void {
  const pid = now.playerId ?? activePlayerId;
  clearSleepTimer();
  renderSleepTimer();
  if (pid) void client.transport({ playerId: pid, cmd: 'pause' }).catch(() => {});
  showToast('Sleep timer — paused');
}
function setSleepTimer(min: number): void {
  clearSleepTimer();
  let ms = 0;
  if (min === -1) {
    const remain = now.duration > 0 ? now.duration - liveElapsed() : 0;
    if (now.state !== 'playing' || remain <= 1) {
      showToast('Nothing playing');
      renderSleepTimer();
      return;
    }
    ms = remain * 1000;
  } else if (min > 0) {
    ms = min * 60000;
  }
  sleepChoice = min;
  if (ms > 0) {
    sleepFireAt = performance.now() + ms;
    sleepTimer = setTimeout(fireSleep, ms);
    showToast(min === -1 ? 'Sleep at end of track' : `Sleep timer — ${min} min`);
  } else {
    showToast('Sleep timer off');
  }
  renderSleepTimer();
}
function renderSleepTimer(): void {
  // Moon tints brass while armed; the small badge shows minutes left (blank for end-of-track).
  ccSleepBtn.classList.toggle('on', sleepChoice !== 0);
  ccSleepBtn.setAttribute('aria-label', sleepChoice === 0 ? 'Sleep timer' : sleepChoice === -1 ? 'Sleep timer — end of track' : `Sleep timer — ${Math.max(1, Math.round((sleepFireAt - performance.now()) / 60000))} min left`);
  ccSleepRem.textContent = sleepChoice > 0 ? `${Math.max(1, Math.round((sleepFireAt - performance.now()) / 60000))}m` : '';
}
const SLEEP_OPTS: Array<{ label: string; min: number }> = [
  { label: 'Off', min: 0 },
  { label: '15 minutes', min: 15 },
  { label: '30 minutes', min: 30 },
  { label: '45 minutes', min: 45 },
  { label: '1 hour', min: 60 },
  { label: 'End of track', min: -1 },
];
ccSleepBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openAddMenu(
    ccSleepBtn,
    SLEEP_OPTS.map((o) => ({ label: o.label, on: o.min === sleepChoice, fn: () => setSleepTimer(o.min) })),
  );
});
function closeCC(): void {
  cc.classList.remove('open');
}
cc.addEventListener('click', (e) => {
  if (e.target === cc) closeCC();
});
// Swipe the sheet back up (opposite of the opening swipe) to close.
swipeToClose(document.getElementById('cc-sheet') as HTMLElement, 'up', closeCC);

// Open: press the top-edge grip and drag down. Close: tap or swipe up the handle.
let gripDown = false,
  gripY = 0,
  gripOpened = false;
ccGrip.addEventListener('pointerdown', (e) => {
  gripDown = true;
  gripY = e.clientY;
  gripOpened = false;
});
let handleDown = false,
  handleY = 0;
ccHandle.addEventListener('pointerdown', (e) => {
  handleDown = true;
  handleY = e.clientY;
  e.stopPropagation();
});
window.addEventListener('pointermove', (e) => {
  if (gripDown && !gripOpened && e.clientY - gripY > 30) {
    openCC();
    gripOpened = true;
  }
});
window.addEventListener('pointerup', (e) => {
  if (gripDown) {
    // A tap on the top edge (grip shown or not) opens the control center.
    if (!gripOpened && Math.abs(e.clientY - gripY) < 8) openCC();
    gripDown = false;
  }
  if (handleDown) {
    handleDown = false;
    if (handleY - e.clientY > 40 || Math.abs(handleY - e.clientY) < 8) closeCC();
  }
});

/* =====================================================================
   Play queue ("Up Next"): a left-edge slide-in overlay. The current track is
   pinned at top; tap a row to jump, ✕ to remove, "Clear" to empty. Bound to the
   current play target; re-fetched on open and on state changes while open.
   ===================================================================== */
const queueEl = document.getElementById('queue') as HTMLElement;
const queueGrip = document.getElementById('queue-grip') as HTMLElement;
const queueListEl = document.getElementById('queue-list') as HTMLElement;
const queueClearBtn = document.getElementById('queue-clear') as HTMLButtonElement;
const queueRoomBtn = document.getElementById('queue-room') as HTMLButtonElement;
let queueOpen = false;
let queueSeq = 0;
let queueDragActive = false; // suppress live re-renders mid-drag (they'd detach the dragged rows)
let queueViewPlayer: string | null = null; // whose queue the overlay shows (may differ from the play target)

/** Rooms currently playing or paused — the ones with a real queue — deduped by group leader. */
function playingRooms(): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const s of lastStates) {
    if (s.state !== 'playing' && s.state !== 'paused') continue;
    const leader = leaderOf(s.playerId);
    if (seen.has(leader)) continue;
    seen.add(leader);
    out.push({ id: leader, name: roomName(leader) });
  }
  return out;
}
/** Default the overlay to the play target if it's playing, else the first playing room. */
function defaultQueuePlayer(): string | null {
  const playing = playingRooms();
  // Prefer the room whose playback the wall is currently showing (now.playerId), then the sticky
  // play target, then just the first playing room.
  for (const cand of [now.playerId, activePlayerId]) {
    if (!cand) continue;
    const lead = leaderOf(cand);
    if (playing.some((r) => r.id === lead)) return lead;
  }
  return playing[0]?.id ?? null;
}
/** Header selector: which speaker's queue is on screen. Tap to switch to another playing room
    (view-only — it doesn't change what the wall's Play targets). Hidden when nothing's playing. */
function renderQueueRoom(): void {
  const playing = playingRooms();
  if (!playing.length) {
    queueRoomBtn.hidden = true;
    return;
  }
  queueRoomBtn.hidden = false;
  const cur = playing.find((r) => r.id === queueViewPlayer);
  queueRoomBtn.textContent = `◉ ${cur?.name ?? roomName(queueViewPlayer)} ▾`;
  queueRoomBtn.onclick = (e) => {
    e.stopPropagation();
    openAddMenu(
      queueRoomBtn,
      playing.map((r) => ({
        label: r.name,
        on: r.id === queueViewPlayer,
        fn: () => {
          queueViewPlayer = r.id;
          renderQueueRoom();
          void refreshQueue();
        },
      })),
    );
  };
}
function openQueue(): void {
  queueOpen = true;
  queueEl.classList.add('open');
  queueViewPlayer = defaultQueuePlayer();
  renderQueueRoom();
  void refreshQueue();
}
function closeQueue(): void {
  queueOpen = false;
  queueEl.classList.remove('open');
}
async function refreshQueue(): Promise<void> {
  if (queueDragActive) return; // never re-render mid-drag — it would detach the rows being moved
  const pid = queueViewPlayer;
  const seq = ++queueSeq;
  if (!pid) {
    queueListEl.innerHTML = '<div class="q-empty">Nothing playing.</div>';
    return;
  }
  const res = await client.getQueue(pid).catch(() => null);
  if (seq !== queueSeq || !queueOpen || queueDragActive) return; // superseded, closed, or a drag started
  if (!res || !res.items.length) {
    queueListEl.innerHTML = '<div class="q-empty">Nothing queued.</div>';
    return;
  }
  queueListEl.innerHTML = '';
  // Show the current track, then everything after it (drop already-played rows).
  res.items.slice(res.currentIndex ?? 0).forEach((t) => queueListEl.appendChild(queueRow(t, pid)));
}
function queueRow(t: import('@crate/shared').QueueTrack, playerId: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'q-row' + (t.isCurrent ? ' q-current' : '');
  const art = t.artworkUrl ? ` style="background-image:url('${t.artworkUrl}')"` : '';
  row.innerHTML =
    `<span class="q-art"${art}></span>` +
    `<span class="q-meta"><span class="q-t">${escapeHtml(t.title)}</span>` +
    (t.subtitle ? `<span class="q-s">${escapeHtml(t.subtitle)}</span>` : '') +
    `</span>`;
  row.addEventListener('click', () => {
    void client
      .queuePlay(playerId, t.index)
      .then(() => setTimeout(() => void refreshQueue(), 400))
      .catch(() => showToast('Could not play'));
  });
  if (!t.isCurrent) {
    const drag = document.createElement('button');
    drag.className = 'q-drag';
    drag.setAttribute('aria-label', 'Drag to reorder');
    drag.textContent = '≡';
    wireQueueDrag(drag, row, playerId, t.id);
    row.insertBefore(drag, row.firstChild); // handle on the LEFT, before the artwork
    const x = document.createElement('button');
    x.className = 'q-x';
    x.setAttribute('aria-label', `Remove ${t.title} from the queue`);
    x.textContent = '✕';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      row.remove();
      void client.queueRemove(playerId, t.id).catch(() => {
        showToast('Could not remove');
        void refreshQueue();
      });
    });
    row.appendChild(x);
  } else {
    const tag = document.createElement('span');
    tag.className = 'q-now';
    tag.innerHTML = `${TRACK_EQ}<span>Now playing</span>`;
    row.appendChild(tag);
  }
  return row;
}

/** Drag a queue row (by its ≡ handle) up/down to reorder. The row lifts and follows the finger
    while the other upcoming rows slide to open a gap at the drop target, so it's clear where it
    will land. On release the DOM reorders to match, then MA's move_item + a refresh reconcile.
    Only upcoming rows are draggable (the current track stays pinned). */
function wireQueueDrag(handle: HTMLElement, row: HTMLElement, playerId: string, itemId: string): void {
  handle.addEventListener('click', (e) => e.stopPropagation()); // a tap on the handle isn't a jump
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const siblings = [...queueListEl.querySelectorAll('.q-row:not(.q-current)')] as HTMLElement[]; // draggable rows, incl. this
    const startIdx = siblings.indexOf(row);
    const rowH = row.offsetHeight + (parseFloat(getComputedStyle(queueListEl).rowGap) || 0);
    let dy = 0;
    let targetIdx = startIdx;
    queueDragActive = true;
    row.classList.add('q-dragging');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* older engines */
    }
    const onMove = (ev: PointerEvent): void => {
      dy = ev.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      targetIdx = rowH > 0 ? Math.max(0, Math.min(siblings.length - 1, startIdx + Math.round(dy / rowH))) : startIdx;
      // Slide the rows between origin and target to open a gap where it'll land ("part ways").
      siblings.forEach((s, i) => {
        if (s === row) return;
        let shift = 0;
        if (targetIdx > startIdx && i > startIdx && i <= targetIdx) shift = -rowH; // rows below fill upward
        else if (targetIdx < startIdx && i >= targetIdx && i < startIdx) shift = rowH; // rows above make way downward
        s.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      queueDragActive = false;
      row.classList.remove('q-dragging');
      siblings.forEach((s) => (s.style.transform = ''));
      row.style.transform = '';
      if (targetIdx === startIdx) return;
      // Commit: move the row to targetIdx among the draggable rows, then tell MA + reconcile.
      const others = siblings.filter((s) => s !== row);
      queueListEl.insertBefore(row, others[targetIdx] ?? null);
      void client
        .queueMove(playerId, itemId, targetIdx - startIdx)
        .then(() => setTimeout(() => void refreshQueue(), 500))
        .catch(() => {
          showToast('Could not reorder');
          void refreshQueue();
        });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}
queueClearBtn.addEventListener('click', () => {
  const pid = queueViewPlayer;
  if (!pid) return;
  void client
    .queueClear(pid)
    .then(() => void refreshQueue())
    .catch(() => showToast('Could not clear'));
});
queueEl.addEventListener('click', (e) => {
  if (e.target === queueEl) closeQueue(); // tap the backdrop to close
});
swipeToClose(queueEl, 'left', closeQueue);
// Open: press the left-edge grip and drag right (or tap it).
let qGripDown = false,
  qGripX = 0,
  qGripOpened = false;
queueGrip.addEventListener('pointerdown', (e) => {
  qGripDown = true;
  qGripX = e.clientX;
  qGripOpened = false;
});
window.addEventListener('pointermove', (e) => {
  if (qGripDown && !qGripOpened && e.clientX - qGripX > 30) {
    openQueue();
    qGripOpened = true;
  }
});
window.addEventListener('pointerup', (e) => {
  if (qGripDown) {
    if (!qGripOpened && Math.abs(e.clientX - qGripX) < 8) openQueue();
    qGripDown = false;
  }
});

/* ---- Transport ---- */
(document.getElementById('cc-prev') as HTMLElement).addEventListener('click', () => ccSkip('previous'));
(document.getElementById('cc-next') as HTMLElement).addEventListener('click', () => ccSkip('next'));
ccPlayPauseBtn.addEventListener('click', () => void ccPlayPause());

/* ---- Shuffle + repeat (reflect the target queue's state; toggle/cycle on tap) ---- */
const ccShuffleBtn = document.getElementById('cc-shuffle') as HTMLElement;
const ccRepeatBtn = document.getElementById('cc-repeat') as HTMLElement;
const ccBack10Btn = document.getElementById('cc-back10') as HTMLElement;
const ccFwd10Btn = document.getElementById('cc-fwd10') as HTMLElement;
const REPEAT_CYCLE: RepeatMode[] = ['off', 'all', 'one'];
function modeTarget(): string | null {
  return now.playerId ?? activePlayerId;
}
function queueModes(): { shuffle: boolean; repeat: RepeatMode } {
  const s = lastStates.find((x) => x.playerId === modeTarget());
  return { shuffle: s?.shuffle ?? false, repeat: s?.repeat ?? 'off' };
}
function renderCCModes(): void {
  // Kind-aware transport: radio is a single live stream → no shuffle/repeat/skip;
  // podcasts & audiobooks swap shuffle/repeat for ±10s skip; music keeps shuffle/repeat.
  const spoken = now.mediaKind === 'podcast' || now.mediaKind === 'audiobook';
  const modes = !spoken && now.mediaKind !== 'radio';
  // ±10s are live-transport controls — only show once the stream has actually started
  // (playing or paused), like the ⏮/⏭ skips; shuffle/repeat stay as pre-play intent.
  const started = spoken && now.state !== 'idle';
  ccShuffleBtn.style.display = modes ? '' : 'none';
  ccRepeatBtn.style.display = modes ? '' : 'none';
  ccBack10Btn.style.display = started ? '' : 'none';
  ccFwd10Btn.style.display = started ? '' : 'none';
  if (!modes) return;
  const q = queueModes();
  ccShuffleBtn.classList.toggle('on', q.shuffle);
  ccRepeatBtn.classList.toggle('on', q.repeat !== 'off');
  ccRepeatBtn.classList.toggle('repeat-one', q.repeat === 'one');
}
ccBack10Btn.addEventListener('click', () => skipSeconds(-10));
ccFwd10Btn.addEventListener('click', () => skipSeconds(10));
ccShuffleBtn.addEventListener('click', () => {
  const pid = modeTarget();
  if (!pid) return;
  const enabled = !queueModes().shuffle;
  ccShuffleBtn.classList.toggle('on', enabled); // optimistic
  void client.setShuffle({ playerId: pid, enabled }).catch(() => {});
});
ccRepeatBtn.addEventListener('click', () => {
  const pid = modeTarget();
  if (!pid) return;
  const cur = queueModes().repeat;
  const next = REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(cur) + 1) % REPEAT_CYCLE.length]!;
  ccRepeatBtn.classList.toggle('on', next !== 'off'); // optimistic
  ccRepeatBtn.classList.toggle('repeat-one', next === 'one');
  void client.setRepeat({ playerId: pid, mode: next }).catch(() => {});
});

function ccSkip(cmd: 'previous' | 'next'): void {
  if (!now.playerId) return;
  void client.transport({ playerId: now.playerId, cmd }).catch(() => {});
}
async function ccPlayPause(): Promise<void> {
  if (!now.playerId || !now.albumId || now.state === 'idle') {
    const i = openIdx ?? 0; // nothing loaded → start the open (or first) album
    if (items[i]) await play(i);
    return;
  }
  const pausing = now.state === 'playing';
  now.elapsed = liveElapsed();
  now.at = performance.now();
  now.state = pausing ? 'paused' : 'playing';
  userPaused = pausing;
  pauseGuardUntil = pausing ? performance.now() + 3000 : 0;
  resumeGuardUntil = pausing ? 0 : performance.now() + 3000;
  applyNow();
  await client.transport({ playerId: now.playerId, cmd: pausing ? 'pause' : 'play' }).catch(() => {});
}

ccSeekEl.addEventListener('click', (e) => {
  if (now.duration <= 0 || !now.playerId) return;
  const rect = ccSeekEl.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const pos = Math.floor(ratio * now.duration);
  now.elapsed = pos;
  now.at = performance.now();
  updateCCSeek();
  void client.transport({ playerId: now.playerId, cmd: 'seek', position: pos }).catch(() => {});
});

/* ---- Now-playing render ---- */
function renderCCNow(): void {
  if (!ccIsOpen()) return;
  renderCCModes(); // reflect the target queue's shuffle/repeat on the toggles
  // Prefer the shelf item (has cover art); fall back to the player's now-playing
  // metadata so the hero shows ANY room's content, even off the current shelf.
  const it = playingIdx !== null ? items[playingIdx] : null;
  const np = lastStates.find((s) => s.playerId === now.playerId)?.nowPlaying ?? null;
  const song = np?.title ?? null; // the current track
  const albumName = it?.title ?? np?.album ?? null;
  const title = song ?? albumName ?? '';
  if (now.state === 'idle' || !title) {
    ccArt.style.backgroundImage = '';
    ccArt.innerHTML = '';
    ccTitle.textContent = 'Nothing playing';
    ccArtistEl.textContent = '';
    ccPlayPauseBtn.innerHTML = ICON_PLAY;
    updateCCSeek();
    return;
  }
  const art = it?.artworkUrl ?? np?.artworkUrl ?? null;
  ccArt.style.backgroundImage = art ? `url('${art}')` : '';
  ccArt.innerHTML = art ? '' : ICON_SOURCE; // external source with no cover → placeholder glyph
  // SONG as the headline, artist + album beneath. External single-line sources (TV Audio, line-in)
  // have no artist/album, so the subtitle is empty — .cc-sub:empty collapses and the headline drops
  // right down onto the seek (same big header text as a song, just closer to the line).
  const artist = it?.artist ?? np?.artist ?? '';
  ccTitle.textContent = title;
  ccArtistEl.textContent = [artist, albumName && albumName !== title ? albumName : null].filter(Boolean).join(' · ');
  ccPlayPauseBtn.innerHTML = now.state === 'playing' ? ICON_PAUSE : ICON_PLAY;
  updateCCSeek();
}
function updateCCSeek(): void {
  if (!ccIsOpen()) return;
  if (now.duration > 0 && now.state !== 'idle') {
    const e = liveElapsed();
    ccSeekFill.style.width = `${Math.min(100, (e / now.duration) * 100)}%`;
    ccCur.textContent = fmtDur(e);
    ccDur.textContent = '-' + fmtDur(Math.max(0, now.duration - e)); // time remaining
  } else {
    ccSeekFill.style.width = '0';
    ccCur.textContent = '0:00';
    ccDur.textContent = '0:00';
  }
}

/* ---- Rooms: real groups (from MA state) + volume, focus, group/ungroup ---- */
function roomVol(id: string): number {
  return lastStates.find((s) => s.playerId === id)?.volume ?? volume;
}
/** While the user is actively dragging a volume slider we hold off syncing sliders
    from incoming MA frames, so a live update doesn't fight the drag. */
let volTouchUntil = 0;
function bumpVolTouch(): void {
  volTouchUntil = performance.now() + 1400;
}
function wireVolume(input: HTMLInputElement, playerId: string): void {
  input.dataset['pid'] = playerId; // lets syncCCVolumes push external changes back in
  input.addEventListener('pointerdown', bumpVolTouch);
  input.addEventListener('input', (e) => {
    bumpVolTouch();
    void client.setVolume({ playerId, level: +(e.target as HTMLInputElement).value }).catch(() => {});
  });
}
/** Reflect external volume changes (Sonos app / hardware buttons) on the open control
    center's room + group sliders, live — skipping any the user is mid-drag. */
function syncCCVolumes(): void {
  if (!ccIsOpen() || performance.now() < volTouchUntil) return;
  const wrap = document.getElementById('cc-rooms');
  if (!wrap) return;
  wrap.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((inp) => {
    if (inp === document.activeElement) return;
    const pid = inp.dataset['pid'];
    if (pid) {
      inp.value = String(roomVol(pid));
      return;
    }
    const leader = inp.dataset['group'];
    if (leader) {
      const m = groupMembers(leader);
      if (m.length) inp.value = String(Math.round(m.reduce((s, r) => s + roomVol(r.id), 0) / m.length));
    }
  });
}
/** The group leader a room is synced to (from MA state); solo rooms lead themselves. */
function leaderOf(id: string): string {
  return lastStates.find((s) => s.playerId === id)?.groupLeader ?? id;
}
/** Displayed rooms that share a leader (i.e. one group). */
function groupMembers(leader: string): Player[] {
  return rooms.filter((r) => leaderOf(r.id) === leader);
}

/** Sonos-style proportional group volumes: from a snapshot (member base levels + the group
    value at drag start) compute each member's level for a new group value. Up: approach 100
    by remaining headroom; down: scale toward 0 by ratio — so they reach 100 together going
    up and 0 together going down, preserving balance in between. */
function proportionalGroupVols(baseVols: number[], gOld: number, gNew: number): number[] {
  return baseVols.map((b) => {
    const raw =
      gNew >= gOld
        ? gOld < 100
          ? b + ((gNew - gOld) * (100 - b)) / (100 - gOld)
          : b
        : gOld > 0
          ? (b * gNew) / gOld
          : b;
    return Math.max(0, Math.min(100, Math.round(raw)));
  });
}
/** The active play target's group members (≥2), or [] when it's a solo speaker. */
function activeGroupMembers(): Player[] {
  if (!activePlayerId) return [];
  const m = groupMembers(leaderOf(activePlayerId));
  return m.length >= 2 ? m : [];
}
/** What the card/overlay volume slider should show: the group average when the target is a
    group, else the single active player's volume. */
function activeVol(): number {
  const m = activeGroupMembers();
  return m.length ? Math.round(m.reduce((s, r) => s + roomVol(r.id), 0) / m.length) : volume;
}
/** Fill a `.vol-members` overlay with per-member sliders; each sets its room and nudges the
    main (group) slider to the members' new average. */
function renderVolMembers(vol: HTMLElement): void {
  const wrap = vol.querySelector('.vol-members') as HTMLElement;
  const slider = vol.querySelector('.vol > input, .vol-row input') as HTMLInputElement | null;
  const main = (vol.querySelector(':scope > input') as HTMLInputElement) ?? slider;
  wrap.innerHTML = '';
  for (const r of activeGroupMembers()) {
    const row = document.createElement('div');
    row.className = 'vol-member';
    row.innerHTML =
      `<span class="vol-member-name">${escapeHtml(r.name)}</span>` +
      `<input type="range" min="0" max="100" value="${roomVol(r.id)}" data-id="${escapeHtml(r.id)}">`;
    const mi = row.querySelector('input') as HTMLInputElement;
    mi.addEventListener('input', () => {
      void client.setVolume({ playerId: r.id, level: +mi.value }).catch(() => {});
      const inputs = [...wrap.querySelectorAll('input')] as HTMLInputElement[];
      if (main) main.value = String(Math.round(inputs.reduce((s, x) => s + +x.value, 0) / inputs.length));
    });
    wrap.appendChild(row);
  }
}
/** Wire a card/overlay `.vol` block: proportional group control when the target is a group
    (with a caret that reveals per-member sliders), single-player otherwise. */
function wireVol(vol: HTMLElement): void {
  const slider = vol.querySelector(':scope > input') as HTMLInputElement;
  const caret = vol.querySelector('.vol-caret') as HTMLElement;
  const membersEl = vol.querySelector('.vol-members') as HTMLElement;
  let base: { g: number; vols: number[]; ids: string[] } | null = null;
  const snap = (): { g: number; vols: number[]; ids: string[] } => {
    const m = activeGroupMembers();
    return { g: +slider.value, vols: m.map((r) => roomVol(r.id)), ids: m.map((r) => r.id) };
  };
  slider.addEventListener('pointerdown', () => {
    base = snap();
  });
  slider.addEventListener('input', () => {
    const grp = activeGroupMembers();
    if (!grp.length) {
      volume = +slider.value;
      if (activePlayerId) void client.setVolume({ playerId: activePlayerId, level: volume }).catch(() => {});
      return;
    }
    if (!base || !base.ids.length) base = snap();
    const nv = proportionalGroupVols(base.vols, base.g, +slider.value);
    base.ids.forEach((id, i) => {
      void client.setVolume({ playerId: id, level: nv[i]! }).catch(() => {});
      const mi = membersEl.querySelector(`input[data-id="${CSS.escape(id)}"]`) as HTMLInputElement | null;
      if (mi) mi.value = String(nv[i]);
    });
  });
  slider.addEventListener('change', () => {
    base = null;
  });
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = membersEl.hidden;
    membersEl.hidden = !open;
    caret.classList.toggle('open', open);
    if (open) renderVolMembers(vol);
  });
}
/** Reflect the current target on a `.vol`: slider = active volume; caret only for a group;
    keep any open member overlay in sync. */
function syncVol(vol: HTMLElement | null): void {
  if (!vol) return;
  const slider = vol.querySelector(':scope > input') as HTMLInputElement | null;
  const caret = vol.querySelector('.vol-caret') as HTMLElement | null;
  const membersEl = vol.querySelector('.vol-members') as HTMLElement | null;
  const isGroup = activeGroupMembers().length >= 2;
  if (slider) slider.value = String(activeVol());
  if (caret) caret.hidden = !isGroup;
  if (membersEl && !membersEl.hidden) {
    if (!isGroup) {
      membersEl.hidden = true;
      caret?.classList.remove('open');
    } else {
      renderVolMembers(vol);
    }
  }
}

/** A fingerprint of the current grouping (each room → its leader), so we only
    re-render the room UIs when grouping actually changes. */
function groupSig(): string {
  return rooms.map((r) => leaderOf(r.id)).join(',');
}
let lastGroupSig = '';
let lastPlayingSig = ''; // which rooms are playing — re-render the grid when it changes
/** Optimistically set a player's leader locally (before MA confirms). */
function setLeaderLocal(playerId: string, leader: string): void {
  const s = lastStates.find((x) => x.playerId === playerId);
  if (s) s.groupLeader = leader;
}
/** Re-render both room UIs (control center + open album card) after a grouping
    change; records the new signature so the confirming state frame is a no-op. */
function renderRoomUIs(): void {
  lastGroupSig = groupSig();
  if (ccIsOpen()) renderCCRooms();
  if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
}

/** Snapshot the current (optimistic) grouping and hold it against stale MA frames
    for a few seconds, so a group/ungroup doesn't flash apart before MA catches up. */
function armGroupGuard(): void {
  groupOverride = new Map(rooms.map((r) => [r.id, leaderOf(r.id)]));
  groupGuardUntil = performance.now() + 3000;
}

/** Tap a room name to control it (hero follows its playback; new plays target
    it). Toggles off. Independent of grouping. */
function focusRoom(id: string): void {
  focusedPlayerId = focusedPlayerId === id ? null : id;
  if (focusedPlayerId) {
    activePlayerId = id;
    userPickedPlayer = true;
  }
  renderRoomUIs();
  handleState(lastStates);
}
/** 2-tap grouping: first "Group" arms a room, the second groups the two. Tapping
    the armed room again cancels. Optimistic + guarded. */
function groupRoom(id: string): void {
  if (pendingGroup === id) {
    pendingGroup = null;
    renderRoomUIs();
    return;
  }
  if (!pendingGroup) {
    pendingGroup = id;
    renderRoomUIs();
    return;
  }
  const leader = pendingGroup;
  const ids = [
    ...new Set([
      leader,
      id,
      ...groupMembers(leaderOf(leader)).map((r) => r.id),
      ...groupMembers(leaderOf(id)).map((r) => r.id),
    ]),
  ];
  ids.forEach((m) => setLeaderLocal(m, leader));
  armGroupGuard();
  pendingGroup = null;
  renderRoomUIs();
  void client.group({ playerIds: [leader, ...ids.filter((x) => x !== leader)] }).catch(() => {});
}
/** Add the armed room to an existing group (leader). Part of the same 2-tap flow:
    arm a room → tap "Add" on a group. */
function addToGroup(leader: string): void {
  if (!pendingGroup) return;
  const ids = [
    ...new Set([
      leader,
      pendingGroup,
      ...groupMembers(leader).map((r) => r.id),
      ...groupMembers(leaderOf(pendingGroup)).map((r) => r.id),
    ]),
  ];
  ids.forEach((m) => setLeaderLocal(m, leader));
  armGroupGuard();
  pendingGroup = null;
  renderRoomUIs();
  void client.group({ playerIds: [leader, ...ids.filter((x) => x !== leader)] }).catch(() => {});
}
/** Enter the album-card multi-select grouping mode, seeding the selection with the
    current play target's group (or the target itself) plus an optional room. */
function enterGroupSelect(seed: string | null, el: HTMLElement): void {
  const sel = new Set<string>();
  if (activePlayerId) {
    const m = groupMembers(leaderOf(activePlayerId));
    if (m.length >= 2) m.forEach((r) => sel.add(r.id));
    else sel.add(activePlayerId);
  }
  if (seed) sel.add(seed);
  groupSelect = sel;
  renderRooms(el);
}
/** Toggle a speaker in/out of the pending group selection. */
function toggleGroupSel(id: string, el: HTMLElement): void {
  if (!groupSelect) return;
  if (groupSelect.has(id)) groupSelect.delete(id);
  else groupSelect.add(id);
  renderRooms(el);
}
/** Commit the multi-select group: form one group from the chosen speakers, target it,
    and optimistically split off anyone left behind from an affected group. */
/** Commit the staged selection: form a group from 2+ speakers, or dissolve the group
    (ungroup) when only one is left selected. Nothing applies until this is called. */
function commitGroupSelection(el: HTMLElement): void {
  const sel = groupSelect ? [...groupSelect] : [];
  groupSelect = null;
  if (sel.length === 0) {
    renderRooms(el);
    return;
  }
  const leader = activePlayerId && sel.includes(activePlayerId) ? activePlayerId : sel[0]!;
  // Break any non-selected room out of a group whose membership we're changing, so the
  // optimistic view doesn't leave a stale grouping (MA reconciles within the guard window).
  const affected = new Set(sel.map((id) => leaderOf(id)));
  for (const r of rooms) {
    if (sel.includes(r.id)) continue;
    if (affected.has(leaderOf(r.id))) setLeaderLocal(r.id, r.id);
  }
  sel.forEach((id) => setLeaderLocal(id, leader));
  armGroupGuard();
  activePlayerId = leader;
  activeSolo = sel.length < 2;
  userPickedPlayer = true;
  renderRoomUIs();
  updatePlayButton();
  showToast(sel.length >= 2 ? `Grouped ${sel.length} speakers` : 'Ungrouped');
  // group([leader]) with no members dissolves the leader's group (everyone else removed).
  void client.group({ playerIds: [leader, ...sel.filter((x) => x !== leader)] }).catch(() => {});
}

/** Player ids in a preset that are actually pickable right now (exposed + available). */
function presetRooms(p: GroupPreset): string[] {
  return p.playerIds.filter((id) => rooms.some((r) => r.id === id));
}
/** Is this preset the current play target (same set of speakers)? */
function presetIsActive(p: GroupPreset): boolean {
  const ids = presetRooms(p);
  if (ids.length < 2 || activeSolo) return ids.length === 1 && activePlayerId === ids[0];
  const active = new Set(activeGroupMembers().map((r) => r.id));
  return active.size === ids.length && ids.every((id) => active.has(id));
}
/** One-tap a saved preset: form its group (of the still-present speakers) and target it. */
function applyPreset(p: GroupPreset, el: HTMLElement): void {
  const ids = presetRooms(p);
  if (ids.length === 0) return;
  const leader = ids[0]!;
  if (ids.length >= 2) {
    const affected = new Set(ids.map((id) => leaderOf(id)));
    for (const r of rooms) {
      if (ids.includes(r.id)) continue;
      if (affected.has(leaderOf(r.id))) setLeaderLocal(r.id, r.id);
    }
    ids.forEach((id) => setLeaderLocal(id, leader));
    armGroupGuard();
    void client.group({ playerIds: [leader, ...ids.filter((x) => x !== leader)] }).catch(() => {});
  }
  activePlayerId = leader;
  activeSolo = ids.length < 2;
  userPickedPlayer = true;
  followIfPlayingOpenAlbum(leader);
  renderRoomUIs();
  updatePlayButton();
}

/** Remove a room from its group (member or leader) and focus it to play on its own. */
function ungroupRoom(id: string): void {
  const members = groupMembers(leaderOf(id)).map((r) => r.id);
  if (members.length >= 2) {
    const remaining = members.filter((x) => x !== id);
    setLeaderLocal(id, id); // this room becomes solo
    remaining.forEach((m) => setLeaderLocal(m, remaining[0] ?? id)); // rest keep a leader
    armGroupGuard();
    void client.group({ playerIds: remaining }).catch(() => {});
  }
  focusRoom(id);
}

function renderCCRooms(): void {
  const wrap = document.getElementById('cc-rooms') as HTMLElement;
  wrap.innerHTML = '';
  const cells: HTMLElement[] = [];
  // Real groups (≥2 rooms sharing a leader) first, then only the SOLO speakers —
  // grouped ones live inside their group's dropdown, so they're not repeated here.
  for (const leader of [...new Set(rooms.map((r) => leaderOf(r.id)))]) {
    const members = groupMembers(leader);
    if (members.length >= 2) cells.push(groupCell(leader, members));
  }
  for (const r of rooms) if (groupMembers(leaderOf(r.id)).length < 2) cells.push(roomCell(r));

  const cols = Math.min(3, Math.max(2, Math.ceil(cells.length / 6)));
  wrap.style.columnCount = String(cols);
  for (const c of cells) wrap.appendChild(c);
  syncEqs();
}

/** A solo speaker: tap the name to control it; "Group" arms it, then a second
    room's "Group" joins them ("Cancel" while armed). */
/** Is this player actively playing something right now? */
function roomIsPlaying(id: string): boolean {
  return lastStates.some((s) => s.playerId === id && s.state === 'playing' && !!s.nowPlaying);
}

function roomCell(r: Player): HTMLElement {
  const armed = r.id === pendingGroup;
  const playing = roomIsPlaying(r.id);
  const selected = r.id === activePlayerId; // where Play will send music
  const row = document.createElement('div');
  row.className =
    'cc-room' + (selected ? ' selected' : '') + (r.id === focusedPlayerId ? ' focused' : '') + (armed ? ' pending' : '') + (playing ? ' playing' : '');
  const isAdd = !armed && pendingGroup;
  row.innerHTML =
    `<div class="cc-room-top">` +
    `<span class="cc-room-name">${playing ? TRACK_EQ + ' ' : ''}${escapeHtml(r.name)}</span>` +
    `<button class="cc-room-join${isAdd ? ' is-add' : ''}">${armed ? 'Cancel' : pendingGroup ? 'Add' : 'Group'}</button>` +
    `</div>` +
    `<input type="range" min="0" max="100" value="${roomVol(r.id)}">`;
  wireVolume(row.querySelector('input') as HTMLInputElement, r.id);
  // Tap the row → focus this room and close any expanded group's sliders.
  (row.querySelector('.cc-room-top') as HTMLElement).addEventListener('click', () => {
    if (expandedGroups.size) expandedGroups.clear();
    focusRoom(r.id);
  });
  (row.querySelector('.cc-room-join') as HTMLElement).addEventListener('click', (e) => {
    e.stopPropagation();
    groupRoom(r.id);
  });
  return row;
}

/** A real group: one combined volume (sets them all) + a dropdown of members. */
function groupCell(leader: string, members: Player[]): HTMLElement {
  const avg = Math.round(members.reduce((s, r) => s + roomVol(r.id), 0) / members.length);
  const leaderName = rooms.find((r) => r.id === leader)?.name ?? 'Group';
  const expanded = expandedGroups.has(leader);
  // A room is armed for grouping and isn't already in this group → tapping the
  // button drops it here (Add). Otherwise the button arms/cancels this whole group.
  const canAdd = pendingGroup !== null && leaderOf(pendingGroup) !== leader;
  const groupArmed = pendingGroup === leader;
  const playing = members.some((m) => roomIsPlaying(m.id)); // group plays if any member is
  const selected = members.some((m) => m.id === activePlayerId); // Play target is in this group
  const cell = document.createElement('div');
  cell.className = 'cc-room grouped cc-group' + (selected ? ' selected' : '') + (groupArmed ? ' pending' : '') + (playing ? ' playing' : '');
  cell.innerHTML =
    `<div class="cc-room-top">` +
    `<button class="cc-group-toggle" aria-label="Show rooms">${expanded ? '▴' : '▾'}</button>` +
    `<span class="cc-room-name">${playing ? TRACK_EQ + ' ' : ''}${escapeHtml(leaderName)} <span class="cc-room-tag">leader</span> +${members.length - 1}</span>` +
    `<button class="cc-room-join${canAdd ? ' is-add' : ''}">${groupArmed ? 'Cancel' : canAdd ? 'Add' : 'Group'}</button>` +
    `</div>` +
    `<input type="range" min="0" max="100" value="${avg}">` +
    `<div class="cc-group-members"${expanded ? '' : ' hidden'}></div>`;
  (cell.querySelector('.cc-room-join') as HTMLElement).addEventListener('click', (e) => {
    e.stopPropagation();
    canAdd ? addToGroup(leader) : groupRoom(leader);
  });
  // Group volume is PROPORTIONAL, like Sonos: raising the group scales each member toward
  // 100 by its remaining headroom; lowering scales each toward 0 by ratio. So members
  // converge and reach 100 together going up (and 0 together going down), preserving their
  // balance in between. We snapshot the members' levels + the group value at drag start so
  // the whole drag maps from a fixed origin (reversible, and it survives the ends cleanly).
  const gInput = cell.querySelector('input') as HTMLInputElement;
  gInput.dataset['group'] = leader; // syncCCVolumes pushes the live group average here
  let dragBase: { g: number; vols: number[] } | null = null;
  const snapshot = (): { g: number; vols: number[] } => ({ g: +gInput.value, vols: members.map((r) => roomVol(r.id)) });
  const applyGroup = (): void => {
    if (!dragBase) dragBase = snapshot();
    const gNew = +gInput.value;
    const gOld = dragBase.g;
    const memInputs = cell.querySelectorAll('.cc-group-member input') as NodeListOf<HTMLInputElement>;
    members.forEach((r, i) => {
      const base = dragBase!.vols[i] ?? volume;
      const raw =
        gNew >= gOld
          ? gOld < 100
            ? base + ((gNew - gOld) * (100 - base)) / (100 - gOld) // up: approach 100 by headroom
            : base
          : gOld > 0
            ? (base * gNew) / gOld // down: scale toward 0
            : base;
      const nv = Math.max(0, Math.min(100, Math.round(raw)));
      void client.setVolume({ playerId: r.id, level: nv }).catch(() => {});
      if (memInputs[i]) memInputs[i].value = String(nv);
    });
  };
  gInput.addEventListener('pointerdown', () => {
    bumpVolTouch();
    dragBase = snapshot();
  });
  gInput.addEventListener('input', () => {
    bumpVolTouch();
    applyGroup();
  });
  gInput.addEventListener('change', () => {
    dragBase = null; // next drag re-snapshots from the settled levels
  });
  // Expansion is exclusive — opening one group drops its volume sliders and closes
  // any other, so only one set of sliders is ever down.
  const toggleGroup = (): void => {
    const open = expandedGroups.has(leader);
    expandedGroups.clear();
    if (!open) expandedGroups.add(leader);
    renderCCRooms();
  };
  (cell.querySelector('.cc-group-toggle') as HTMLElement).addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGroup();
  });
  // Tapping the group name focuses the hero on it AND drops its volume sliders down
  // (so you can adjust quickly without hunting for the small caret).
  (cell.querySelector('.cc-room-top') as HTMLElement).addEventListener('click', () => {
    toggleGroup();
    focusRoom(leader);
  });
  const memWrap = cell.querySelector('.cc-group-members') as HTMLElement;
  for (const r of members) {
    const mPlaying = playing; // a group plays as one unit → every member shows the EQ
    const m = document.createElement('div');
    m.className = 'cc-group-member' + (mPlaying ? ' playing' : '');
    m.innerHTML =
      `<div class="cc-room-top">` +
      `<span class="cc-room-name">${mPlaying ? TRACK_EQ + ' ' : ''}${escapeHtml(r.name)}${r.id === leader ? ' <span class="cc-room-tag">leader</span>' : ''}</span>` +
      `<button class="cc-room-join">Leave</button>` +
      `</div>` +
      `<input type="range" min="0" max="100" value="${roomVol(r.id)}">`;
    // A member slider sets just that room — and nudges the GROUP slider to the members'
    // new average (so the group control always reflects the true average level).
    const mInput = m.querySelector('input') as HTMLInputElement;
    mInput.dataset['pid'] = r.id;
    mInput.addEventListener('pointerdown', bumpVolTouch);
    mInput.addEventListener('input', () => {
      bumpVolTouch();
      void client.setVolume({ playerId: r.id, level: +mInput.value }).catch(() => {});
      const memInputs = [...cell.querySelectorAll('.cc-group-member input')] as HTMLInputElement[];
      gInput.value = String(Math.round(memInputs.reduce((s, inp) => s + +inp.value, 0) / memInputs.length));
    });
    // Members are NOT individually selectable — the group is the player unit. Only
    // the volume slider and Leave act per-room.
    (m.querySelector('.cc-room-join') as HTMLElement).addEventListener('click', (e) => {
      e.stopPropagation();
      ungroupRoom(r.id);
    });
    memWrap.appendChild(m);
  }
  return cell;
}

/* ---- Sort (persisted setting; also on the shelf) ---- */
function renderCCSort(): void {
  choiceRow(
    'sort-choices',
    [
      ['artist', 'Artist', ''],
      ['title', 'Title', ''],
      ['added', 'Recently added', ''],
      ['played', 'Most played', ''],
      ['year', 'Release year', ''],
      ['color', 'Color', ''],
      ['custom', 'Custom', ''],
    ],
    (k) => settings.sortBy === k,
    (k) => {
      settings.sortBy = k as SortBy;
      closeAlbum();
      applySort();
      buildShelf();
      sizeFaces();
      applyNow();
      renderCCSort();
      void client.putSettings({ sortBy: settings.sortBy }).catch(() => {});
    },
  );
}

/** Sort `items` in place by the current setting. Deterministic; color is a hue
    ramp (rainbow shelf). Applied on load and whenever the sort changes. */
function applySort(): void {
  const by = settings.sortBy;
  items.sort((a, b) => {
    switch (by) {
      case 'custom':
        return a.order - b.order; // the manual order set in admin
      case 'title':
        return a.title.localeCompare(b.title);
      case 'year':
        return (b.year ?? 0) - (a.year ?? 0);
      case 'added':
        return b.addedAt.localeCompare(a.addedAt); // newest first
      case 'played':
        return b.playCount - a.playCount;
      case 'color':
        return hue(a.primaryColor) - hue(b.primaryColor);
      case 'artist':
      default:
        return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
    }
  });
}
/** Hue (0–360) of a #rrggbb color, for the color sort. Greys sort last. */
function hue(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 999;
  const r = parseInt(m[1]!, 16) / 255,
    g = parseInt(m[2]!, 16) / 255,
    bl = parseInt(m[3]!, 16) / 255;
  const max = Math.max(r, g, bl),
    min = Math.min(r, g, bl),
    d = max - min;
  if (d < 0.02) return 400 + max; // near-grey: cluster at the end, light→dark
  let h: number;
  if (max === r) h = ((g - bl) / d) % 6;
  else if (max === g) h = (bl - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/* =====================================================================
   Find bar (bottom-edge pull-up): live shelf search + sort + Settings launcher.
   Un-dimmed so the shelf stays visible and filters as you type.
   ===================================================================== */
const find = document.getElementById('find') as HTMLElement;
const findGrip = document.getElementById('find-grip') as HTMLElement;
const findHandle = find.querySelector('.cc-handle') as HTMLElement;
const findSearch = document.getElementById('find-search') as HTMLInputElement;

function openFind(): void {
  find.classList.add('open');
  document.body.classList.add('find-open'); // hide the control-center pull tab while the sheet is up
  renderCCSort();
  renderShelfList();
  void renderContinueStrip(); // refresh in-progress items if reopened on a spoken-word tab
  if (!filterQuery) renderRecents(); // surface recent searches straight away (no need to tap the box)
  // No auto-focus: the shelf list is the primary content; tapping the search
  // field is what pops the on-screen keyboard.
}
function closeFind(): void {
  find.classList.remove('open');
  document.body.classList.remove('find-open');
  // Clear the search box + results on close (recent searches bring a query back fast).
  // The committed shelf filter, if any, persists independently until you clear its chip.
  findSearch.value = '';
  filterQuery = '';
  findClear.hidden = true;
  clearFindResults();
}

/** Commit the current search text as a filter on the shelf spines, then close the bar. */
function applyShelfFilter(q: string): void {
  shelfFilter = q.trim();
  reflectShelfFilter();
  closeFind();
}
/** Clearing the filter drops you back on the All shelf (unfiltered). */
function clearShelfFilter(): void {
  shelfFilter = '';
  void switchShelf('all'); // rebuilds unfiltered + closes the find bar
}
function reflectShelfFilter(): void {
  items.forEach((a, i) => {
    (shelf.children[i] as HTMLElement | undefined)?.classList.toggle('sliver', !matchesFilter(a));
  });
  sizeFaces();
}
/** Open the search bar pre-filled with a query (e.g. tapping an album's artist) and run it. */
function openFindWithQuery(q: string): void {
  openFind();
  findSearch.value = q;
  findSearch.dispatchEvent(new Event('input', { bubbles: true })); // sets filterQuery + runs search
  findSearch.focus();
}
// Tap the exposed shelf area (outside the bar) to dismiss.
find.addEventListener('click', (e) => {
  if (e.target === find) closeFind();
});
// Swipe the bar back down (opposite of the opening swipe) to close.
swipeToClose(document.getElementById('find-bar') as HTMLElement, 'down', closeFind);

// Open: press the bottom-edge grip and drag up. Close: tap/swipe the handle.
let fGripDown = false,
  fGripY = 0,
  fGripOpened = false;
findGrip.addEventListener('pointerdown', (e) => {
  fGripDown = true;
  fGripY = e.clientY;
  fGripOpened = false;
});
let fHandleDown = false,
  fHandleY = 0;
findHandle.addEventListener('pointerdown', (e) => {
  fHandleDown = true;
  fHandleY = e.clientY;
  e.stopPropagation();
});
window.addEventListener('pointermove', (e) => {
  if (fGripDown && !fGripOpened && fGripY - e.clientY > 30) {
    openFind();
    fGripOpened = true;
  }
});
window.addEventListener('pointerup', (e) => {
  if (fGripDown) {
    // A tap on the bottom edge (grip shown or not) opens the find bar.
    if (!fGripOpened && Math.abs(e.clientY - fGripY) < 8) openFind();
    fGripDown = false;
  }
  if (fHandleDown) {
    fHandleDown = false;
    if (e.clientY - fHandleY > 40 || Math.abs(e.clientY - fHandleY) < 8) closeFind();
  }
});

(document.getElementById('find-settings') as HTMLElement).addEventListener('click', () => {
  openSettings();
  closeFind();
});

/* Search-to-pick: typing filters the shelf spines (non-matches hidden) AND builds
   a pick-list in the bar — your shelf matches first (tap to open), then Apple Music
   matches (tap to Add), debounced so you never need Enter. Provider results are
   sequence-guarded so a slow earlier response can't overwrite a newer one. */
const findResults = document.getElementById('find-results') as HTMLElement;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;
let searchSource = 'all'; // client-side source filter: a source name, or 'all'
let searchSourceUserSet = false; // did the user pick a source this session? (don't clobber with the default)
let searchMultiSource = false; // do the current results span >1 source? (drives badges + filter)
const searchSourceIcon = new Map<string, string | null>(); // source name → inline SVG icon (per result set)
// Persistent source-name → icon map (fetched once from /api/sources) so every card — including
// playlist results, whose search response carries no source list — can show its source badge.
const sourceIconByName = new Map<string, string | null>();
void client
  .getSources()
  .then((srcs) => srcs.forEach((s) => sourceIconByName.set(s.name, s.iconSvg ?? null)))
  .catch(() => {});
let globalResults: GlobalSearchResponse | null = null;
let playlistResults: LibraryPlaylist[] | null = null; // Playlists-tab search
let mediaResults: MediaSearchResponse | null = null; // Radio/Podcast/Audiobook-tab search
// The active kind's shelf items, for the "On your shelf" search column — fetched once per kind
// and reused, so the column reflects your whole shelf (not just what the catalog search returned).
const shelfItemsCache = new Map<ShelfKind, ShelfItem[]>();
function canonicalShelfId(kind: ShelfKind): string | undefined {
  if (kind === 'album') return undefined; // "all"
  if (kind === 'playlist') return 'playlists';
  return EXTRA_MEDIA.find((m) => m.kind === kind)?.shelfId;
}
async function ensureShelfItems(kind: ShelfKind): Promise<void> {
  if (shelfItemsCache.has(kind)) return;
  const res = await client.getShelf(canonicalShelfId(kind)).catch(() => ({ items: [] as ShelfItem[] }));
  shelfItemsCache.set(kind, res.items);
  if (shelfTab === kind && filterQuery) renderSearch(false); // fill the On-your-shelf column once loaded
}
/** Re-fetch a kind's shelf items and re-render the search view so the On-your-shelf column
    reflects an add/remove immediately (no need to redo the search). */
async function refreshShelfItems(kind: ShelfKind): Promise<void> {
  const res = await client.getShelf(canonicalShelfId(kind)).catch(() => null);
  if (!res) return;
  shelfItemsCache.set(kind, res.items);
  if (shelfTab === kind && filterQuery) renderSearch(false);
}
let artistView: SearchArtist | null = null; // non-null = the artist detail is showing
let artistSeq = 0; // cancels stale artist-detail fetches
// Warm the top artists' (slow) song lists in the background as soon as they appear in
// results, so tapping in usually finds them ready. Deduped per session.
const prefetchedArtists = new Set<string>();
function prefetchArtistSongs(artists: SearchArtist[]): void {
  for (const a of artists.slice(0, 2)) {
    if (prefetchedArtists.has(a.providerUri)) continue;
    prefetchedArtists.add(a.providerUri);
    void client.getArtistTopSongs(a.providerUri, a.name).catch(() => prefetchedArtists.delete(a.providerUri));
  }
}

/* Recent searches: the last handful of queries, shown as tappable chips when the
   search box is focused and empty so you can re-run one without retyping. */
const RECENTS_KEY = 'crate.recentSearches';
const RECENTS_MAX = 8;
function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function addRecent(q: string): void {
  const t = q.trim();
  if (t.length < 2) return;
  const next = [t, ...loadRecents().filter((r) => r.toLowerCase() !== t.toLowerCase())].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled — recents are best-effort */
  }
}
/** Show recent-search chips in the results area (when focused + empty). */
function renderRecents(): void {
  const recents = loadRecents();
  if (!recents.length || filterQuery) {
    if (!filterQuery) clearFindResults();
    return;
  }
  artistView = null;
  findResults.hidden = false;
  findResults.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'find-recents';
  const h = document.createElement('div');
  h.className = 'find-cat-h find-recents-head';
  h.innerHTML = '<span>Recent searches</span>';
  const clear = document.createElement('button');
  clear.className = 'find-recents-clear';
  clear.setAttribute('aria-label', 'Clear search history');
  clear.textContent = '✕';
  clear.onclick = () => {
    try {
      localStorage.removeItem(RECENTS_KEY);
    } catch {
      /* ignore */
    }
    clearFindResults();
  };
  h.appendChild(clear);
  wrap.appendChild(h);
  const strip = document.createElement('div');
  strip.className = 'find-recent-chips';
  for (const q of recents) {
    const chip = document.createElement('button');
    chip.className = 'find-recent-chip';
    chip.textContent = q;
    chip.onclick = () => {
      findSearch.value = q;
      findSearch.dispatchEvent(new Event('input', { bubbles: true }));
    };
    strip.appendChild(chip);
  }
  wrap.appendChild(strip);
  findResults.appendChild(wrap);
}

/* Search paging: show 20 per section, "Load more" raises the fetch limit + reveals
   the next 20. MA search has no offset, so we re-fetch with a larger per-section cap. */
const SEARCH_PAGE = 20;
let searchLimit = SEARCH_PAGE;
const searchShown = { albums: SEARCH_PAGE, playlists: SEARCH_PAGE, songs: SEARCH_PAGE };
// Growth-based "is there more?" tracking, independent of the server's hasMore hint: a bigger
// fetch that returns MORE than the previous one means the source still has more to give. Once a
// bigger limit stops growing the count, we've hit the source's ceiling and hide "Load more".
const lastFetchCount = { albums: -1, playlists: -1, songs: -1 };
const searchGrew = { albums: true, playlists: true, songs: true };
let albumAutoFills = 0; // bounded auto "Load more" when the catalog column is thin after on-shelf dedup
function resetSearchPaging(): void {
  searchLimit = SEARCH_PAGE;
  searchShown.albums = searchShown.playlists = searchShown.songs = SEARCH_PAGE;
  lastFetchCount.albums = lastFetchCount.playlists = lastFetchCount.songs = -1;
  searchGrew.albums = searchGrew.playlists = searchGrew.songs = true;
  albumAutoFills = 0;
}
function loadMoreSection(key: 'albums' | 'playlists' | 'songs'): void {
  searchShown[key] += SEARCH_PAGE;
  const need = Math.max(searchShown.albums, searchShown.playlists, searchShown.songs);
  if (need > searchLimit) {
    searchLimit = need;
    void runSearch(); // fetch the bigger page, then re-render
  } else {
    renderSearch(false); // already fetched — just reveal more
  }
}

const findClear = document.getElementById('find-clear') as HTMLButtonElement;
findSearch.addEventListener('input', () => {
  filterQuery = findSearch.value.trim();
  findClear.hidden = !findSearch.value;
  artistView = null; // typing leaves any open artist detail
  // Typing no longer filters the shelf (the overlay covers it) — searching is for
  // playing; the shelf is only filtered when you explicitly hit "Filter shelf".
  if (searchTimer) clearTimeout(searchTimer);
  if (filterQuery.length >= 2) {
    resetSearchPaging(); // a new query starts back at the first page
    renderSearch(true); // show the loading scaffold immediately
    searchTimer = setTimeout(() => void runSearch(), 400);
  } else if (!filterQuery) {
    renderRecents(); // empty box → offer the last few searches
  } else {
    clearFindResults();
  }
});
// Focusing the (empty) box surfaces recent searches.
findSearch.addEventListener('focus', () => {
  if (!filterQuery) renderRecents();
});
findClear.addEventListener('click', () => {
  findSearch.value = '';
  findClear.hidden = true;
  findSearch.dispatchEvent(new Event('input', { bubbles: true }));
  findSearch.focus();
});
// Enter (hardware keyboards / the on-screen "Go" key) searches immediately.
findSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && filterQuery) {
    if (searchTimer) clearTimeout(searchTimer);
    void runSearch();
  }
});

function clearFindResults(): void {
  searchSeq++; // cancel any in-flight render
  artistSeq++; // and any in-flight artist detail
  artistView = null;
  globalResults = null;
  findResults.hidden = true;
  find.classList.remove('searching'); // back to the short browse-mode sheet
  findResults.innerHTML = '';
}

/** Run the search scoped to the ACTIVE tab: Albums → artists/albums/songs, Playlists → playlists,
    Radio/Podcasts/Audiobooks → that kind. Each renders its own "On your shelf" column. */
async function runSearch(): Promise<void> {
  const q = findSearch.value.trim();
  if (!q) return;
  const tab = shelfTab;
  if (!searchSourceUserSet) searchSource = defaultSourceFor(tab); // apply the tab's default source up front
  const seq = ++searchSeq;
  addRecent(q); // remember it for the recent-searches list
  void ensureShelfItems(tab); // warm the On-your-shelf column (cached; re-renders when it lands)
  try {
    if (tab === 'album') {
      const res = await client.globalSearch(q, undefined, searchLimit);
      if (seq !== searchSeq) return;
      globalResults = res;
      // Did this (larger) fetch return more than the previous one? If so, keep offering more.
      const counts = { albums: res.albums.length, playlists: res.playlists.length, songs: res.songs.length };
      (['albums', 'playlists', 'songs'] as const).forEach((k) => {
        searchGrew[k] = counts[k] > lastFetchCount[k];
        lastFetchCount[k] = counts[k];
      });
    } else if (tab === 'playlist') {
      const res = await client.searchPlaylists(q);
      if (seq !== searchSeq) return;
      playlistResults = res;
    } else {
      const res = await client.searchMedia(tab, q);
      if (seq !== searchSeq) return;
      mediaResults = res;
    }
  } catch {
    if (seq !== searchSeq) return;
    if (tab === 'album') globalResults = null;
    else if (tab === 'playlist') playlistResults = null;
    else mediaResults = null;
  }
  renderSearch(false);
}

/** Render the results for the ACTIVE tab. Every tab leads with an "On your shelf" column
    (your matching curated items + the Filter-shelf button); the rest is that kind's catalog. */
function renderSearch(loading: boolean): void {
  if (artistView) return; // artist detail is showing — don't clobber it
  if (!filterQuery) {
    clearFindResults();
    return;
  }
  findResults.hidden = false;
  find.classList.add('searching'); // grow the sheet to full height for the results
  findResults.innerHTML = '';
  if (shelfTab === 'album') renderAlbumResults(loading);
  else if (shelfTab === 'playlist') renderPlaylistResults(loading);
  else renderMediaResults(shelfTab, loading);
}

/** Sources the user hasn't hidden for the active tab (admin › Audio Sources). */
function shownSources(sources: MusicSourceInfo[]): MusicSourceInfo[] {
  const hidden = new Set(settings.hiddenSources?.[shelfTab] ?? []);
  return sources.filter((s) => !hidden.has(s.name));
}
/** Source dropdown (client-side filter) atop the results — only when >1 shown source is present. */
function renderSourceBar(sources: MusicSourceInfo[], loading: boolean): void {
  const shown = shownSources(sources);
  searchSourceIcon.clear();
  for (const s of shown) {
    searchSourceIcon.set(s.name, s.iconSvg ?? null);
    if (s.iconSvg) sourceIconByName.set(s.name, s.iconSvg); // keep the persistent map fresh
  }
  searchMultiSource = shown.length > 1;
  // Drop an active source filter only against LOADED results that lack it — never the empty loading
  // scaffold (which has no sources yet), or the configured default would be wiped before it applies.
  if (!loading && searchSource !== 'all' && !searchSourceIcon.has(searchSource)) searchSource = 'all';
  if (searchMultiSource) {
    const bar = document.createElement('div');
    bar.className = 'find-srcbar';
    bar.appendChild(sourceDropdown(shown));
    findResults.appendChild(bar);
  }
}
const srcOk = (s?: string): boolean => {
  if (s && (settings.hiddenSources?.[shelfTab] ?? []).includes(s)) return false; // hidden for this tab
  return searchSource === 'all' || s === searchSource;
};
/** Distinct sources (by display name) present in a result list, as minimal source infos. */
function uniqueSources(names: (string | undefined)[]): MusicSourceInfo[] {
  const seen = new Set<string>();
  const out: MusicSourceInfo[] = [];
  for (const n of names) if (n && !seen.has(n)) (seen.add(n), out.push({ instanceId: n, name: n }));
  return out;
}
/** The pre-selected search source for a tab: its per-kind default, then (albums only) the global
    default, else All. */
function defaultSourceFor(kind: ShelfKind): string {
  return settings.defaultSourceByKind?.[kind] ?? (kind === 'album' ? settings.defaultSource : undefined) ?? 'all';
}

function renderAlbumResults(loading: boolean): void {
  const g = globalResults;
  renderSourceBar(g?.sources ?? [], loading);
  if (!loading) prefetchArtistSongs(g?.artists ?? []); // warm the slow song lists in the background
  // Albums already on a shelf move to the dedicated On-your-shelf column; the Albums column shows
  // only NEW results (library favorites, then catalog), source-filtered.
  const shelved = new Set((shelfItemsCache.get('album') ?? []).map((it) => it.albumId));
  const remoteNew = (g?.albums ?? []).filter((a) => !a.onShelf && !shelved.has(albumIdFromUri(a.providerUri)));
  const libAlbums = remoteNew.filter((a) => a.inLibrary && srcOk(a.source));
  const catalogAlbums = remoteNew.filter((a) => !a.inLibrary && srcOk(a.source));
  const songs = (g?.songs ?? []).filter((s) => srcOk(s.source));
  const more = g?.hasMore ?? searchGrew;
  // If the on-shelf dedup (and any source filter) left the Albums column thin but a deeper fetch
  // would yield more, pull the next page automatically — otherwise a shelf that covers the first
  // page of results shows an empty Albums column until you tap "Load more" by hand.
  if (!loading && g && libAlbums.length + catalogAlbums.length < SEARCH_PAGE / 2 && more.albums && albumAutoFills < 3) {
    albumAutoFills++;
    loadMoreSection('albums');
  }
  const cats = document.createElement('div');
  cats.className = 'find-cats';
  cats.appendChild(artistsColumn((g?.artists ?? []).filter((a) => srcOk(a.source)), loading)); // narrow leading column
  cats.appendChild(shelfColumn('album'));
  cats.appendChild(albumsColumn(libAlbums, catalogAlbums, loading, more.albums));
  cats.appendChild(catColumn('Songs', songs.map(songResultCard), loading, 'songs', more.songs));
  findResults.appendChild(cats);
}

function renderPlaylistResults(loading: boolean): void {
  const pls = playlistResults ?? [];
  renderSourceBar(uniqueSources(pls.map((p) => p.source)), loading);
  const shelved = new Set((shelfItemsCache.get('playlist') ?? []).map((it) => it.albumId));
  const remoteNew = pls.filter((p) => !p.onShelf && !shelved.has(albumIdFromUri(p.providerUri)) && srcOk(p.source));
  const cats = document.createElement('div');
  cats.className = 'find-cats cats-two';
  cats.appendChild(shelfColumn('playlist'));
  cats.appendChild(simpleColumn('Playlists', remoteNew.map(playlistCard), loading, true));
  findResults.appendChild(cats);
}

function renderMediaResults(kind: ExtraMediaKind, loading: boolean): void {
  const res = mediaResults;
  renderSourceBar(res?.sources ?? [], loading);
  const shelved = new Set((shelfItemsCache.get(kind) ?? []).map((it) => it.albumId));
  const remoteNew = (res?.items ?? []).filter((it) => !it.onShelf && !shelved.has(albumIdFromUri(it.providerUri)) && srcOk(it.source));
  const label = EXTRA_MEDIA.find((m) => m.kind === kind)?.name ?? 'Results';
  const cats = document.createElement('div');
  cats.className = 'find-cats cats-two';
  cats.appendChild(shelfColumn(kind));
  cats.appendChild(simpleColumn(label, remoteNew.map((it) => mediaResultCard(it, kind)), loading, true));
  findResults.appendChild(cats);
}

/** The "On your shelf" column for a tab — matching shelved items of that kind, with the
    Filter-shelf action pinned to the header. Tapping a card opens it on the wall. */
function shelfColumn(kind: ShelfKind): HTMLElement {
  const its = (shelfItemsCache.get(kind) ?? []).filter((it) => matchesQuery(it, filterQuery));
  const col = document.createElement('div');
  col.className = 'find-cat';
  const h = document.createElement('div');
  h.className = 'find-cat-h find-subhead-row';
  h.innerHTML = '<span>On your shelf</span>';
  const filterBtn = document.createElement('button');
  filterBtn.className = 'find-filter-shelf';
  filterBtn.textContent = 'Filter shelf';
  filterBtn.onclick = () => void filterShelfForTab(filterQuery, kind);
  h.appendChild(filterBtn);
  col.appendChild(h);
  const list = document.createElement('div');
  list.className = 'find-cat-list';
  if (its.length) its.forEach((it) => list.appendChild(kind === 'album' ? shelfCard(it) : shelfOpenCard(it)));
  else {
    const e = document.createElement('div');
    e.className = 'find-empty';
    e.textContent = shelfItemsCache.has(kind) ? 'Nothing here' : 'Loading…';
    list.appendChild(e);
  }
  col.appendChild(list);
  return col;
}

/** A plain results column (no paging) — used for the playlist/podcast/audiobook/radio catalog.
    `grid` lays the cards out two-up (the catalog gets a double-wide column) so they stay a sensible
    reading width on an ultrawide wall instead of stretching. */
function simpleColumn(title: string, cards: HTMLElement[], loading: boolean, grid = false): HTMLElement {
  const col = document.createElement('div');
  col.className = 'find-cat' + (grid ? ' find-cat-wide' : '');
  const h = document.createElement('div');
  h.className = 'find-cat-h';
  h.textContent = title;
  col.appendChild(h);
  const list = document.createElement('div');
  list.className = 'find-cat-list' + (grid ? ' find-cat-grid' : '');
  if (cards.length) cards.forEach((c) => list.appendChild(c));
  else {
    const e = document.createElement('div');
    e.className = 'find-empty';
    e.textContent = loading ? 'Searching…' : 'None';
    list.appendChild(e);
  }
  col.appendChild(list);
  return col;
}

/** An on-shelf card for a non-album kind (playlist/podcast/audiobook/radio): tap or "Open"
    switches the wall to that kind's shelf and opens the item. */
function shelfOpenCard(it: ShelfItem): HTMLElement {
  const card = cardShell(it.title, it.artist, it.artworkUrl, '');
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap');
  const open = (): void => void openShelvedItem(it);
  card.addEventListener('click', open);
  // Standalone "Open" button appended directly (no .find-add-ctrl wrapper — it strips the right
  // border/corners for a ▾ caret this card doesn't have, which read as a cut-off button).
  const btn = document.createElement('button');
  btn.className = 'find-card-add';
  btn.textContent = 'Open';
  btn.onclick = (e) => {
    e.stopPropagation();
    open();
  };
  card.appendChild(btn);
  return card;
}

/** Switch the wall to a shelved item's shelf and open it. */
async function openShelvedItem(it: ShelfItem): Promise<void> {
  clearSearch();
  await switchShelf(canonicalShelfId(it.kind) ?? 'all', true);
  const idx = items.findIndex((x) => x.albumId === it.albumId);
  if (idx >= 0) openAlbum(idx);
}

/** A catalog result card for podcast/audiobook/radio search. Add it to its kind's shelf; once added
    the button reads "Added" and, on hover, "Remove" — clicking it takes it back off the shelf. */
function mediaResultCard(item: MediaBrowseItem, kind: ExtraMediaKind): HTMLElement {
  const card = cardShell(item.name, item.description ?? '', item.artworkUrl, '', item.source);
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap');
  const albumId = albumIdFromUri(item.providerUri);
  // A standalone button — appended directly (NOT wrapped in .find-add-ctrl, whose CSS strips the
  // button's right border/corners to butt against a ▾ caret these cards don't have).
  const btn = document.createElement('button');
  btn.className = 'find-card-add';
  const setState = (added: boolean): void => {
    item.onShelf = added;
    btn.disabled = false;
    btn.classList.toggle('find-card-added', added);
    btn.innerHTML = added ? '<span class="lbl-on">Added</span><span class="lbl-off">Remove</span>' : 'Add';
  };
  const add = async (): Promise<void> => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      await client.addMedia(kind, item.providerUri);
      setState(true);
      showToast(`Added ${item.name}`);
      void refreshShelfItems(kind); // show it in the On-your-shelf column right away
    } catch {
      setState(false);
      showToast('Could not add');
    }
  };
  const remove = async (): Promise<void> => {
    btn.disabled = true;
    btn.textContent = 'Removing…';
    try {
      await client.removeFromShelf(albumId);
      setState(false);
      showToast(`Removed ${item.name}`);
      void refreshShelfItems(kind); // drop it from the On-your-shelf column right away
    } catch {
      setState(true);
      showToast('Could not remove');
    }
  };
  const toggle = (): void => void (item.onShelf ? remove() : add());
  btn.onclick = (e) => {
    e.stopPropagation();
    toggle();
  };
  card.addEventListener('click', toggle);
  setState(!!item.onShelf);
  card.appendChild(btn);
  return card;
}

/** "Filter shelf" from any tab: show that kind's shelf on the wall, filtered to the query. */
async function filterShelfForTab(q: string, kind: ShelfKind): Promise<void> {
  const shelfId = canonicalShelfId(kind) ?? 'all';
  if (activeShelf !== shelfId) await switchShelf(shelfId, false);
  applyShelfFilter(q); // sets the filter, reflects it on the wall, closes Find
}

/** The Albums results column (catalog only — on-shelf albums live in their own column now):
    library favorites first, then everything else from your sources, sharing the "Load more" cap. */
function albumsColumn(lib: SearchAlbum[], catalog: SearchAlbum[], loading: boolean, more: boolean): HTMLElement {
  const col = document.createElement('div');
  col.className = 'find-cat';
  const h = document.createElement('div');
  h.className = 'find-cat-h';
  h.textContent = 'Albums';
  col.appendChild(h);
  const list = document.createElement('div');
  list.className = 'find-cat-list';
  // Library-owned first, then catalog — as one flat list. (The old "In your library" / "From your
  // sources" tier labels are dropped now that on-shelf items have their own column.)
  const remote = [...lib, ...catalog];
  remote.slice(0, searchShown.albums).forEach((a) => list.appendChild(albumResultCard(a)));
  if (!remote.length) {
    const e = document.createElement('div');
    e.className = 'find-empty';
    e.textContent = loading ? 'Searching…' : 'None';
    list.appendChild(e);
  }
  // Offer more when there are fetched-but-hidden cards to reveal, or a bigger fetch would return
  // more (server hasMore). Don't gate on remote.length vs the page size — on-shelf dedup shrinks
  // remote below the page, which would wrongly hide the button when there's plenty more.
  if (!loading && (remote.length > searchShown.albums || more)) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'find-more';
    moreBtn.textContent = 'Load more';
    moreBtn.onclick = () => loadMoreSection('albums');
    list.appendChild(moreBtn);
  }
  col.appendChild(list);
  return col;
}

/** The leading "Artists" column in search results — a narrow vertical list of avatar chips that
    scrolls like the Albums/Playlists/Songs columns beside it (tap → their albums + top songs). */
function artistsColumn(artists: SearchArtist[], loading: boolean): HTMLElement {
  const col = document.createElement('div');
  col.className = 'find-cat find-cat-artists';
  const h = document.createElement('div');
  h.className = 'find-cat-h';
  h.textContent = 'Artists';
  col.appendChild(h);
  const list = document.createElement('div');
  list.className = 'find-cat-list';
  if (artists.length) artists.forEach((a) => list.appendChild(artistChip(a)));
  else {
    const e = document.createElement('div');
    e.className = 'find-empty';
    e.textContent = loading ? 'Searching…' : 'None';
    list.appendChild(e);
  }
  col.appendChild(list);
  return col;
}
function artistChip(a: SearchArtist): HTMLElement {
  const b = document.createElement('button');
  b.className = 'find-artist';
  const art = a.artworkUrl ? ` style="background-image:url('${a.artworkUrl}')"` : '';
  b.innerHTML = `<span class="find-artist-av${a.artworkUrl ? '' : ' none'}"${art}></span><span class="find-artist-name">${escapeHtml(a.name)}</span>`;
  b.onclick = () => void openArtist(a);
  return b;
}

/** Artist detail: replace the results with the artist's albums (fast) + top songs
    (loaded lazily — the first fetch per artist is slow, so it spins meanwhile). */
async function openArtist(a: SearchArtist): Promise<void> {
  artistView = a;
  const seq = ++artistSeq;
  findResults.hidden = false;
  find.classList.add('searching'); // artist detail also fills the sheet
  findResults.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'artist-head';
  head.innerHTML = `<button class="artist-back">‹ Results</button><h2 class="artist-title">${escapeHtml(a.name)}</h2>`;
  (head.querySelector('.artist-back') as HTMLElement).onclick = () => {
    artistView = null;
    renderSearch(false);
  };
  findResults.appendChild(head);

  const body = document.createElement('div');
  body.className = 'artist-detail';
  body.innerHTML =
    `<div class="find-cat artist-albums"><div class="find-cat-h">Albums</div><div class="find-cat-list"><div class="find-empty">Loading…</div></div></div>` +
    `<div class="find-cat artist-songs"><div class="find-cat-h">Top songs</div><div class="find-cat-list"><div class="find-empty"><span class="np-spin"></span> Finding top songs…</div></div></div>`;
  findResults.appendChild(body);
  const albumsList = body.querySelector('.artist-albums .find-cat-list') as HTMLElement;
  const songsList = body.querySelector('.artist-songs .find-cat-list') as HTMLElement;

  // Albums — fast.
  client
    .getArtistAlbums(a.providerUri)
    .then((albums) => {
      if (seq !== artistSeq) return;
      albumsList.innerHTML = '';
      if (albums.length) albums.forEach((al) => albumsList.appendChild(albumResultCard(al)));
      else albumsList.innerHTML = '<div class="find-empty">No albums.</div>';
    })
    .catch(() => {
      if (seq !== artistSeq) return;
      albumsList.innerHTML = '<div class="find-empty">Couldn’t load albums.</div>';
    });

  // Top songs — popularity-ranked via the provider's search (fast).
  client
    .getArtistTopSongs(a.providerUri, a.name)
    .then((songs) => {
      if (seq !== artistSeq) return;
      songsList.innerHTML = '';
      if (songs.length) songs.forEach((s) => songsList.appendChild(songResultCard(s)));
      else songsList.innerHTML = '<div class="find-empty">No songs.</div>';
    })
    .catch(() => {
      if (seq !== artistSeq) return;
      songsList.innerHTML = '<div class="find-empty">Couldn’t load top songs.</div>';
    });
}

function catColumn(
  title: string,
  cards: HTMLElement[],
  loading: boolean,
  key: 'albums' | 'playlists' | 'songs',
  more: boolean,
): HTMLElement {
  const col = document.createElement('div');
  col.className = 'find-cat';
  const h = document.createElement('div');
  h.className = 'find-cat-h';
  h.textContent = title;
  col.appendChild(h);
  const list = document.createElement('div');
  list.className = 'find-cat-list';
  if (cards.length) {
    const shown = searchShown[key];
    cards.slice(0, shown).forEach((c) => list.appendChild(c));
    // Extra hidden cards to reveal, or a bigger fetch would return more (server hasMore).
    if (!loading && (cards.length > shown || more)) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'find-more';
      moreBtn.textContent = 'Load more';
      moreBtn.onclick = () => loadMoreSection(key);
      list.appendChild(moreBtn);
    }
  } else {
    const e = document.createElement('div');
    e.className = 'find-empty';
    e.textContent = loading ? 'Searching…' : 'None';
    list.appendChild(e);
  }
  col.appendChild(list);
  return col;
}

/** Source dropdown atop the results — filters the already-fetched hits by source (All + each
    source present). Only shown when a search spans >1 source. */
function sourceDropdown(sources: GlobalSearchResponse['sources']): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'find-src-btn';
  btn.textContent = `Source: ${searchSource === 'all' ? 'All' : searchSource} ▾`;
  btn.onclick = (e) => {
    e.stopPropagation();
    if (activeAddMenu) {
      closeAddMenu();
      return;
    }
    openAddMenu(btn, [
      { label: 'All sources', on: searchSource === 'all', fn: () => pickSource('all') },
      ...sources.map((s) => ({ label: s.name, on: s.name === searchSource, fn: () => pickSource(s.name) })),
    ]);
  };
  return btn;
}
function pickSource(name: string): void {
  searchSource = name;
  searchSourceUserSet = true; // an explicit pick — settings changes won't override it
  renderSearch(false); // client-side filter — the results are already fetched, no re-query
}

/** A song result — tap the card to open its album with the track cued; the ▶ button
    plays the song straight away (search song cards are the one place a tap-to-play
    lives; inside album/playlist track lists, tapping only selects — see the top Play). */
function songResultCard(s: SearchSong): HTMLElement {
  const card = cardShell(s.title, s.artist + (s.album ? ` · ${s.album}` : ''), s.artworkUrl, '', s.source);
  if (s.explicit) card.querySelector('.find-card-meta .t')?.insertAdjacentHTML('beforeend', ' <span class="ex-badge" title="Explicit">E</span>');
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap');
  card.addEventListener('click', () => void openProviderAlbum(s.trackUri));
  const playBtn = document.createElement('button');
  playBtn.className = 'find-card-play';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.innerHTML = ICON_PLAY;
  playBtn.onclick = (e) => {
    e.stopPropagation(); // don't also open the album
    void playSong(s.trackUri);
  };
  card.appendChild(playBtn);
  return card;
}

/** Play one podcast episode by its uri on the current play target (MA auto-resumes). Sets an
    optimistic now-state so the row highlights immediately, and reports a real failure honestly. */
async function playEpisode(i: number, ep: PodcastEpisode): Promise<void> {
  const item = items[i]!;
  songCue.delete(item.albumId); // committing the selection to playback — clear it (mirrors play())
  // Optimistic now-state (mirrors the playlist-song path) so the episode highlights + the
  // nowbar reflects it before the WS poll lands.
  playPendingIdx = i;
  playPendingUntil = performance.now() + 8000;
  if (activePlayerId) focusedPlayerId = activePlayerId;
  userPaused = false;
  pauseGuardUntil = 0;
  resumeGuardUntil = performance.now() + 8000;
  selfPlayUntil = performance.now() + 8000;
  now = {
    playerId: activePlayerId,
    albumId: item.albumId,
    trackIndex: 0,
    trackUri: ep.trackUri,
    elapsed: ep.resumeMs != null ? ep.resumeMs / 1000 : 0,
    duration: ep.durationSec ?? 0,
    state: 'playing',
    mediaKind: 'podcast',
    at: performance.now(),
  };
  applyNow();
  if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
  playPendingUri = ep.trackUri;
  try {
    await client.play({ albumId: item.albumId, trackUris: [ep.trackUri], ...(activePlayerId ? { playerId: activePlayerId } : {}) });
    showToast(`Playing ${ep.title}`);
  } catch (e) {
    console.error('episode play failed', e);
    showPlayError(e);
  }
}

/** The card Play button on a podcast plays an EPISODE, not the container (a podcast container
    isn't directly playable → play_media rejects it). Prefer the in-progress episode, else the
    first unfinished one, else the newest. */
async function playPodcastPreferred(i: number): Promise<void> {
  const item = items[i]!;
  let eps = podcastEpisodeCache.get(item.albumId);
  if (!eps?.length && item.providerUri) {
    eps = (await client.podcastEpisodes(item.providerUri).catch(() => ({ episodes: [] as PodcastEpisode[] }))).episodes;
  }
  const cued = songCue.get(item.albumId);
  const pick =
    (cued != null ? eps?.[cued] : undefined) ?? // a tapped/selected episode wins
    eps?.find((e) => e.resumeMs && !e.fullyPlayed) ??
    eps?.find((e) => !e.fullyPlayed) ??
    eps?.[0];
  if (!pick) {
    showToast('No episodes to play');
    return;
  }
  await playEpisode(i, pick);
}

/** Dispatch the card's Play/cover-play: a podcast plays its selected/preferred episode, an
    audiobook plays from a selected chapter (else resumes from the saved spot), and everything
    else (albums, playlists, radio) plays through the normal album path. Track ROWS are what
    need a double-tap to play — the Play button always plays the current selection on one tap. */
function playCard(i: number): Promise<void> {
  const it = items[i];
  if (it?.kind === 'podcast') return playPodcastPreferred(i);
  if (it?.kind === 'audiobook') {
    const cued = songCue.get(it.albumId);
    const ch = cued != null ? audiobookChaptersCache.get(it.albumId)?.[cued] : undefined;
    if (ch) return playAudiobook(i, Math.floor(ch.startSec)); // play the selected chapter
  }
  return play(i);
}

/** Play the open audiobook. No position → MA resumes from the saved spot; position 1 → start over;
    a chapter offset → jump there (the server seeks after playback starts). */
async function playAudiobook(i: number, position?: number): Promise<void> {
  const item = items[i]!;
  songCue.delete(item.albumId); // committing the selection to playback — clear it (mirrors play())
  try {
    await client.play({ albumId: item.albumId, ...(activePlayerId ? { playerId: activePlayerId } : {}), ...(position !== undefined ? { position } : {}) });
    showToast(position === undefined ? 'Resuming…' : position <= 1 ? 'Starting over…' : 'Jumping to chapter…');
  } catch (e) {
    console.error('audiobook play failed', e);
    showPlayError(e);
  }
}

async function playSong(trackUri: string): Promise<void> {
  if (activePlayerId && activeSolo) await ungroupActiveSoloIfNeeded();
  try {
    const d = await client.getProviderAlbum(trackUri); // track uri → album + cueIndex
    await client.play({
      albumId: d.providerUri,
      providerUri: d.providerUri,
      ...(activePlayerId ? { playerId: activePlayerId } : {}),
      ...(d.cueIndex > 0 ? { trackIndex: d.cueIndex } : {}),
    });
    showToast(`Sent to ${roomName(activePlayerId)}…`);
  } catch (e) {
    showPlayError(e);
  }
}

/* =====================================================================
   Standalone album card — an off-shelf album (from a global-search album or a
   tapped song). Fetches the album by provider uri (a track uri resolves to its
   album + cue index), shows its tracks, and lets you play (from the cued track),
   pick a room, or add it to a shelf. Reused, doesn't need a shelf spine.
   ===================================================================== */
const albumModal = document.getElementById('album-modal') as HTMLElement;
let modalUri: string | null = null; // the uri we asked to open (album or track)
let modalAlbumUri: string | null = null; // resolved real album uri to play
let modalCue = -1;
let modalIsPlaylist = false; // the overlay is showing a playlist (plays the playlist uri)

(albumModal.querySelector('.am-backdrop') as HTMLElement).addEventListener('click', closeAlbumModal);
(albumModal.querySelector('.am-play') as HTMLElement).addEventListener('click', () => void onModalPlay());
(albumModal.querySelector('.am-prev') as HTMLElement).addEventListener('click', () => {
  if (now.playerId) void client.transport({ playerId: now.playerId, cmd: 'previous' }).catch(() => {});
});
(albumModal.querySelector('.am-next') as HTMLElement).addEventListener('click', () => {
  if (now.playerId) void client.transport({ playerId: now.playerId, cmd: 'next' }).catch(() => {});
});
// Shuffle + after-album (repeat) — the SAME shared controls as the card, so they stay in sync.
(albumModal.querySelector('.card-shuffle') as HTMLElement).addEventListener('click', () => toggleShuffle());
(albumModal.querySelector('.card-repeat') as HTMLElement).addEventListener('click', () => cycleAfterAlbum());
// Volume slider (mirrors the card's) — icons are JS SVG constants, so fill them here.
{
  const icons = albumModal.querySelectorAll('.am-vol .vol-ico');
  if (icons[0]) icons[0].innerHTML = VOL_LOW_SVG;
  if (icons[1]) icons[1].innerHTML = VOL_HIGH_SVG;
  wireVol(albumModal.querySelector('.am-vol') as HTMLElement);
}
// Tap the overlay seek bar to scrub (mirrors the card's nowbar seek).
(albumModal.querySelector('.am-nowbar .seek') as HTMLElement).addEventListener('click', (e) => {
  if (now.duration <= 0 || !now.playerId || !modalIsPlaying()) return;
  const seek = albumModal.querySelector('.am-nowbar .seek') as HTMLElement;
  const rect = seek.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, ((e as MouseEvent).clientX - rect.left) / rect.width));
  const pos = Math.floor(ratio * now.duration);
  now.elapsed = pos;
  now.at = performance.now();
  updateModalNowbar();
  void client.transport({ playerId: now.playerId, cmd: 'seek', position: pos }).catch(() => {});
});

function closeAlbumModal(): void {
  albumModal.hidden = true;
  modalUri = null;
  modalAlbumUri = null;
  groupSelect = null; // leaving the overlay exits any in-progress grouping
}

/** Is the album shown in the overlay the one currently playing? (Playlists report the
    current track's album, not the playlist, so we don't track "playing" for them.) */
function modalIsPlaying(): boolean {
  if (modalIsPlaylist) return false;
  const id = modalAlbumUri ? albumIdFromUri(modalAlbumUri) : null;
  return !!id && now.state !== 'idle' && now.albumId === id;
}
/** Has the user picked a different room/track in the overlay than what's playing? */
function modalSelectionChanged(): boolean {
  if (!modalIsPlaying()) return false;
  const roomChanged = activePlayerId != null && activePlayerId !== now.playerId;
  const trackChanged = modalCue >= 0 && modalCue !== now.trackIndex;
  return roomChanged || trackChanged;
}
/** Overlay Play button: pause/resume when this album is playing unchanged, else play
    the current selection. Skips flank it (like the expanded card) while it's playing. */
async function onModalPlay(): Promise<void> {
  if (modalIsPlaying() && !modalSelectionChanged() && now.playerId) {
    const pausing = now.state === 'playing';
    now.elapsed = liveElapsed();
    now.at = performance.now();
    now.state = pausing ? 'paused' : 'playing';
    userPaused = pausing;
    pauseGuardUntil = pausing ? performance.now() + 3000 : 0;
    resumeGuardUntil = pausing ? 0 : performance.now() + 3000;
    applyNow();
    updateModalTransport();
    await client.transport({ playerId: now.playerId, cmd: pausing ? 'pause' : 'play' }).catch(() => {});
    return;
  }
  await playModal();
}
/** Show/hide the overlay skips and set its Play/Pause/Resume label. */
function updateModalTransport(): void {
  if (albumModal.hidden) return;
  const prev = albumModal.querySelector('.am-prev') as HTMLElement;
  const next = albumModal.querySelector('.am-next') as HTMLElement;
  const play = albumModal.querySelector('.am-play') as HTMLElement;
  const toggle = modalIsPlaying() && !modalSelectionChanged();
  prev.hidden = !toggle;
  next.hidden = !toggle;
  play.textContent = toggle ? (now.state === 'playing' ? 'Pause' : 'Resume') : 'Play';
  renderModesIn(albumModal.querySelector('.am-card') as HTMLElement, modalIsPlaying());
}
/** Mark the currently-playing track in the overlay with the EQ (when its album plays). */
function updateModalNowTrack(): void {
  if (albumModal.hidden) return;
  const playing = modalIsPlaying();
  const buffering = playBuffering();
  albumModal.querySelectorAll('.am-tracks .track').forEach((row, ti) => {
    const isNow = playing && isNowTrack((row as HTMLElement).dataset.uri, ti);
    row.classList.toggle('now', isNow);
    const n = row.querySelector('.n');
    if (n) n.innerHTML = isNow ? (buffering ? NOW_SPINNER : TRACK_EQ) : String(ti + 1);
  });
}

async function openProviderAlbum(uri: string): Promise<void> {
  modalUri = uri;
  modalAlbumUri = null;
  modalCue = -1;
  modalIsPlaylist = false;
  const set = (sel: string, text: string): void => {
    (albumModal.querySelector(sel) as HTMLElement).textContent = text;
  };
  set('.am-title', 'Loading…');
  set('.am-artist', '');
  set('.am-eyebrow', ''); // set to the real source once the detail loads (Apple Music, Spotify, …)
  (albumModal.querySelector('.am-cover') as HTMLElement).style.backgroundImage = '';
  (albumModal.querySelector('.am-tracks') as HTMLElement).innerHTML = '';
  (albumModal.querySelector('.am-add') as HTMLElement).innerHTML = '';
  albumModal.hidden = false;
  syncVol(albumModal.querySelector('.am-vol'));

  let d: ProviderAlbumDetail;
  try {
    d = await client.getProviderAlbum(uri);
  } catch {
    if (modalUri === uri) set('.am-title', 'Couldn’t load album');
    return;
  }
  if (modalUri !== uri) return; // superseded by a newer open
  modalAlbumUri = d.providerUri;
  modalCue = d.cueIndex;
  (albumModal.querySelector('.am-cover') as HTMLElement).style.backgroundImage = d.artworkUrl ? `url('${d.artworkUrl}')` : '';
  set('.am-eyebrow', d.source || 'Music');
  set('.am-title', d.title);
  set('.am-artist', d.artist);
  renderModalTracks(d.tracks, d.cueIndex);
  renderRooms(albumModal.querySelector('.am-card') as HTMLElement); // reuse the room picker
  const addSlot = albumModal.querySelector('.am-add') as HTMLElement;
  if (d.onShelf) {
    // Already in the library → offer to jump to it on the shelf instead of an Add control.
    const albumId = albumIdFromUri(d.providerUri);
    const openBtn = document.createElement('button');
    openBtn.className = 'find-card-add am-openshelf';
    openBtn.textContent = 'Open on shelf';
    openBtn.onclick = () => {
      closeAlbumModal();
      openShelfAlbum(albumId);
    };
    addSlot.appendChild(openBtn);
  } else {
    addSlot.appendChild(addAlbumControl(d.providerUri));
  }
  updateModalTransport();
  updateModalNowTrack();
}

/** Render the overlay's track list (album or playlist). Tap = select/highlight only;
    the top Play button plays the selected track. Playlist rows show the track artist. */
function renderModalTracks(tracks: Track[], cueIndex: number, withArtist = false): void {
  const tw = albumModal.querySelector('.am-tracks') as HTMLElement;
  tw.innerHTML = '';
  tracks.forEach((t, ti) => {
    const row = document.createElement('div');
    row.className = 'track' + (ti === cueIndex ? ' cued' : '');
    if (t.uri) row.dataset.uri = t.uri;
    const dur = t.duration ? fmtDur(t.duration) : '';
    const label = withArtist && t.artist ? `${escapeHtml(t.title)} · ${escapeHtml(t.artist)}` : escapeHtml(t.title);
    const ex = t.explicit ? ' <span class="ex-badge" title="Explicit">E</span>' : '';
    row.innerHTML = `<span class="n">${ti + 1}</span><span class="tt">${label}${ex}</span><span class="dur">${dur}</span>`;
    row.addEventListener('click', () => {
      modalCue = ti;
      tw.querySelectorAll('.track').forEach((r, idx) => r.classList.toggle('cued', idx === ti));
      updateModalTransport();
    });
    tw.appendChild(row);
  });
  updateModalNowTrack();
}

/** Play-now overlay for a playlist — mirrors the album overlay but plays the playlist
    uri (from the selected track), and its Add control targets the playlists shelf. */
async function openPlaylistOverlay(pl: LibraryPlaylist): Promise<void> {
  modalUri = pl.providerUri;
  modalAlbumUri = pl.providerUri; // playModal plays the playlist uri
  modalCue = -1;
  modalIsPlaylist = true;
  const set = (sel: string, text: string): void => {
    (albumModal.querySelector(sel) as HTMLElement).textContent = text;
  };
  set('.am-eyebrow', 'Playlist');
  set('.am-title', pl.name);
  set('.am-artist', pl.owner ?? '');
  (albumModal.querySelector('.am-cover') as HTMLElement).style.backgroundImage = pl.artworkUrl ? `url('${pl.artworkUrl}')` : '';
  (albumModal.querySelector('.am-tracks') as HTMLElement).innerHTML = '';
  (albumModal.querySelector('.am-add') as HTMLElement).innerHTML = '';
  (albumModal.querySelector('.am-add') as HTMLElement).appendChild(playlistAddControl(pl));
  albumModal.hidden = false;
  syncVol(albumModal.querySelector('.am-vol'));
  renderRooms(albumModal.querySelector('.am-card') as HTMLElement);
  updateModalTransport();
  let tracks: Track[];
  try {
    tracks = await client.getPlaylistTracks(pl.providerUri);
  } catch {
    if (modalUri === pl.providerUri) (albumModal.querySelector('.am-tracks') as HTMLElement).innerHTML = '';
    return;
  }
  if (modalUri !== pl.providerUri) return; // superseded
  renderModalTracks(tracks, -1, true);
}

async function playModal(trackIndex?: number): Promise<void> {
  if (!modalAlbumUri) return;
  const cue = trackIndex ?? (modalCue >= 0 ? modalCue : 0);
  if (activePlayerId && activeSolo) await ungroupActiveSoloIfNeeded();
  // Optimistic now-state so the overlay flips to playing right away (song EQ + the
  // ⏮ Pause ⏭ transport), like the album card. Albums only — a playlist reports its
  // current track's album, not the playlist itself, so it can't be matched here.
  if (!modalIsPlaylist) {
    userPaused = false;
    pauseGuardUntil = 0;
    resumeGuardUntil = performance.now() + 8000;
    selfPlayUntil = performance.now() + 8000; // Crate started this — not "external"
    if (activePlayerId) focusedPlayerId = activePlayerId;
    // Selection is committed to playback — clear the cue so it doesn't read as a pending
    // change. The queue index MA reports (0 after start_item) won't match the tapped index,
    // which otherwise kept modalSelectionChanged() true and flipped the button back to Play
    // (leaving no way to pause). Mirrors songCue.delete in the card's play().
    modalCue = -1;
    // Buffer like the card: show the connecting spinner (not the EQ) until the room really plays
    // what we asked for. No shelf spine here, so gate on the uri only.
    playPendingIdx = -1;
    playPendingUntil = performance.now() + 8000;
    playPendingUri = modalAlbumUri;
    playPendingAlbum = (albumModal.querySelector('.am-title') as HTMLElement)?.textContent || null; // name fallback
    now = { playerId: activePlayerId, albumId: albumIdFromUri(modalAlbumUri), trackIndex: cue, trackUri: null, elapsed: 0, duration: 0, state: 'playing', mediaKind: 'album', at: performance.now() };
    applyNow();
    renderRooms(albumModal.querySelector('.am-card') as HTMLElement); // reflect the target room's spinner now
  }
  showToast(`Sent to ${roomName(activePlayerId)}…`);
  client
    .play({
      albumId: modalAlbumUri,
      providerUri: modalAlbumUri,
      ...(activePlayerId ? { playerId: activePlayerId } : {}),
      ...(cue > 0 ? { trackIndex: cue } : {}),
    })
    .catch((e) => showPlayError(e));
}

/** A fixed-position dropdown anchored to a button, on <body> so the results
    strip's overflow can't clip it. One menu open at a time. */
let activeAddMenu: HTMLElement | null = null;
function closeAddMenu(): void {
  if (!activeAddMenu) return;
  const out = (activeAddMenu as unknown as { _out?: (e: Event) => void })._out;
  if (out) document.removeEventListener('pointerdown', out, true);
  activeAddMenu.remove();
  activeAddMenu = null;
}
function openAddMenu(anchor: HTMLElement, options: Array<{ label: string; on?: boolean; fn: () => void }>): void {
  closeAddMenu();
  const menu = document.createElement('div');
  menu.className = 'find-add-menu';
  for (const o of options) {
    const b = document.createElement('button');
    b.className = 'find-add-opt' + (o.on ? ' on' : '');
    b.textContent = o.label;
    b.onclick = (e) => {
      e.stopPropagation();
      closeAddMenu();
      o.fn();
    };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  // Open above the anchor by default; flip below if it would run off the top, then clamp
  // fully within the viewport so the options stay reachable (it grows upward from a button
  // near the top of the list, which used to push the menu off the top of the screen).
  const mh = menu.offsetHeight;
  let top = r.top - 6 - mh;
  if (top < 8) top = r.bottom + 6;
  menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - mh - 8))}px`;
  const out = (e: Event): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) closeAddMenu();
  };
  (menu as unknown as { _out: (e: Event) => void })._out = out;
  activeAddMenu = menu;
  setTimeout(() => document.addEventListener('pointerdown', out, true), 0);
}

function cardShell(title: string, artist: string, artUrl: string | null, action: string, source?: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'find-card';
  const art = artUrl ? ` style="background-image:url('${artUrl}')"` : '';
  card.innerHTML =
    `<div class="find-card-art"${art}>${srcArtIcon(source)}</div>` +
    `<div class="find-card-meta"><span class="t">${escapeHtml(title)}</span><span class="a">${escapeHtml(artist)}</span></div>` +
    `<button class="find-card-add">${action}</button>`;
  return card;
}

/** The result's source icon, overlaid on the artwork corner — shown whenever the source is known
    (so you can see at a glance whether a hit is from Apple Music, TuneIn, etc.). */
function srcArtIcon(source?: string): string {
  if (!source) return '';
  const icon = searchSourceIcon.get(source) ?? sourceIconByName.get(source);
  return icon ? `<span class="find-card-srcico" title="${escapeHtml(source)}">${icon}</span>` : '';
}

/** Switch focus to the shelf album by id and open its spine (from the Find bar). */
function openShelfAlbum(albumId: string): void {
  const idx = items.findIndex((x) => x.albumId === albumId);
  clearSearch();
  closeFind();
  if (idx >= 0) openAlbum(idx);
}

/** A shelf match — tapping the card opens the play-now overlay; the Open button goes
    to the album on the shelf, and its ▾ adds it to other shelves or removes it. */
function shelfCard(it: ShelfItem): HTMLElement {
  const card = cardShell(it.title, it.artist, it.artworkUrl, '');
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap');
  const openOnShelf = (): void => openShelfAlbum(it.albumId);
  // Tap the card → play-now overlay (if we have the provider uri); else fall back to
  // opening it on the shelf. The "Open" button always goes to the shelf.
  card.addEventListener('click', () => {
    if (it.providerUri) void openProviderAlbum(it.providerUri);
    else openOnShelf();
  });
  card.appendChild(addedAlbumControl(it.albumId, openOnShelf, it.providerUri ?? undefined));
  return card;
}

/** "Open" + a ▾ for an album already in the library: add it to other album shelves,
    a new one, or remove it. Used on search cards for albums that are on a shelf. */
function addedAlbumControl(albumId: string, open: () => void, providerUri?: string): HTMLElement {
  const ctrl = document.createElement('div');
  ctrl.className = 'find-add-ctrl';
  const mainBtn = document.createElement('button');
  mainBtn.className = 'find-card-add';
  mainBtn.textContent = 'Open';
  mainBtn.onclick = (e) => {
    e.stopPropagation();
    open();
  };
  const caret = document.createElement('button');
  caret.className = 'find-card-caret';
  caret.textContent = '▾';
  caret.onclick = (e) => {
    e.stopPropagation();
    if (activeAddMenu) {
      closeAddMenu();
      return;
    }
    const albumShelves = shelves.filter((s) => s.kind === 'album' && s.id !== 'all');
    openAddMenu(caret, [
      ...albumShelves.map((s) => ({ label: `Add to ${s.name}`, fn: () => void addExistingToShelf(albumId, s.id) })),
      { label: '+ New shelf', fn: () => void addExistingToNewShelf(albumId) },
      { label: 'Remove from library', fn: () => void removeAddedAlbum(albumId, ctrl, providerUri) },
    ]);
  };
  ctrl.append(mainBtn, caret);
  return ctrl;
}

/** Remove an album from the library from a search card; revert the control to "Add"
    (so it can be re-added) when we still have its provider uri. */
async function removeAddedAlbum(albumId: string, ctrl: HTMLElement, providerUri?: string): Promise<void> {
  closeAddMenu();
  try {
    await client.removeFromShelf(albumId);
    showToast('Removed from library');
    if (providerUri) ctrl.replaceWith(addAlbumControl(providerUri));
    else {
      ctrl.querySelector('.find-card-caret')?.remove();
      const b = ctrl.querySelector('.find-card-add') as HTMLButtonElement | null;
      if (b) {
        b.textContent = 'Removed';
        b.disabled = true;
      }
    }
  } catch {
    showToast('Remove failed');
  }
}

/** Add an existing library album to a shelf by id, then reveal it there. */
async function addExistingToShelf(albumId: string, shelfId: string): Promise<void> {
  closeAddMenu();
  try {
    await client.addAlbumToShelf(shelfId, albumId);
    const n = shelves.find((s) => s.id === shelfId)?.name;
    showToast(n ? `Added to ${n}` : 'Added');
    void revealAddedAlbumById(shelfId, albumId);
  } catch {
    showToast('Add failed');
  }
}

/** Create a new album shelf, add the existing album to it, switch + rename. */
async function addExistingToNewShelf(albumId: string): Promise<void> {
  closeAddMenu();
  const sh = await client.createShelf({ name: 'New shelf', kind: 'album' }).catch(() => null);
  if (!sh) {
    showToast('Could not create shelf');
    return;
  }
  shelves.push(sh);
  clearSearch();
  await switchShelf(sh.id, false); // auto-select the new shelf, keep Find open
  shelfRenaming = sh.id;
  renderShelfList();
  await client.addAlbumToShelf(sh.id, albumId).catch(() => {});
}

/** Jump to the All Playlists shelf and open the named playlist's card. */
async function openAddedPlaylist(name: string): Promise<void> {
  clearSearch();
  await switchShelf('playlists'); // closes the Find bar
  const idx = items.findIndex((it) => it.title === name);
  if (idx >= 0) openAlbum(idx);
}

/** Add control shared by the picker and playlist search: the button adds to All
    Playlists (or Opens it if already added); the ▾ makes it its own song shelf. */
function playlistAddControl(pl: LibraryPlaylist): HTMLElement {
  const ctrl = document.createElement('div');
  ctrl.className = 'find-add-ctrl';
  const mainBtn = document.createElement('button');
  mainBtn.className = 'find-card-add';
  const caret = document.createElement('button');
  caret.className = 'find-card-caret';
  caret.textContent = '▾';
  let added = pl.onShelf;
  mainBtn.textContent = added ? 'Open' : 'Add';

  const ensureAdded = async (): Promise<boolean> => {
    if (added) return true;
    try {
      await client.addPlaylist(pl.providerUri);
      added = true;
      return true;
    } catch {
      showToast('Add failed');
      return false;
    }
  };

  // Default action: add the playlist to the All Playlists shelf (or Open if it's there).
  const addToAll = async (): Promise<void> => {
    if (added) {
      showToast('Already on All Playlists');
      return;
    }
    mainBtn.disabled = true;
    caret.disabled = true;
    mainBtn.textContent = 'Adding…';
    if (await ensureAdded()) mainBtn.textContent = 'Added';
    else {
      mainBtn.disabled = false;
      caret.disabled = false;
      mainBtn.textContent = 'Add';
    }
  };
  mainBtn.onclick = () => {
    if (added) void openAddedPlaylist(pl.name);
    else void addToAll();
  };
  caret.onclick = (e) => {
    e.stopPropagation();
    if (activeAddMenu) {
      closeAddMenu();
      return;
    }
    openAddMenu(caret, [
      { label: 'Add to all playlists shelf', fn: () => void addToAll() },
      { label: 'Create song shelf', fn: () => void makeSongShelfFromPlaylist(pl) },
    ]);
  };
  ctrl.append(mainBtn, caret);
  return ctrl;
}

/** Make (or reuse) a single-playlist song shelf from a picker/search playlist,
    prewarming album-cover resolution first for a rendering head start. */
async function makeSongShelfFromPlaylist(pl: LibraryPlaylist): Promise<void> {
  void client.prewarmPlaylist(pl.providerUri); // head start on album art
  try {
    await client.addPlaylist(pl.providerUri); // ensure it exists as media (idempotent)
  } catch {
    showToast('Add failed');
    return;
  }
  const res = await client.getShelf('playlists');
  shelves = res.shelves;
  sourceKinds = res.sourceKinds;
  updateMediaTabs();
  const media = res.items.find((it) => it.title === pl.name);
  if (!media) {
    showToast('Could not open shelf');
    return;
  }
  clearSearch();
  await openAsSongShelf(media.albumId, pl.name);
}

/** Deterministic album id from a provider uri (mirrors the server's albumIdFromUri). */
function albumIdFromUri(uri: string): string {
  return uri
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** After adding an album to a named shelf, switch the wall to it and scroll to the
    album — leaving the Find bar open so you can keep adding (#7). */
/** Switch the wall to a shelf, scroll to an album by id, and flip it open behind the
    still-open Find bar so it's ready when you dismiss the search. */
async function revealAddedAlbumById(shelfId: string, albumId: string): Promise<void> {
  await switchShelf(shelfId, false); // keep the Find bar open
  const idx = items.findIndex((it) => it.albumId === albumId);
  if (idx >= 0) {
    openAlbum(idx, false);
    requestAnimationFrame(() => smoothScrollTo(vp, settledLeft(idx) - vp.clientWidth * 0.12));
  }
}

/** An album search hit (on- or off-shelf). Tapping the card opens the play-now
    overlay; on-shelf albums get Open + ▾ (with an "Open on shelf" button in the
    overlay too), off-shelf albums get Add + ▾. */
function albumResultCard(al: SearchAlbum): HTMLElement {
  const card = cardShell(al.title, al.artist, al.artworkUrl, '', al.source);
  // Tell identical-looking versions apart: edition tag + explicit badge.
  const t = card.querySelector('.find-card-meta .t');
  if (t) {
    if (al.explicit) t.insertAdjacentHTML('beforeend', ` <span class="ex-badge" title="Explicit">E</span>`);
    // Only tag the edition when the title doesn't already spell it out.
    if (al.version && !al.title.toLowerCase().includes(al.version.toLowerCase()))
      t.insertAdjacentHTML('beforeend', ` <span class="ver-tag">${escapeHtml(al.version)}</span>`);
  }
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap');
  const albumId = albumIdFromUri(al.providerUri);
  const openOnShelf = (): void => openShelfAlbum(albumId);
  card.addEventListener('click', () => void openProviderAlbum(al.providerUri)); // overlay decides on-shelf
  card.appendChild(al.onShelf ? addedAlbumControl(albumId, openOnShelf, al.providerUri) : addAlbumControl(al.providerUri));
  return card;
}

/** The "Add to ‹shelf›" button + ▾ destination dropdown for one album provider uri.
    Shared by the search cards and the standalone album modal. */
function addAlbumControl(providerUri: string): HTMLElement {
  const albumShelves = (): Shelf[] => shelves.filter((s) => s.kind === 'album' && s.id !== 'all');
  const nameOf = (id: string): string | null => (id === 'all' ? null : (shelves.find((s) => s.id === id)?.name ?? null));
  const defaultDest = activeShelf !== 'all' && shelves.some((s) => s.id === activeShelf && s.kind === 'album') ? activeShelf : 'all';

  const ctrl = document.createElement('div');
  ctrl.className = 'find-add-ctrl';
  const mainBtn = document.createElement('button');
  mainBtn.className = 'find-card-add';
  const caret = document.createElement('button');
  caret.className = 'find-card-caret';
  caret.textContent = '▾';

  const setIdle = (): void => {
    const n = nameOf(defaultDest);
    mainBtn.textContent = n ? `Add to ${n}` : 'Add';
  };
  setIdle();

  const doAdd = async (shelfId: string): Promise<void> => {
    closeAddMenu();
    mainBtn.disabled = true;
    caret.disabled = true;
    mainBtn.textContent = 'Adding…';
    try {
      const res = await client.addToShelf({ providerUri, ...(shelfId !== 'all' ? { shelfId } : {}) });
      // The server may dedupe to an existing release of the same album — use its id.
      const albumId = res.albumId;
      if (res.duplicate) showToast('Already in your library');
      // Morph into the "added" state: Open + ▾ (add-to-other / remove), like the others.
      ctrl.replaceWith(addedAlbumControl(albumId, () => openShelfAlbum(albumId), res.duplicate ? undefined : providerUri));
      // Reveal the album on the shelf behind the still-open Find bar (any destination).
      void revealAddedAlbumById(shelfId, albumId);
    } catch {
      mainBtn.disabled = false;
      caret.disabled = false;
      setIdle();
      showToast('Add failed');
    }
  };

  mainBtn.onclick = (e) => {
    e.stopPropagation(); // don't also trigger a card tap
    void doAdd(defaultDest);
  };
  caret.onclick = (e) => {
    e.stopPropagation();
    if (activeAddMenu) {
      closeAddMenu();
      return;
    }
    openAddMenu(caret, [
      { label: 'Library (All)', on: defaultDest === 'all', fn: () => void doAdd('all') },
      ...albumShelves().map((s) => ({ label: s.name, on: s.id === defaultDest, fn: () => void doAdd(s.id) })),
      { label: '+ New shelf', fn: () => void addToNewShelf(providerUri) },
    ]);
  };

  ctrl.append(mainBtn, caret);
  return ctrl;
}

/** Create a new album shelf, add the album to it, switch to it (auto-select),
    and drop its chip into rename mode so you can name it. */
async function addToNewShelf(providerUri: string): Promise<void> {
  const sh = await client.createShelf({ name: 'New shelf', kind: 'album' }).catch(() => null);
  if (!sh) {
    showToast('Could not create shelf');
    return;
  }
  shelves.push(sh);
  clearSearch();
  await switchShelf(sh.id, false); // auto-select the new (empty) shelf, keep Find open
  shelfRenaming = sh.id;
  renderShelfList();
  // Add after switching so the resulting broadcast reloads THIS shelf, not the old one.
  await client.addToShelf({ providerUri, shelfId: sh.id }).catch(() => {});
}

/** Clear the search query AND any committed shelf filter, un-hiding every spine. */
function clearSearch(): void {
  filterQuery = '';
  shelfFilter = '';
  findSearch.value = '';
  findClear.hidden = true;
  items.forEach((_, i) => (shelf.children[i] as HTMLElement | undefined)?.classList.remove('sliver'));
  sizeFaces();
  clearFindResults();
}

/* =====================================================================
   Shelves ("crates"): the Find bar doubles as the shelf switcher — Albums /
   Playlists tabs + a list of shelves you tap to switch the wall.
   ===================================================================== */
const findShelfList = document.getElementById('find-shelf-list') as HTMLElement;
const findContinue = document.getElementById('find-continue') as HTMLElement;

document.querySelectorAll<HTMLElement>('.find-shelf-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    shelfTab = tab.dataset['kind'] as ShelfKind;
    shelfAdding = false;
    shelfDeleteArmed = null;
    shelfRenaming = null;
    document.querySelectorAll('.find-shelf-tab').forEach((t) => t.classList.toggle('on', t === tab));
    renderShelfList();
    void renderContinueStrip(); // spoken-word tabs get an in-progress "Continue listening" row
    // Keep the query across tabs and re-run it scoped to the new kind (an artist detail closes).
    if (filterQuery) {
      artistView = null;
      resetSearchPaging();
      searchSource = defaultSourceFor(shelfTab);
      searchSourceUserSet = false;
      renderSearch(true); // loading scaffold in the new scope
      void runSearch();
    } else {
      clearSearch();
    }
  });
});

/** "Continue listening": a strip of in-progress episodes/audiobooks above the shelf chips,
    shown only on the Podcasts/Audiobooks tabs. Tapping a card resumes where you left off.
    The token guards against a slow fetch landing after the user has switched tabs. */
let continueToken = 0;
// Locally-dismissed continue-listening items (the hover ✕ on each card). Keyed by uri → the resume
// position when dismissed, so making fresh progress on the same item later brings it back.
const CONTINUE_DISMISS_KEY = 'crate.continueDismissed';
function loadContinueDismissed(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CONTINUE_DISMISS_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function dismissContinue(it: MediaBrowseItem): void {
  const d = loadContinueDismissed();
  d[it.providerUri] = it.resumeMs ?? 0;
  try {
    localStorage.setItem(CONTINUE_DISMISS_KEY, JSON.stringify(d));
  } catch {
    /* best-effort — dismissals are a convenience, not critical state */
  }
}
function isContinueDismissed(it: MediaBrowseItem): boolean {
  const d = loadContinueDismissed();
  return Object.prototype.hasOwnProperty.call(d, it.providerUri) && d[it.providerUri] === (it.resumeMs ?? 0);
}
async function renderContinueStrip(): Promise<void> {
  const kind = shelfTab;
  findContinue.hidden = true;
  findContinue.innerHTML = '';
  if (kind !== 'podcast' && kind !== 'audiobook') return;
  const token = ++continueToken;
  const list = (await client.continueListening(kind).catch((): MediaBrowseItem[] => [])).filter((it) => !isContinueDismissed(it));
  if (token !== continueToken || shelfTab !== kind || !list.length) return;
  const head = document.createElement('div');
  head.className = 'find-subhead';
  head.textContent = 'Continue listening';
  findContinue.appendChild(head);
  const row = document.createElement('div');
  row.className = 'find-continue-row';
  list.forEach((it) => row.appendChild(continueCard(it, kind)));
  findContinue.appendChild(row);
  findContinue.hidden = false;
}

function continueCard(it: MediaBrowseItem, kind: ExtraMediaKind): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'find-continue-item';
  const card = document.createElement('button');
  card.className = 'find-continue-card';
  const resumeSec = it.resumeMs != null ? it.resumeMs / 1000 : 0;
  const pct = it.durationSec ? Math.min(100, (resumeSec / it.durationSec) * 100) : 0;
  const left = it.durationSec ? `${Math.max(1, Math.round((it.durationSec - resumeSec) / 60))} min left` : '';
  const art = it.artworkUrl ? ` style="background-image:url('${it.artworkUrl}')"` : '';
  card.innerHTML =
    `<span class="fc-art"${art}></span>` +
    `<span class="fc-title">${escapeHtml(it.name)}</span>` +
    (it.description ? `<span class="fc-sub">${escapeHtml(it.description)}</span>` : '') +
    `<span class="fc-bar"><span class="fc-bar-fill" style="width:${pct}%"></span></span>` +
    (left ? `<span class="fc-left">${left}</span>` : '');
  card.onclick = () => void resumeContinue(it, kind);
  // Hover ✕ → dismiss this item from the strip (kept out of view until fresh progress).
  const rm = document.createElement('button');
  rm.className = 'find-continue-x';
  rm.setAttribute('aria-label', `Remove ${it.name} from Continue listening`);
  rm.textContent = '✕';
  rm.onclick = (e) => {
    e.stopPropagation();
    dismissContinue(it);
    wrap.remove();
    const row = findContinue.querySelector('.find-continue-row');
    if (row && !row.children.length) {
      findContinue.hidden = true;
      findContinue.innerHTML = '';
    }
  };
  wrap.append(card, rm);
  return wrap;
}

/** Resume a continue-listening card: play its uri (MA auto-resumes from the saved spot). */
async function resumeContinue(it: MediaBrowseItem, kind: ExtraMediaKind): Promise<void> {
  const player = activePlayerId ? { playerId: activePlayerId } : {};
  const body =
    kind === 'podcast'
      ? { albumId: it.providerUri, trackUris: [it.providerUri], ...player }
      : { albumId: it.providerUri, providerUri: it.providerUri, ...player };
  await client.play(body).catch(() => {});
  showToast(`Resuming ${it.name}`);
}

function renderShelfList(): void {
  findShelfList.innerHTML = '';
  // Active shelf filter lives here in the overlay (not on the shelf); clearing it opens All.
  if (shelfFilter) {
    const fc = document.createElement('div');
    fc.className = 'find-filter-active';
    fc.innerHTML = `<span>Filtering shelf: “${escapeHtml(shelfFilter)}”</span><button aria-label="Clear filter">✕</button>`;
    (fc.querySelector('button') as HTMLElement).onclick = (e) => {
      e.stopPropagation();
      clearShelfFilter();
    };
    findShelfList.appendChild(fc);
  }
  for (const s of shelves.filter((sh) => sh.kind === shelfTab)) {
    const selected = s.id === activeShelf;
    const editable = selected && !VIRTUAL_SHELVES.has(s.id);
    const chip = document.createElement('div');
    chip.className = 'find-shelf chip' + (selected ? ' on' : '') + (editable ? ' has-actions' : '');
    if (editable && shelfRenaming === s.id) {
      // Inline rename box + ✓/✕ (wall has no Enter key).
      const input = document.createElement('input');
      input.className = 'find-shelf-input';
      input.value = s.name;
      const ok = document.createElement('button');
      ok.className = 'find-shelf-ok';
      ok.textContent = '✓';
      ok.onclick = () => void doRename(s.id, input.value);
      const cancelRename = (): void => {
        shelfRenaming = null;
        renderShelfList();
      };
      const no = document.createElement('button');
      no.className = 'find-shelf-cancel';
      no.textContent = '✕';
      no.onclick = cancelRename;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void doRename(s.id, input.value);
        else if (e.key === 'Escape') cancelRename();
      });
      chip.append(input, ok, no);
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    } else {
      // The whole pill switches shelves (not just the name); the edit/delete
      // sub-buttons stopPropagation so they don't also switch.
      chip.onclick = () => void switchShelf(s.id);
      const name = document.createElement('span');
      name.className = 'find-shelf-name';
      name.textContent = s.name;
      chip.appendChild(name);
      if (editable) {
        const edit = document.createElement('button');
        edit.className = 'find-shelf-edit';
        edit.textContent = '✎';
        edit.onclick = (e) => {
          e.stopPropagation();
          shelfRenaming = s.id;
          shelfDeleteArmed = null;
          renderShelfList();
        };
        const x = document.createElement('button');
        const armed = shelfDeleteArmed === s.id;
        x.className = 'find-shelf-x' + (armed ? ' armed' : '');
        x.textContent = armed ? 'Delete?' : '✕';
        x.onclick = (e) => {
          e.stopPropagation();
          void onDeleteShelf(s.id);
        };
        chip.append(edit, x);
      }
    }
    findShelfList.appendChild(chip);
  }
  // Add control: album shelves are named here; playlist shelves come from the library; the
  // extra-media shelves (radio/podcasts/audiobooks) are curated from the admin app (no control).
  if (EXTRA_MEDIA.some((m) => m.kind === shelfTab)) {
    /* nothing to add on the wall */
  } else if (shelfTab === 'playlist') {
    const add = document.createElement('button');
    add.className = 'find-shelf find-shelf-new';
    add.textContent = '+ Add playlists';
    add.onclick = () => void openPlaylistPicker();
    findShelfList.appendChild(add);
  } else if (shelfAdding) {
    findShelfList.appendChild(newShelfInput());
  } else {
    const add = document.createElement('button');
    add.className = 'find-shelf find-shelf-new';
    add.textContent = '+ New';
    add.onclick = () => {
      shelfAdding = true;
      renderShelfList();
    };
    findShelfList.appendChild(add);
  }
}

async function doRename(id: string, name: string): Promise<void> {
  const nm = name.trim();
  shelfRenaming = null;
  if (!nm) {
    renderShelfList();
    return;
  }
  await client.renameShelf(id, nm).catch(() => {});
  const s = shelves.find((x) => x.id === id);
  if (s) s.name = nm;
  renderShelfList();
}

/** Two-tap delete: first tap arms (✕ → "Delete?"), second confirms. */
async function onDeleteShelf(id: string): Promise<void> {
  if (shelfDeleteArmed !== id) {
    shelfDeleteArmed = id;
    renderShelfList();
    setTimeout(() => {
      if (shelfDeleteArmed === id) {
        shelfDeleteArmed = null;
        renderShelfList();
      }
    }, 3000);
    return;
  }
  shelfDeleteArmed = null;
  await client.deleteShelf(id).catch(() => {});
  shelves = shelves.filter((s) => s.id !== id);
  if (activeShelf === id) await switchShelf('all', false);
  else renderShelfList();
}

/** Add-flow for playlists: pick from your provider-library playlists. Reuses the
    Find pick-list area (findResults). */
async function openPlaylistPicker(): Promise<void> {
  searchSeq++; // cancel any in-flight search render
  findResults.hidden = false;
  findResults.innerHTML = '<div class="find-empty">Loading your playlists…</div>';
  let list: LibraryPlaylist[];
  try {
    list = await client.listLibraryPlaylists();
  } catch {
    findResults.innerHTML = '<div class="find-empty">Couldn’t load playlists.</div>';
    return;
  }
  findResults.innerHTML = '';
  // Header with a Done button so the picker is always dismissable (returns to the shelf
  // list) — and a scrollable list so a long library can't push the find-bar (and its close
  // handle) off the top of the screen.
  const head = document.createElement('div');
  head.className = 'find-pick-head';
  head.innerHTML = '<span class="find-pick-title">Add playlists</span>';
  const done = document.createElement('button');
  done.className = 'find-pick-done';
  done.textContent = 'Done';
  done.onclick = () => {
    findResults.hidden = true;
    findResults.innerHTML = '';
  };
  head.appendChild(done);
  findResults.appendChild(head);
  if (!list.length) {
    findResults.appendChild(Object.assign(document.createElement('div'), { className: 'find-empty', textContent: 'No playlists in your library.' }));
    return;
  }
  const scroller = document.createElement('div');
  scroller.className = 'find-cat-list'; // reuse the scrollable list (max-height + overflow)
  for (const pl of list) scroller.appendChild(playlistCard(pl));
  findResults.appendChild(scroller);
}

function playlistCard(pl: LibraryPlaylist): HTMLElement {
  const card = cardShell(pl.name, pl.owner ?? 'Playlist', pl.artworkUrl, '', pl.source);
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap'); // tap → play-now overlay (like albums/songs)
  card.addEventListener('click', () => void openPlaylistOverlay(pl));
  card.appendChild(playlistAddControl(pl));
  return card;
}

async function switchShelf(id: string, close = true): Promise<void> {
  shelfAdding = false;
  shelfDeleteArmed = null;
  shelfRenaming = null;
  shelfFilter = ''; // switching shelves drops any active filter
  const tok = ++shelfLoadToken;
  const res = await client.getShelf(id === 'all' ? undefined : id);
  if (tok !== shelfLoadToken) return; // a newer load superseded this one
  activeShelf = id;
  items = res.items;
  shelves = res.shelves;
  sourceKinds = res.sourceKinds;
  updateMediaTabs();
  applySort();
  openIdx = null;
  buildShelf();
  sizeFaces();
  autoOpenIfSingle();
  applyNow();
  renderShelfList();
  if (close) closeFind();
  showToast(shelves.find((s) => s.id === id)?.name ?? 'Shelf');
}

/** The inline "name this shelf" box + ✓/✕ (the wall has no Enter key). */
function newShelfInput(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'find-shelf-add';
  const input = document.createElement('input');
  input.className = 'find-shelf-input';
  input.placeholder = 'Name this shelf…';
  input.autocomplete = 'off';
  const confirm = (): void => {
    if (input.value.trim()) void createNamedShelf(input.value.trim());
  };
  const cancel = (): void => {
    shelfAdding = false;
    renderShelfList();
  };
  const ok = document.createElement('button');
  ok.className = 'find-shelf-ok';
  ok.textContent = '✓';
  ok.onclick = confirm;
  const no = document.createElement('button');
  no.className = 'find-shelf-cancel';
  no.textContent = '✕';
  no.onclick = cancel;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    else if (e.key === 'Escape') cancel();
  });
  wrap.append(input, ok, no);
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return wrap;
}

async function createNamedShelf(name: string): Promise<void> {
  const sh = await client.createShelf({ name, kind: shelfTab }).catch(() => null);
  shelfAdding = false;
  if (!sh) return;
  shelves.push(sh);
  await switchShelf(sh.id, false); // keep the Find bar open after creating
}

/** Promote a playlist (case) to its own persistent single-playlist song shelf,
    then switch the wall to it. Reuses an existing same-named playlist shelf. */
async function openAsSongShelf(playlistMediaId: string, name: string): Promise<void> {
  const existing = shelves.find((s) => s.kind === 'playlist' && s.id !== 'playlists' && s.name === name);
  if (existing) {
    closeAlbum();
    await switchShelf(existing.id);
    return;
  }
  const sh = await client.createShelf({ name, kind: 'playlist' }).catch(() => null);
  if (!sh) {
    showToast('Could not create shelf');
    return;
  }
  await client.addAlbumToShelf(sh.id, playlistMediaId).catch(() => {});
  shelves.push(sh);
  closeAlbum();
  await switchShelf(sh.id);
}

/** Populate the opened card's ⋯ popover, per media kind:
    - album: "Add to shelf" list + "Add to queue" + Remove
    - playlist case: "Open as shelf" + "Add to queue" + Remove
    - playlist song: "Add to queue" + Remove
    - radio / podcast / audiobook: Remove only (radio never ends; spoken-word is resume-based). */
function renderCardMenu(pop: HTMLElement, a: ShelfItem): void {
  pop.innerHTML = '';
  const enqueueUri = a.albumUri ?? a.providerUri; // song → its track uri; else the album/playlist uri
  if (a.kind === 'album') {
    const lbl = document.createElement('div');
    lbl.className = 'panel-pop-label';
    lbl.textContent = 'Add to shelf';
    pop.appendChild(lbl);
    const list = document.createElement('div');
    list.className = 'panel-add-shelves';
    pop.appendChild(list);
    renderAddShelves(list, a.albumId);
  } else if (a.kind === 'playlist' && !a.albumUri) {
    const open = document.createElement('button');
    open.className = 'panel-shelf-add';
    open.textContent = 'Open as shelf';
    open.onclick = (e) => {
      e.stopPropagation();
      pop.hidden = true;
      void openAsSongShelf(a.albumId, a.title);
    };
    pop.appendChild(open);
  }
  if ((a.kind === 'album' || a.kind === 'playlist') && enqueueUri) {
    const q = document.createElement('button');
    q.className = 'panel-shelf-add';
    q.textContent = 'Add to queue';
    q.onclick = (e) => {
      e.stopPropagation();
      const pid = now.playerId ?? activePlayerId;
      if (!pid) {
        showToast('Nothing playing to queue behind');
        return;
      }
      q.disabled = true;
      q.textContent = 'Added to queue ✓';
      void client.queueEnqueue(pid, enqueueUri).catch(() => {
        q.disabled = false;
        q.textContent = 'Add to queue';
        showToast('Could not add to queue');
      });
    };
    pop.appendChild(q);
  }
  // Remove — every kind. Two-tap to arm so it can't fire by accident on a wall.
  const rm = document.createElement('button');
  rm.className = 'panel-remove';
  rm.textContent = 'Remove from shelf';
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  rm.onclick = (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      rm.textContent = 'Tap again to remove';
      rm.classList.add('armed');
      timer = setTimeout(() => {
        armed = false;
        rm.textContent = 'Remove from shelf';
        rm.classList.remove('armed');
      }, 3000);
      return;
    }
    if (timer) clearTimeout(timer);
    void client
      .removeFromShelf(a.albumId)
      .then(() => showToast('Removed'))
      .catch(() => showToast('Remove failed'));
  };
  pop.appendChild(rm);
}

/** Populate the card ⋯ menu's "Add to shelf" list for one album. */
function renderAddShelves(container: HTMLElement, albumId: string): void {
  container.innerHTML = '';
  const targets = shelves.filter((s) => s.kind === 'album' && s.id !== 'all');
  if (!targets.length) {
    container.innerHTML = '<div class="panel-pop-empty">No shelves yet — make one from the bottom bar</div>';
    return;
  }
  for (const s of targets) {
    const b = document.createElement('button');
    b.className = 'panel-shelf-add';
    b.textContent = s.name;
    b.onclick = () => {
      b.disabled = true;
      b.textContent = `${s.name} ✓`;
      void client.addAlbumToShelf(s.id, albumId).catch(() => {
        b.disabled = false;
        b.textContent = s.name;
      });
    };
    container.appendChild(b);
  }
}

/* ---- System rows: brightness, display sleep, IP + restart/reboot (§6/§7) ---- */
const dimEl = document.getElementById('dim') as HTMLElement;
const sleepEl = document.getElementById('sleep') as HTMLElement;
const ccBrightness = document.getElementById('cc-brightness') as HTMLInputElement;
const idleDimSlider = document.getElementById('idle-dim-slider') as HTMLInputElement | null;
const idleDimVal = document.getElementById('idle-dim-val');
const ccIp = document.getElementById('cc-ip') as HTMLElement;
const ccVer = document.getElementById('cc-ver') as HTMLElement;
const ccRestart = document.getElementById('cc-restart') as HTMLButtonElement;
const ccReboot = document.getElementById('cc-reboot') as HTMLButtonElement;
const ccResetAuth = document.getElementById('cc-reset-auth') as HTMLButtonElement;
let system: SystemStatus | null = null;

/** Software-dim veil opacity from the current brightness (hardware methods dim
    the real panel instead, so the veil stays clear). */
function applyDim(): void {
  const level = system?.brightness ?? 100;
  const soft = system?.brightnessMethod === 'software';
  dimEl.style.opacity = soft ? String(((100 - level) / 100) * 0.85) : '0';
}
function applySystemStatus(s: SystemStatus): void {
  system = s;
  applyDim();
  ccBrightness.value = String(s.brightness);
  sleepEl.classList.toggle('on', s.displayAsleep);
  ccIp.textContent = s.ip ?? 'offline';
  ccVer.textContent = `v${s.version}`;
  ccRestart.disabled = !s.appliance;
  ccReboot.disabled = !s.appliance;
  const onlyOnDevice = s.appliance ? '' : 'Only on the device';
  ccRestart.title = onlyOnDevice;
  ccReboot.title = onlyOnDevice;
}
function refreshSystem(): void {
  void client.getSystemStatus().then(applySystemStatus).catch(() => {});
  refreshServices();
  // Offer the "Reset admin login" recovery only when a lock is actually set.
  void client
    .getAuthStatus()
    .then((a) => {
      ccResetAuth.hidden = !a.enabled;
    })
    .catch(() => {});
}

// Service status — the three apps (Server / Shelf / Admin) + Music Assistant.
const wallServicesEl = document.getElementById('wall-services');
function renderWallServices(list: ServiceHealth[]): void {
  if (!wallServicesEl) return;
  wallServicesEl.innerHTML = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'svc-row';
    row.innerHTML =
      `<span class="svc-dot ${s.online ? 'up' : 'down'}"></span>` +
      `<span class="svc-name">${escapeHtml(s.name)}</span>` +
      `<span class="svc-detail">${escapeHtml(s.detail ?? '')}</span>`;
    if (s.restartable) {
      // Restarting the app you're on (Shelf, here) reloads this screen; another app is remote.
      const reconnect = s.id === 'musicAssistant';
      const btn = document.createElement('button');
      btn.className = 'svc-restart';
      btn.textContent = '↻';
      btn.setAttribute('aria-label', reconnect ? 'Reconnect Music Assistant' : `Restart ${s.name}`);
      btn.addEventListener('click', () => {
        btn.disabled = true;
        void client
          .restartService(s.id)
          .then((r) => showToast(r.ok ? (reconnect ? 'Reconnecting…' : `Restarting ${s.name}…`) : 'Not available'))
          .catch(() => showToast('Failed'))
          .finally(() => setTimeout(() => (btn.disabled = false), 1500));
      });
      row.appendChild(btn);
    }
    wallServicesEl.appendChild(row);
  }
}
function refreshServices(): void {
  void client.getServices().then((r) => renderWallServices(r.services)).catch(() => {});
}

// Brightness: dim live while dragging, persist (and drive hardware) on release.
ccBrightness.addEventListener('input', () => {
  if (system) {
    system.brightness = +ccBrightness.value;
    applyDim();
  }
});
ccBrightness.addEventListener('change', () => {
  const v = +ccBrightness.value;
  // A brightness the user sets by hand is their new "normal" — and it's intentional, so it
  // clears any idle-dim flag (never treat a deliberate low level as a dim to auto-restore).
  localStorage.setItem(NORMAL_BRIGHTNESS_KEY, String(v));
  localStorage.removeItem(IDLE_DIMMED_KEY);
  void client.setBrightness(v).then(applySystemStatus).catch(() => {});
});

// Idle dim brightness slider (Idle & sleep tab). Preview the dim veil live while
// dragging — #dim sits above #settings, so the whole sheet darkens to show the
// chosen level — then restore the real brightness and persist on release.
idleDimSlider?.addEventListener('input', () => {
  const v = +idleDimSlider.value;
  if (idleDimVal) idleDimVal.textContent = `${v}%`;
  dimEl.style.opacity = String(((100 - v) / 100) * 0.85);
});
idleDimSlider?.addEventListener('change', () => {
  settings.idleDimPercent = +idleDimSlider.value;
  applyDim(); // drop the preview veil back to the live brightness
  void client.putSettings({ idleDimPercent: settings.idleDimPercent }).catch(() => {});
});

// Display sleep: black veil, tap anywhere to wake.
(document.getElementById('cc-sleep') as HTMLElement).addEventListener('click', () => {
  sleepEl.classList.add('on');
  closeCC();
  void client.setDisplaySleep(true).catch(() => {});
});
sleepEl.addEventListener('click', () => {
  sleepEl.classList.remove('on');
  void client.setDisplaySleep(false).catch(() => {});
});

// System actions.
(document.getElementById('cc-refresh') as HTMLElement).addEventListener('click', () => {
  void client.refreshArtwork().catch(() => {});
  showToast('Refreshing artwork…');
});
ccRestart.addEventListener('click', () => {
  if (ccRestart.disabled) return;
  void client.restartApp().catch(() => {});
  showToast('Restarting…');
});
ccReboot.addEventListener('click', () => {
  if (ccReboot.disabled) return;
  void client.reboot().catch(() => {});
  showToast('Rebooting…');
});
// "Reset admin login" (forgot-passphrase recovery). Two-tap confirm — the first tap arms it,
// a second within the window clears the lock. Only shown when a lock is set (refreshSystem).
let resetAuthArmed = false;
let resetAuthTimer: ReturnType<typeof setTimeout> | undefined;
function disarmResetAuth(): void {
  resetAuthArmed = false;
  ccResetAuth.textContent = 'Reset admin login';
  ccResetAuth.classList.remove('arm');
  if (resetAuthTimer) clearTimeout(resetAuthTimer);
}
ccResetAuth.addEventListener('click', () => {
  if (!resetAuthArmed) {
    resetAuthArmed = true;
    ccResetAuth.textContent = 'Tap again to confirm';
    ccResetAuth.classList.add('arm');
    resetAuthTimer = setTimeout(disarmResetAuth, 4000);
    return;
  }
  disarmResetAuth();
  void client
    .resetAuth()
    .then(() => {
      ccResetAuth.hidden = true;
      showToast('Admin login cleared — set a new passphrase in the admin app');
    })
    .catch(() => showToast('Could not reset admin login'));
});

/* =====================================================================
   Gesture engine (verbatim from the prototype — do not rework)
   - nothing open + drag  → scroll the shelf (with momentum)
   - quick tap            → flip album out / flip the open one closed
   - hold                 → flip out under the finger
   - anything open + drag → step through albums, shelf glides along
   ===================================================================== */
const vp = document.getElementById('shelf-viewport') as HTMLElement;
/** Finger-travel per stepped album while dragging an open album. Adaptive so ONE full-width
    drag sweeps the ENTIRE shelf: from a centered album, dragging to a screen edge lands on the
    far end. Floored so huge shelves don't get hyper-twitchy (edge-hold covers their overflow),
    capped so tiny shelves keep a comfortable throw. */
function stepPx(): number {
  return Math.min(110, Math.max(12, window.innerWidth / Math.max(1, items.length)));
}
let pDown = false,
  moved = false,
  startX = 0,
  lastX = 0,
  scrollStart = 0;
let vel = 0,
  raf: number | null = null,
  holdTimer: ReturnType<typeof setTimeout> | null = null,
  downTarget: HTMLElement | null = null;
let stepping = false,
  stepAccum = 0,
  heldOpen = false; // this gesture opened an album via hold-to-open (release should keep it open)
// Vertical swipe on the open cover: expand (up) / collapse or close (down). vSwipe:
// 0 = undetermined, 1 = locked vertical, -1 = locked horizontal (stepping).
let startY = 0,
  vSwipe = 0,
  vSwipeDone = false,
  downOnOpenCover = false,
  // Swipe-up on a CLOSED spine flips it open straight into the extended card view.
  openSwipeDone = false;

/* ---- Pinch to zoom (§ pinchZoom setting): spine-density resize OR a magnifier loupe.
   Tracks live pointers; two down => pinch, which suspends scroll/open for those fingers. */
type Pt = { x: number; y: number };
const pointers = new Map<number, Pt>();
let pinching = false;
let pinchStartDist = 1;
let pinchStartZoom = 1;
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function beginPinch(): void {
  pinching = true;
  // Cancel the single-finger scroll/hold that the first pointer started.
  pDown = false;
  moved = false;
  stepping = false;
  if (holdTimer) clearTimeout(holdTimer);
  if (raf !== null) cancelAnimationFrame(raf);
  const pts = [...pointers.values()];
  pinchStartDist = dist(pts[0]!, pts[1]!) || 1;
  pinchStartZoom = spineZoom;
  if (settings.pinchZoom === 'loupe') showLoupe(midpoint(pts[0]!, pts[1]!));
}
function updatePinch(): void {
  const pts = [...pointers.values()];
  if (pts.length < 2) return;
  const mid = midpoint(pts[0]!, pts[1]!);
  if (settings.pinchZoom === 'loupe') {
    moveLoupe(mid);
    return;
  }
  const ratio = dist(pts[0]!, pts[1]!) / pinchStartDist;
  spineZoom = Math.max(SPINE_ZOOM_MIN, Math.min(SPINE_ZOOM_MAX, pinchStartZoom * ratio));
  sizeFaces();
}
function endPinch(): void {
  pinching = false;
  hideLoupe();
}

// --- Magnifier loupe: a circular window onto a magnified clone of the shelf ---
const loupe = document.createElement('div');
loupe.id = 'loupe';
loupe.hidden = true;
const loupeRing = document.createElement('div');
loupeRing.id = 'loupe-ring';
loupeRing.hidden = true;
document.body.append(loupe, loupeRing);
const LOUPE_MAG = 2.2;
const loupeD = (): number => window.innerHeight * 0.42;
let loupeClone: HTMLElement | null = null;

function showLoupe(p: Pt): void {
  const r = vp.getBoundingClientRect();
  const clone = vp.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.style.cssText = `position:fixed; left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px; margin:0; overflow:hidden; pointer-events:none;`;
  loupe.innerHTML = '';
  loupe.appendChild(clone);
  clone.scrollLeft = vp.scrollLeft;
  loupeClone = clone;
  loupe.hidden = false;
  loupeRing.hidden = false;
  moveLoupe(p);
}
function moveLoupe(p: Pt): void {
  if (!loupeClone) return;
  const r = vp.getBoundingClientRect();
  loupeClone.scrollLeft = vp.scrollLeft;
  loupeClone.style.transformOrigin = `${p.x - r.left}px ${p.y - r.top}px`;
  loupeClone.style.transform = `scale(${LOUPE_MAG})`;
  const d = loupeD();
  loupe.style.clipPath = `circle(${d / 2}px at ${p.x}px ${p.y}px)`;
  loupeRing.style.cssText = `left:${p.x - d / 2}px; top:${p.y - d / 2}px; width:${d}px; height:${d}px;`;
}
function hideLoupe(): void {
  loupe.hidden = true;
  loupeRing.hidden = true;
  loupe.innerHTML = '';
  loupeClone = null;
}

function followOpen(): void {
  if (openIdx === null) return;
  // Track the stepped album to ~12% from the left with NO animation. During a drag (and
  // especially an edge-hold) steps arrive fast; a smooth glide can't keep up on a full shelf
  // and lags several albums behind, which reads as sluggish. The discrete step IS the motion.
  vp.scrollLeft = settledLeft(openIdx) - vp.clientWidth * 0.12;
}

function stepAlbum(dir: number): void {
  if (openIdx === null) return;
  const next = Math.min(Math.max(openIdx + dir, 0), items.length - 1);
  if (next === openIdx) return;
  openAlbum(next, false);
  followOpen();
}

// Edge-hold auto-stepping. On a full shelf a single drag runs out of screen before you reach
// the end. While an album is open and the finger rests near a screen edge, keep stepping in
// that direction so the whole shelf is reachable without lifting — faster the closer to the
// very edge. The left edge steps forward (+1), the right edge back (-1): the same direction
// the drag was already carrying (drag left = content moves left = step forward).
let edgeDir = 0,
  edgeRaf: number | null = null,
  edgeLast = 0,
  edgeCadence = 90;
function edgeLoop(t: number): void {
  if (edgeDir === 0) {
    edgeRaf = null;
    return;
  }
  if (t - edgeLast >= edgeCadence) {
    edgeLast = t;
    const before = openIdx;
    stepAlbum(edgeDir);
    if (openIdx === before) {
      edgeDir = 0; // hit an end of the shelf — stop
      edgeRaf = null;
      return;
    }
  }
  edgeRaf = requestAnimationFrame(edgeLoop);
}
function updateEdgeStep(clientX: number): void {
  const w = window.innerWidth;
  const zone = Math.max(140, w * 0.12);
  const dl = clientX,
    dr = w - clientX;
  let dir = 0,
    depth = 0;
  if (dl < zone) {
    dir = 1;
    depth = 1 - dl / zone;
  } else if (dr < zone) {
    dir = -1;
    depth = 1 - dr / zone;
  }
  if (dir === 0) {
    edgeDir = 0; // out of the edge zone — edgeLoop will self-stop
    return;
  }
  edgeCadence = 150 - depth * 110; // ~150ms/album at the zone's inner lip → ~40ms at the very edge
  if (edgeDir !== dir) {
    edgeDir = dir;
    edgeLast = 0; // entering the zone (or reversing) steps immediately
  }
  if (edgeRaf === null) edgeRaf = requestAnimationFrame(edgeLoop);
}
function stopEdgeStep(): void {
  edgeDir = 0;
  if (edgeRaf !== null) {
    cancelAnimationFrame(edgeRaf);
    edgeRaf = null;
  }
}

/** Which spine (by LAYOUT position) sits under this client X. Used for taps while
    an album is open: the open album's flipped-open cover visually overlaps its LEFT
    neighbors, so element hit-testing wrongly targets the open one — position is right. */
function spineAtX(x: number): number {
  for (let j = 0; j < items.length; j++) {
    const el = shelf.children[j] as HTMLElement | undefined;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x < r.right) return j;
  }
  return -1;
}

vp.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2 && settings.pinchZoom !== 'off') {
    beginPinch();
    return; // second finger drives the pinch, not scroll/open
  }
  pDown = true;
  moved = false;
  startX = lastX = e.clientX;
  startY = e.clientY;
  scrollStart = vp.scrollLeft;
  if (raf !== null) cancelAnimationFrame(raf);
  vel = 0;
  downTarget = (e.target as HTMLElement).closest('.spine');

  stepping = openIdx !== null;
  stepAccum = 0;
  heldOpen = false;
  stopEdgeStep(); // clear any lingering edge-hold from a previous gesture
  // A vertical drag that starts on the OPEN album's cover (not its panel, which scrolls)
  // toggles the extended view — a faster trigger than the ⋯ button.
  vSwipe = 0;
  vSwipeDone = false;
  openSwipeDone = false;
  // The open flap is rotated edge-on and its cover children are pointer-events:none, so a real
  // press lands on `.spine.open` itself — match that (minus the scrollable panel), not `.flap`.
  downOnOpenCover =
    openIdx !== null &&
    !!(e.target as HTMLElement).closest('.spine.open') &&
    !(e.target as HTMLElement).closest('.panel');

  if (downTarget && openIdx === null) {
    holdTimer = setTimeout(() => {
      if (!moved && pDown) {
        openAlbum(+downTarget!.dataset['idx']!);
        stepping = true;
        stepAccum = 0;
        lastX = startX;
        heldOpen = true; // so releasing this hold keeps the album open (doesn't tap-close it)
      }
    }, LONG_PRESS_MS);
  }
});

window.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinching) {
    updatePinch();
    return;
  }
  if (!pDown) return;

  if (stepping) {
    // Vertical swipe on the open cover → expand / collapse (once per gesture).
    if (downOnOpenCover && vSwipe >= 0) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (vSwipe === 0) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.3) vSwipe = 1;
        else if (Math.abs(dx) > 12) vSwipe = -1;
      }
      if (vSwipe === 1) {
        if (!vSwipeDone && Math.abs(dy) > 40 && openIdx !== null) {
          vSwipeDone = true;
          const el = shelf.children[openIdx] as HTMLElement;
          if (dy < 0) {
            if (!el.classList.contains('expanded')) expand(el, true); // up → expand
          } else if (el.classList.contains('expanded')) {
            expand(el, false); // down → collapse to cover
          } else {
            closeAlbum(); // down from cover → close
          }
        }
        return; // consumed as a vertical swipe, don't step
      }
    }
    stepAccum += e.clientX - lastX;
    lastX = e.clientX;
    const step = stepPx();
    while (stepAccum <= -step) {
      stepAlbum(1);
      stepAccum += step;
    }
    while (stepAccum >= step) {
      stepAlbum(-1);
      stepAccum -= step;
    }
    updateEdgeStep(e.clientX); // finger resting near a screen edge → keep stepping through the shelf
    return;
  }

  // Swipe UP on a CLOSED spine flips it open straight into the extended card view — a shortcut
  // past tap-to-open-then-⋯. Fires once; a mostly-horizontal drag falls through to scrolling.
  if (downTarget && openIdx === null && !openSwipeDone) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dy < -40 && Math.abs(dy) > Math.abs(dx) * 1.3) {
      openSwipeDone = true;
      if (holdTimer) clearTimeout(holdTimer);
      const idx = +downTarget.dataset['idx']!;
      openAlbum(idx, false);
      const el = shelf.children[idx] as HTMLElement | undefined;
      if (el && !el.classList.contains('expanded')) expand(el, true);
      return;
    }
  }
  if (openSwipeDone) return; // gesture consumed by the swipe-up-to-open above

  if (Math.abs(e.clientX - startX) > 8) {
    moved = true;
    if (holdTimer) clearTimeout(holdTimer);
  }
  vel = e.clientX - lastX;
  lastX = e.clientX;
  if (moved) vp.scrollLeft = scrollStart - (e.clientX - startX);
});

function releasePointer(e: PointerEvent): void {
  pointers.delete(e.pointerId);
  stopEdgeStep(); // lifting (or cancel) ends any edge-hold auto-stepping
  if (pinching && pointers.size < 2) {
    endPinch();
    pDown = false; // the remaining finger (if any) shouldn't resume scroll/tap
  }
}
window.addEventListener('pointercancel', releasePointer);

window.addEventListener('pointerup', (e) => {
  const wasPinching = pinching;
  releasePointer(e);
  if (wasPinching) return; // a pinch finger lifting isn't a tap
  if (!pDown) return;
  pDown = false;
  if (holdTimer) clearTimeout(holdTimer);
  if (openSwipeDone) return; // swipe-up already opened + expanded this spine — not a tap

  if (stepping) {
    stepping = false;
    if (vSwipe === 1) return; // a vertical swipe already expanded/collapsed — not a tap
    if (heldOpen) {
      heldOpen = false;
      return; // hold-to-open: lifting the finger keeps the album open, never tap-closes it
    }
    if (Math.abs(e.clientX - startX) <= 8 && Math.abs(e.clientY - startY) <= 8) {
      // A tap closes the open album — on empty space (no spine under the finger) or on
      // the open album itself; tapping a DIFFERENT spine opens that one instead.
      // (Resolve by layout position so a LEFT neighbor isn't masked by the open cover.)
      const j = downTarget ? spineAtX(e.clientX) : -1;
      if (j < 0 || j === openIdx) closeAlbum();
      else openAlbum(j);
    }
    return;
  }

  if (moved) {
    (function glide() {
      vp.scrollLeft -= vel;
      vel *= 0.94;
      if (Math.abs(vel) > 0.4) raf = requestAnimationFrame(glide);
    })();
    return;
  }

  if (!downTarget) return;
  openAlbum(+downTarget.dataset['idx']!);
});

/* ---------- Live state (WebSocket) ---------- */
let lastStates: PlayerState[] = [];

function handleState(states: PlayerState[]): void {
  lastStates = states;
  // Hold a just-applied grouping through stale MA frames (else it flashes apart
  // then back); after the guard window, let the real state stand (fallback).
  if (groupOverride) {
    if (performance.now() < groupGuardUntil) {
      for (const [pid, leader] of groupOverride) setLeaderLocal(pid, leader);
    } else {
      groupOverride = null;
    }
  }
  // Volume of the active player → open slider.
  const active = states.find((s) => s.playerId === activePlayerId);
  if (active && active.volume !== null) {
    volume = active.volume;
    if (openIdx !== null) syncVol((shelf.children[openIdx] as HTMLElement).querySelector('.vol'));
    if (!albumModal.hidden) syncVol(albumModal.querySelector('.am-vol'));
  }
  // Any room's external volume change (Sonos app / hardware) → the control center sliders.
  syncCCVolumes();
  // `now` is the FOCUSED now-playing that drives the open card: prefer the player
  // playing/paused the OPEN album (so its card shows real controls even when other
  // rooms play other albums), else any playing/paused player. Guards drop this
  // player's not-yet-propagated frames after a user pause/resume; album identity
  // is sticky; a user pause is held even if MA reports the queue as idle.
  const t = performance.now();
  const pauseGuard = t < pauseGuardUntil;
  const resumeGuard = t < resumeGuardUntil;
  let pool = states;
  if (pauseGuard) pool = pool.filter((s) => !(s.playerId === now.playerId && s.state === 'playing'));
  if (resumeGuard) pool = pool.filter((s) => !(s.playerId === now.playerId && s.state !== 'playing'));

  const openAlbumId = openIdx !== null ? (items[openIdx]?.albumId ?? null) : null;
  // Don't let another room steal the now-playing focus while (a) the user paused an
  // album here, or (b) we just hit play and its queue is still loading — keep `now` on
  // our album/player until its own frames arrive instead of jumping to another room.
  // Defined up front so it can gate the candidates below.
  const holdFocus = (userPaused || resumeGuard) && !!now.albumId;
  const onOpenAlbum = (s: PlayerState) =>
    (s.state === 'playing' || s.state === 'paused') && !!s.nowPlaying && s.nowPlaying.albumId === openAlbumId;
  // A tapped room (focusedPlayerId) wins, so the hero follows the room you picked.
  const forFocus = focusedPlayerId
    ? pool.find((s) => s.playerId === focusedPlayerId && (s.state === 'playing' || s.state === 'paused') && s.nowPlaying)
    : undefined;
  // The open album playing on some room. Prefer the CURRENT player so a second room on
  // the same album can't hijack the card; during a hold ONLY the current player qualifies
  // (else, when the focused room's frame is briefly filtered by the pause/resume guards,
  // the card flip-flopped to the other room's track/seek/eyebrow).
  const forOpen = openAlbumId
    ? (pool.find((s) => onOpenAlbum(s) && s.playerId === now.playerId) ?? (holdFocus ? undefined : pool.find(onOpenAlbum)))
    : undefined;
  // The play-now overlay has no shelf index, so anchor `now` to its album by URI (off-shelf
  // frames carry albumUri, not a crate albumId) — the overlay's equivalent of forOpen, so
  // external pause/track changes on that album reflect in the overlay too.
  const modalUri = !albumModal.hidden && !modalIsPlaylist ? modalAlbumUri : null;
  const onModalAlbum = (s: PlayerState) =>
    (s.state === 'playing' || s.state === 'paused') && !!s.nowPlaying && s.nowPlaying.albumUri === modalUri;
  const forModal = modalUri
    ? (pool.find((s) => onModalAlbum(s) && s.playerId === now.playerId) ?? (holdFocus ? undefined : pool.find(onModalAlbum)))
    : undefined;
  const playingS =
    pool.find((s) => s.state === 'playing' && s.nowPlaying?.albumId) ??
    pool.find((s) => s.state === 'playing' && s.nowPlaying);
  const pausedS =
    pool.find((s) => s.state === 'paused' && s.nowPlaying?.albumId) ??
    pool.find((s) => s.state === 'paused' && s.nowPlaying);
  const cand = forFocus ?? forOpen ?? forModal ?? (holdFocus ? undefined : (playingS ?? pausedS));
  if (cand?.nowPlaying) {
    const st = cand.state === 'playing' ? 'playing' : 'paused';
    if (st === 'playing') userPaused = false;
    const samePlayer = cand.playerId === now.playerId;
    // Once the player we're tracking actually reports playing, the just-played/resume hold
    // has done its job — release the resume guard so a later EXTERNAL pause (Sonos app)
    // isn't filtered out and shows up in the controls right away.
    if (samePlayer && st === 'playing') resumeGuardUntil = 0;
    const nextAlbumId = cand.nowPlaying.albumId ?? (samePlayer ? now.albumId : null);
    const nextTrackIndex = cand.nowPlaying.trackIndex ?? (samePlayer ? now.trackIndex : 0);
    let nextElapsed = cand.nowPlaying.elapsed ?? now.elapsed;
    // Hold the seek bar steady during a resume: MA can replay a stale position for a
    // frame as the queue re-initializes — either behind (snap back) or ahead (snap
    // forward) of where we resumed — before settling on the real position. Right after a
    // resume we KNOW the position (it continues from the pause point), so within the SAME
    // track ignore any frame that deviates far from our interpolated position and keep
    // interpolating; normal per-tick progress (~1s) is well within tolerance. A real jump
    // (seek) already set now.elapsed itself, so it reads as ~0 deviation and is kept.
    // (Track changes reset trackIndex → sameTrack false → guard skipped.)
    const sameTrack = samePlayer && nextAlbumId === now.albumId && nextTrackIndex === now.trackIndex;
    if (resumeGuard && sameTrack && st === 'playing' && Math.abs(nextElapsed - liveElapsed()) > 8) nextElapsed = liveElapsed();
    now = {
      playerId: cand.playerId,
      albumId: nextAlbumId,
      trackIndex: nextTrackIndex,
      trackUri: cand.nowPlaying.trackUri ?? (samePlayer ? now.trackUri : null),
      elapsed: nextElapsed,
      duration: cand.nowPlaying.duration ?? (samePlayer ? now.duration : 0),
      state: st,
      mediaKind: cand.nowPlaying.mediaKind ?? (samePlayer ? now.mediaKind : null),
      at: performance.now(),
    };
  } else if (resumeGuard && now.albumId) {
    now = { ...now, state: 'playing' }; // resume not propagated yet — keep playing
  } else if (userPaused && now.albumId) {
    now = { ...now, state: 'paused' };
  } else {
    now = { ...now, state: 'idle' };
  }
  applyNow();
  // Reflect real grouping changes live (confirms optimistic updates, or reverts
  // if a group/ungroup didn't take) — without re-rendering on volume/progress frames.
  // Re-render the room grid on group changes (confirm/revert optimistic grouping)
  // OR when the set of *playing* rooms changes (keep the EQ / bold markers live).
  const sig = groupSig();
  // Include paused rooms and encode the state so play→pause and pause→idle both
  // re-render the pickers (a paused room shows a frozen EQ; when it stops, clear it).
  const psig = lastStates
    .filter((s) => (s.state === 'playing' || s.state === 'paused') && s.nowPlaying)
    .map((s) => `${s.state}:${s.playerId}`)
    .sort()
    .join(',');
  if (sig !== lastGroupSig || psig !== lastPlayingSig) {
    lastGroupSig = sig;
    lastPlayingSig = psig;
    if (ccIsOpen()) renderCCRooms();
    // Re-render the pickers on group OR playing changes so the play-state markers
    // (EQ / dot) and group chips stay live in the album card and the play-now overlay.
    if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
    if (!albumModal.hidden) renderRooms(albumModal.querySelector('.am-card') as HTMLElement);
  }
  maybeAfterAlbum();
  maybeFollowPlaylistSong();
  maybeAutoOpenExternal();
}

/** When the album we started finishes (no longer playing/paused anywhere), act on the
    afterAlbum setting: 'repeat' loops via the queue (nothing to do); 'stop' returns to
    the shelf; 'next' plays the next spine on this shelf AND opens its card. */
function maybeAfterAlbum(): void {
  const w = afterAlbumWatch;
  if (!w || userPaused || settings.afterAlbum === 'repeat') return;
  if (performance.now() < selfPlayUntil) return; // ignore transient idle during the queue load
  const stillOn = lastStates.some((s) => (s.state === 'playing' || s.state === 'paused') && s.nowPlaying?.albumId === w.albumId);
  if (stillOn) return;
  // The album stopped on its own (a user pause is excluded above; a new play would have
  // reset the watch).
  afterAlbumWatch = null;
  const endedIsOpen = openCardAlbumId() === w.albumId;
  if (settings.afterAlbum === 'stop') {
    if (endedIsOpen) closeAlbum(); // return to the shelf
    return;
  }
  // 'next' → advance to the next non-hidden spine on this shelf and open its card.
  const idx = items.findIndex((it) => it.albumId === w.albumId);
  if (idx < 0) return;
  for (let j = idx + 1; j < items.length; j++) {
    const nextItem = items[j];
    if (nextItem && matchesFilter(nextItem)) {
      if (w.playerId) {
        activePlayerId = w.playerId;
        activeSolo = groupMembers(leaderOf(w.playerId)).length < 2;
      }
      openAlbum(j); // follow playback: show the next album's card with controls
      void play(j, undefined, { autoAdvance: true });
      return;
    }
  }
  // Reached the end of the shelf — nothing more to play; drop back to the shelf.
  if (endedIsOpen) closeAlbum();
}

let followedTrackUri: string | null = null;
/** Follow a playing playlist through the queue: when the now-playing track advances to a
    different song spine on the current shelf, open that spine so its card + controls show
    the song that's actually playing (playlists advance on the MA queue, not afterAlbum). */
function maybeFollowPlaylistSong(): void {
  if (now.state === 'idle' || !now.trackUri) {
    followedTrackUri = null;
    return;
  }
  if (openIdx === null) return;
  const open = items[openIdx];
  if (!open || open.kind !== 'playlist' || !open.albumUri) return; // only while a playlist-song card is open
  if (now.trackUri === open.albumUri) {
    followedTrackUri = now.trackUri; // already showing the playing song
    return;
  }
  if (now.trackUri === followedTrackUri) return; // this advance already handled
  const j = items.findIndex((it) => it.kind === 'playlist' && it.albumUri === now.trackUri);
  if (j >= 0 && j !== openIdx) {
    followedTrackUri = now.trackUri;
    openAlbum(j); // the card follows the playlist to the now-playing song
  }
}

/** "Open on outside playback" (opt-in setting): when a NEW album starts playing that Crate
    didn't start itself, flip it open — but never during the sleep window, and not while the
    wall is in active use. Waking from idle-dim is fine (it restores brightness); after that
    the normal idle timer runs, so it re-idles on its own. */
function maybeAutoOpenExternal(): void {
  const albumId = now.state === 'idle' ? null : now.albumId;
  const isNewAlbum = !!albumId && albumId !== lastNowAlbumId;
  lastNowAlbumId = albumId; // always track the current album
  if (!firstStateSeen) {
    firstStateSeen = true; // seed on boot — don't open whatever was already playing at load
    return;
  }
  if (!settings.openOnExternalPlay || !isNewAlbum) return;
  if (performance.now() < selfPlayUntil) return; // Crate started it — the card already reacts
  if (inSleepWindow()) return; // respect sleep — never wake or open
  if (performance.now() - lastTouchAt < AUTO_OPEN_TOUCH_GRACE_MS) return; // don't interrupt active use
  if (openIdx !== null && items[openIdx]?.albumId === albumId) return; // already showing it
  if (isIdle || screenIsOff) {
    exitIdle(); // wake from idle-dim / screen-off (restore brightness, power on)…
    restartIdleWatch(); // …and let it re-idle after idleAfterMin
  }
  openNowPlaying();
}

/** True during the window after a fresh play() where our optimistic "playing" state
    hasn't yet been confirmed by a real frame from the target room. In that window the
    just-played album shows a spinner instead of the EQ, so a slow queue-load reads as
    "connecting" rather than a dead/instant EQ. Capped by the play latch. */
function playBuffering(): boolean {
  // Buffer either an on-shelf spine (playPendingIdx) or an off-shelf play-now overlay
  // (playPendingUri/Album only, no spine) — both show the connecting spinner until audio starts.
  if ((playPendingIdx < 0 && !playPendingUri && !playPendingAlbum) || userPaused || performance.now() >= playPendingUntil) return false;
  // Confirm the target room is really playing what we asked for so the spinner/frozen seek clears
  // the moment audio starts instead of riding the full latch. Playback frames carry albumUri/
  // trackUri (not the Crate albumId); match those, and fall back to the album NAME because MA may
  // report a different uri than we sent (e.g. a catalog album normalized to a library uri).
  const album = playPendingAlbum?.toLowerCase();
  const confirmed = lastStates.some(
    (s) =>
      s.state === 'playing' &&
      (!now.playerId || s.playerId === now.playerId) &&
      ((!!playPendingUri && (s.nowPlaying?.albumUri === playPendingUri || s.nowPlaying?.trackUri === playPendingUri)) ||
        (!!album && s.nowPlaying?.album?.toLowerCase() === album)),
  );
  return !confirmed;
}

/** EQ every album that's playing on any player (multi-room), plus an optimistic
    just-played album. Independent of the open card's focused `now`. */
function markPlayingSpines(): void {
  const playing = new Set<string>();
  for (const s of lastStates) if (s.state === 'playing' && s.nowPlaying?.albumId) playing.add(s.nowPlaying.albumId);
  if (now.state === 'playing' && now.albumId) playing.add(now.albumId);
  const bufIdx = playBuffering() ? playPendingIdx : -1;
  items.forEach((it, i) => {
    const el = shelf.children[i] as HTMLElement | undefined;
    if (!el) return;
    el.classList.toggle('playing', playing.has(it.albumId));
    el.classList.toggle('buffering', i === bufIdx);
  });
}

/** Align every equalizer's animation to a shared origin so the picker chips, track
    list and spines pulse in unison (each otherwise starts when its element renders). */
function syncEqs(): void {
  requestAnimationFrame(() => {
    const paused = document.body.classList.contains('nowpaused');
    document.querySelectorAll('.track-eq i, .eq i').forEach((el) => {
      // The nowpaused freeze reflects the FOCUSED album being paused — but the CC room list
      // EQs and the spine EQs are per-source live indicators (only shown for rooms/albums
      // that are actually playing), so they must keep animating even when another, paused
      // room is focused. Only freeze the EQs tied to the focused context (card/modal rows).
      const live = !!(el as HTMLElement).closest('#cc-rooms, .eq');
      for (const a of (el as HTMLElement).getAnimations()) {
        try {
          if (paused && !live) {
            a.pause(); // frozen while the focused album is paused
          } else {
            a.play();
            a.startTime = 0; // common timeline origin → same phase (per-bar delays preserved)
          }
        } catch {
          /* animation not ready yet */
        }
      }
    });
  });
}

function applyNow(): void {
  const idx = now.albumId ? items.findIndex((it) => it.albumId === now.albumId) : -1;
  const loaded = idx >= 0 && now.state !== 'idle';
  playingIdx = loaded ? idx : null;
  document.body.classList.toggle('nowpaused', now.state === 'paused'); // freeze EQ bars
  markPlayingSpines();
  if (openIdx !== null) {
    updateOpenTrackIndicator();
    updateNowbar();
    updatePlayButton();
    renderCardModes(); // keep shuffle/repeat in sync with the live queue
  }
  if (!albumModal.hidden) {
    updateModalTransport();
    updateModalNowTrack();
    updateModalNowbar();
  }
  renderCCNow();
  syncEqs();
}

function updatePlayButton(): void {
  if (openIdx === null) return;
  const panel = shelf.children[openIdx] as HTMLElement;
  const btn = panel.querySelector('.play') as HTMLButtonElement | null;
  const eyebrow = panel.querySelector('.eyebrow') as HTMLElement | null;
  const prev = panel.querySelector('.np-prev') as HTMLElement | null;
  const next = panel.querySelector('.np-next') as HTMLElement | null;
  const back10 = panel.querySelector('.card-back10') as HTMLElement | null;
  const fwd10 = panel.querySelector('.card-fwd10') as HTMLElement | null;
  const isThis = playingIdx === openIdx; // this album is the focused now-playing
  // Hold the just-played album as "playing" through its queue-load window — the
  // now-state churns in and out of "settled" during the load, so we ride the timer
  // rather than clearing on the first (flickery) settle.
  const pending = openIdx === playPendingIdx && performance.now() < playPendingUntil;
  // Pause/Resume when this album plays and nothing's changed (or during the load latch);
  // otherwise it's the "play my selection" trigger (a different room or track).
  const transport = pending || (isThis && !selectionChanged(openIdx));
  if (btn) {
    btn.hidden = false;
    // While the latch rides the queue-load churn, keep showing "Pause" — UNLESS the
    // user explicitly paused (userPaused), which must flip to "Resume" immediately.
    const showPause = now.state === 'playing' || (pending && !userPaused);
    btn.textContent = transport ? (showPause ? 'Pause' : 'Resume') : 'Play';
    btn.classList.toggle('compact', transport); // shrink to make room for the flanking skips
  }
  // Skip ⏮/⏭ and the −10s/+10s spoken-word skips flank the button only while it's the
  // live play/pause control (i.e. the stream has actually started).
  if (prev) prev.hidden = !transport;
  if (next) next.hidden = !transport;
  if (back10) back10.hidden = !transport;
  if (fwd10) fwd10.hidden = !transport;
  // Eyebrow shows the current SONG while this album plays (its track list is right
  // below), else the album context.
  const np = lastStates.find((s) => s.playerId === now.playerId)?.nowPlaying;
  const song = (isThis || pending) && np?.title ? np.title : null;
  if (eyebrow) eyebrow.textContent = song ?? (isThis || pending ? 'Now playing' : 'From your library');
}

function updateOpenTrackIndicator(): void {
  if (openIdx === null) return;
  const panel = shelf.children[openIdx] as HTMLElement;
  const buffering = playBuffering();
  panel.querySelectorAll('.track').forEach((row, ti) => {
    const isNow = playingIdx === openIdx && isNowTrack((row as HTMLElement).dataset.uri, ti);
    row.classList.toggle('now', isNow);
    const n = row.querySelector('.n');
    if (n) n.innerHTML = isNow ? (buffering ? NOW_SPINNER : TRACK_EQ) : String(ti + 1);
  });
}

function liveElapsed(): number {
  // While a fresh play is still "connecting" (buffering), hold the position at 0 so the
  // seek bar doesn't tick up then snap back when real playback actually starts.
  if (playBuffering()) return 0;
  const e = now.state === 'playing' ? now.elapsed + (performance.now() - now.at) / 1000 : now.elapsed;
  return now.duration > 0 ? Math.min(e, now.duration) : e;
}

function updateNowbar(): void {
  if (openIdx === null) return;
  const panel = shelf.children[openIdx] as HTMLElement;
  const bar = panel.querySelector('.nowbar') as HTMLElement | null;
  if (!bar) return;
  const show = playingIdx === openIdx; // transport shows whenever this album is the one playing
  bar.hidden = !show;
  if (!show) return;
  if (now.duration > 0) {
    const e = liveElapsed();
    (bar.querySelector('.seek-fill') as HTMLElement).style.width = `${Math.min(100, (e / now.duration) * 100)}%`;
    (bar.querySelector('.cur') as HTMLElement).textContent = fmtDur(e);
    (bar.querySelector('.dur') as HTMLElement).textContent = '-' + fmtDur(Math.max(0, now.duration - e)); // time remaining
  }
}

/** Seek bar for the play-now overlay — mirrors the card's nowbar, shown while the
    overlay's album is the one playing. */
function updateModalNowbar(): void {
  if (albumModal.hidden) return;
  const bar = albumModal.querySelector('.am-nowbar') as HTMLElement | null;
  if (!bar) return;
  const show = modalIsPlaying();
  bar.hidden = !show;
  if (!show || now.duration <= 0) return;
  const e = liveElapsed();
  (bar.querySelector('.seek-fill') as HTMLElement).style.width = `${Math.min(100, (e / now.duration) * 100)}%`;
  (bar.querySelector('.cur') as HTMLElement).textContent = fmtDur(e);
  (bar.querySelector('.dur') as HTMLElement).textContent = '-' + fmtDur(Math.max(0, now.duration - e)); // time remaining
}

function handleProgress(playerId: string, elapsed: number): void {
  if (playerId !== now.playerId) return;
  // Ignore a stale tick that would snap the bar far from the resume position (see handleState).
  if (performance.now() < resumeGuardUntil && Math.abs(elapsed - liveElapsed()) > 8) return;
  now.elapsed = elapsed;
  now.at = performance.now();
  if (now.state === 'idle') now.state = 'playing';
}

/** The seek bar only advances while actually playing with a seek view visible. */
function needsSmoothTick(): boolean {
  return now.state === 'playing' && ((openIdx !== null && playingIdx === openIdx) || !albumModal.hidden || ccIsOpen());
}
function tick(): void {
  if (openIdx !== null && playingIdx === openIdx) updateNowbar();
  if (!albumModal.hidden) updateModalNowbar();
  if (ccIsOpen()) updateCCSeek();
  // Run at 60fps only while the bar is advancing; otherwise self-poll slowly so the wall's
  // browser can idle instead of a perpetual rAF (constant CPU/GPU wake on an always-on panel).
  // The loop never stops, so it resumes on its own within 500ms once playback begins.
  if (needsSmoothTick()) requestAnimationFrame(tick);
  else setTimeout(tick, 500);
}

function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?app=shelf`);
  ws.onopen = () => {
    // On (re)connect, pull current playback immediately — a client that connected
    // after playback started (e.g. another app began it) otherwise shows no EQ /
    // now-playing controls until the next broadcast.
    void client.getPlayers().then((r) => handleState(r.state)).catch(() => {});
  };
  ws.onmessage = (ev) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(ev.data as string) as WsMessage;
    } catch {
      return;
    }
    if (msg.type === 'state') {
      handleState(msg.state);
      if (queueOpen) {
        // Keep "Up Next" live: a room may have started/stopped (selector list) or changed track.
        if (!queueViewPlayer || !playingRooms().some((r) => r.id === queueViewPlayer)) queueViewPlayer = defaultQueuePlayer();
        renderQueueRoom();
        void refreshQueue();
      }
    }
    else if (msg.type === 'progress') handleProgress(msg.playerId, msg.elapsed);
    else if (msg.type === 'shelf' || msg.type === 'shelves') scheduleReloadShelf();
    else if (msg.type === 'players') void reloadPlayers();
    else if (msg.type === 'settings') applySettings(msg.settings);
    else if (msg.type === 'system') applySystemStatus(msg.status);
    else if (msg.type === 'reload' && msg.app === 'shelf') location.reload();
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

// The server emits `shelf` liberally (art + enrichment land per item), and each rebuilds the
// whole spine DOM. Coalesce a burst into one rebuild ~200ms after it settles.
let reloadShelfTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReloadShelf(): void {
  shelfItemsCache.clear(); // a shelf changed → the "On your shelf" search column may be stale
  clearTimeout(reloadShelfTimer);
  reloadShelfTimer = setTimeout(() => void reloadShelf(), 200);
}

async function reloadShelf(): Promise<void> {
  const tok = ++shelfLoadToken;
  const res = await client.getShelf(activeShelf === 'all' ? undefined : activeShelf);
  if (tok !== shelfLoadToken) return; // a newer load (e.g. a shelf switch) superseded this
  const openId = openIdx !== null ? (items[openIdx]?.albumId ?? null) : null;
  const prevScroll = vp.scrollLeft; // preserve horizontal scroll across the DOM rebuild
  items = res.items;
  shelves = res.shelves;
  sourceKinds = res.sourceKinds;
  updateMediaTabs();
  applySort();
  openIdx = null;
  buildShelf();
  sizeFaces();
  const reopen = openId ? items.findIndex((it) => it.albumId === openId) : -1;
  if (reopen >= 0) openAlbum(reopen, false);
  else autoOpenIfSingle();
  // Rebuilding #shelf's innerHTML resets the scroller to 0. When nothing ended up open
  // (the common case: a background art/enrichment `shelf` broadcast while the user has
  // scrolled), restore their scroll position so the shelf doesn't snap back to the start.
  if (openIdx === null) vp.scrollLeft = prevScroll;
  applyNow(); // restore EQ on playing spines after the rebuild
  renderShelfList();
}

/** Derive `rooms` (the pickable speakers) from `players`. With an exposure list set,
    show exactly those available players (any type). With none, default to real audio
    outputs (speakers), hiding web/computer players. Never leave the wall with zero. */
function computeRooms(): void {
  const avail = players.filter((p) => p.available);
  const ex = settings.exposedPlayers;
  rooms = ex && ex.length ? avail.filter((p) => ex.includes(p.id)) : avail.filter((p) => isSpeaker(p.type));
  if (rooms.length === 0) rooms = avail;
}

async function reloadPlayers(): Promise<void> {
  const res = await client.getPlayers();
  players = res.players;
  computeRooms();
  if (!activePlayerId) activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? null;
  if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
  if (ccIsOpen()) renderCCRooms();
  renderPlayersPane(); // keep the Players settings chips in sync with the roster
}

function applySettings(s: Settings): void {
  const prev = settings;
  settings = s;
  openMode = s.openMode;
  // Follow the admin default search source until the user picks one on the wall. Use the
  // per-kind default for the ACTIVE tab (defaultSourceFor), not the global album default —
  // otherwise a WS settings snapshot arriving mid-search wipes the tab's configured source
  // back to "All" (the "default only kicks in after a while" bug).
  if (!searchSourceUserSet) searchSource = defaultSourceFor(shelfTab);
  // Follow the admin default speaker until the user picks a room on the wall.
  if (s.defaultPlayerId && s.defaultPlayerId !== prev.defaultPlayerId && !userPickedPlayer) {
    activePlayerId = s.defaultPlayerId;
    activeSolo = true;
    if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
    if (ccIsOpen()) renderCCRooms();
  }
  // A player's exposure toggled in the admin → recompute the pickable rooms and re-render
  // the pickers live (no wall refresh), including any open card / play-now overlay.
  if (JSON.stringify(s.exposedPlayers) !== JSON.stringify(prev.exposedPlayers)) {
    computeRooms();
    if (!activePlayerId || !rooms.some((r) => r.id === activePlayerId)) {
      activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? activePlayerId;
    }
    if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
    if (!albumModal.hidden) renderRooms(albumModal.querySelector('.am-card') as HTMLElement);
    if (ccIsOpen()) renderCCRooms();
  }
  // A tab hidden/shown in the admin ("Shown tabs") → re-evaluate the extra-media tabs live.
  if (JSON.stringify(s.mediaTabs) !== JSON.stringify(prev.mediaTabs)) updateMediaTabs();
  applyTextDir();
  applyYearGutter();
  applyYearEmphasis();
  if (s.sortBy !== prev.sortBy) applySort();
  if (
    s.sortBy !== prev.sortBy ||
    s.spineMode !== prev.spineMode ||
    s.spineThickness !== prev.spineThickness ||
    s.spineWidthMode !== prev.spineWidthMode ||
    s.labelLayout !== prev.labelLayout ||
    s.labelVary !== prev.labelVary ||
    s.inkMode !== prev.inkMode ||
    s.inkSize !== prev.inkSize ||
    s.inkWeight !== prev.inkWeight ||
    s.yearDisplay !== prev.yearDisplay ||
    s.yearPos !== prev.yearPos
  ) {
    buildShelf();
    sizeFaces();
    applyNow();
  }
  renderChoices();
  renderCCSort();
  if (openIdx !== null) renderCardModes(); // reflect an afterAlbum change made from the admin
}

/* ---------- Idle chrome ---------- */
/** After a spell without touch, fade the edge pull-tab hints (via body.idle)
    so the resting shelf is pure art. Any input restores them; the edge swipe
    zones stay live regardless, so a single swipe both reveals and opens. */
const IDLE_MS = 10000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastMarkActive = 0;
function markActive(): void {
  const t = performance.now();
  // Fires on every pointermove during a drag; the idle timeout is 10s, so re-arming it more than
  // ~twice a second is wasted work. Throttle the heavy path (the first move of a gesture still runs).
  if (t - lastMarkActive < 500) return;
  lastMarkActive = t;
  lastTouchAt = t;
  document.body.classList.remove('idle');
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), IDLE_MS);
  // A touch during scheduled sleep wakes the screen for a couple of minutes.
  if (scheduledAsleep) {
    tempWakeUntil = Date.now() + 120000;
    checkSchedule(); // wake immediately, don't wait for the 30s tick
  }
  if (isIdle || screenIsOff) exitIdle();
  else restoreFromIdleDim(); // stuck dim after a reload-while-idle: any tap lifts it back
  restartIdleWatch();
}
window.addEventListener('pointerdown', markActive, { passive: true });
window.addEventListener('pointermove', markActive, { passive: true });
window.addEventListener('keydown', markActive);

/* ---------- Idle actions + attract mode + sleep schedule (unified §7) ----------
   Timer-based idle (dim/screen-off + now-playing/shelf/auto-open) and the per-day
   sleep schedule work now; the sensor + ambient-light options are settings-only
   until that hardware exists. */
let isIdle = false;
let screenIsOff = false;
let idleActionTimer: ReturnType<typeof setTimeout> | null = null;
let screenOffTimer: ReturnType<typeof setTimeout> | null = null;
let attractTimer: ReturnType<typeof setInterval> | null = null;
let attractIdx = -1;

/* Idle dimming — restoring the brightness after a dim has to survive a reload (a stuck-dim
   wall that boots dimmed, with isIdle=false, must still lift on the first tap). So the
   "normal" level and an "idle-dimmed" flag live in localStorage, not just memory. */
const NORMAL_BRIGHTNESS_KEY = 'crate.normalBrightness';
const IDLE_DIMMED_KEY = 'crate.idleDimmed';
function normalBrightness(): number {
  const v = Number(localStorage.getItem(NORMAL_BRIGHTNESS_KEY));
  return Number.isFinite(v) && v >= 8 ? v : 100;
}
/** Enter idle-dim: remember the level we're dimming *from* as the restore target, and flag it. */
function markIdleDimmed(fromLevel: number): void {
  if (fromLevel >= 8) localStorage.setItem(NORMAL_BRIGHTNESS_KEY, String(fromLevel));
  localStorage.setItem(IDLE_DIMMED_KEY, '1');
}
/** Lift an idle-dim back to the user's normal brightness. Only acts when the flag is set, so a
    brightness the user *chose* to be low is never overridden. Clears the flag either way. */
function restoreFromIdleDim(): void {
  if (localStorage.getItem(IDLE_DIMMED_KEY) !== '1') return;
  localStorage.removeItem(IDLE_DIMMED_KEY);
  if (scheduledAsleep) return; // during scheduled sleep the screen is meant to stay dark
  void client.setBrightness(normalBrightness()).then(applySystemStatus).catch(() => {});
}

// Two idle stages off the same inactivity clock: show idle content at idleAfterMin, then
// (optionally) turn the screen off at screenOffAfterMin. Both reset on any interaction.
function restartIdleWatch(): void {
  if (idleActionTimer) clearTimeout(idleActionTimer);
  if (screenOffTimer) clearTimeout(screenOffTimer);
  if (settings.idleAfterMin > 0) idleActionTimer = setTimeout(() => void enterIdle(), settings.idleAfterMin * 60000);
  if (settings.screenOffAfterMin > 0) screenOffTimer = setTimeout(() => screenOff(), settings.screenOffAfterMin * 60000);
}

async function enterIdle(): Promise<void> {
  if (isIdle) return;
  isIdle = true;
  // Play-target is sticky per session, then reverts to the admin default on idle so
  // the next person starts fresh at home base.
  if (userPickedPlayer) {
    userPickedPlayer = false;
    activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? activePlayerId;
    activeSolo = false;
    if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
  }
  if (settings.idleDim) {
    const cur = system?.brightness ?? 100;
    if (cur > settings.idleDimPercent) markIdleDimmed(cur); // remember the level to come back to
    void client.setBrightness(settings.idleDimPercent).then(applySystemStatus).catch(() => {});
  }
  if (screenIsOff) return; // screen already off (a short screen-off timer) — nothing to show
  // What to show while idle. 'slideshow' is attract mode (flip through albums).
  if (settings.idleContent === 'slideshow') {
    await startAttract();
  } else if (settings.idleContent === 'nowPlaying') {
    if (playingIdx !== null) openCover(playingIdx);
  } else if (settings.idleContent === 'currentShelf') {
    closeAlbum(); // stay on whatever shelf is showing; just drop any open album
  } else if (settings.idleContent === 'shelf') {
    await switchShelf(settings.idleShelf ?? 'all', true);
  }
}

/** Second idle stage — power the display off (still driven by the same inactivity clock). */
function screenOff(): void {
  if (screenIsOff) return;
  screenIsOff = true;
  stopAttract(); // no point flipping the slideshow behind a dark screen
  void client.setDisplaySleep(true).catch(() => {});
}

function exitIdle(): void {
  if (!isIdle && !screenIsOff) return;
  const wasOff = screenIsOff;
  isIdle = false;
  screenIsOff = false;
  stopAttract();
  if (wasOff) void client.setDisplaySleep(false).catch(() => {});
  restoreFromIdleDim();
}

/** Open an album showing just its cover (no expanded details) — for idle display. */
function openCover(i: number): void {
  openAlbum(i, false);
  (shelf.children[i] as HTMLElement | undefined)?.classList.remove('expanded');
}

async function startAttract(): Promise<void> {
  stopAttract();
  // Point the wall at the auto-open pool so `items` is the right set.
  if (settings.autoOpenPool === 'all') await switchShelf('all', true);
  else if (settings.autoOpenPool === 'shelf' && settings.idleShelf) await switchShelf(settings.idleShelf, true);
  const step = (): void => {
    if (!items.length) return;
    if (settings.autoOpenRandom) attractIdx = Math.floor(Math.random() * items.length);
    else attractIdx = (attractIdx + 1) % items.length;
    openCover(attractIdx);
  };
  step();
  attractTimer = setInterval(step, Math.max(5, settings.autoOpenEverySec) * 1000);
}
function stopAttract(): void {
  if (attractTimer) clearInterval(attractTimer);
  attractTimer = null;
}

/* Per-day sleep schedule — screen off during the window; touch wakes it briefly. */
let scheduledAsleep = false;
let tempWakeUntil = 0;
/** Is the current time inside today's scheduled sleep window? */
function inSleepWindow(): boolean {
  const d = new Date();
  const day = settings.sleepSchedule?.[d.getDay()];
  if (!day?.on) return false;
  const cur = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = day.sleep.split(':').map(Number);
  const [wh, wm] = day.wake.split(':').map(Number);
  const s = (sh ?? 0) * 60 + (sm ?? 0);
  const w = (wh ?? 0) * 60 + (wm ?? 0);
  return s <= w ? cur >= s && cur < w : cur >= s || cur < w; // handles overnight
}
function checkSchedule(): void {
  const shouldSleep = inSleepWindow() && Date.now() > tempWakeUntil;
  if (shouldSleep && !scheduledAsleep) {
    scheduledAsleep = true;
    void client.setDisplaySleep(true).catch(() => {});
  } else if (!shouldSleep && scheduledAsleep) {
    scheduledAsleep = false;
    void client.setDisplaySleep(false).catch(() => {});
  }
}

/* Only #shelf-viewport should ever scroll. Focusing an input (e.g. the Find
   search) can still nudge the document itself, which shifts the absolute
   overlays (control center / find / settings). Clamp any document scroll to 0. */
window.addEventListener('scroll', () => {
  if (document.documentElement.scrollTop || document.body.scrollTop) {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
});

/* ---------- Boot ---------- */
async function boot(): Promise<void> {
  const [shelfRes, playersRes, settingsRes] = await Promise.all([
    client.getShelf().catch(() => ({ items: [], stacks: [], shelves: [], sourceKinds: { radio: false, podcast: false, audiobook: false } })),
    client.getPlayers().catch(() => ({ players: [], state: [] })),
    client.getSettings().catch(() => settings),
  ]);
  items = shelfRes.items;
  shelves = shelfRes.shelves;
  sourceKinds = shelfRes.sourceKinds;
  players = playersRes.players;
  settings = settingsRes;
  updateMediaTabs(); // after settings, so mediaTabs (tab on/off) is applied on the first paint
  searchSource = defaultSourceFor('album'); // start (album tab) search filtered to the configured default
  computeRooms();
  openMode = settings.openMode;
  activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? null;

  applySort();
  buildShelf();
  applyTextDir();
  applyYearGutter();
  applyYearEmphasis();
  sizeFaces();
  autoOpenIfSingle();
  renderChoices();
  handleState(playersRes.state);
  refreshSystem();
  connectWs();
  requestAnimationFrame(tick);
  markActive(); // start the idle countdown
  restartIdleWatch(); // start the idle-action timer from settings
  checkSchedule();
  setInterval(checkSchedule, 30000); // per-day sleep window
  // The wall has no manual refresh — poll playback + shelf periodically so it stays in
  // sync with changes made elsewhere (another app instance, the admin, other rooms).
  setInterval(() => {
    void client.getPlayers().then((r) => handleState(r.state)).catch(() => {});
  }, 20000);
}

void boot();
