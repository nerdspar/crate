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

import { CrateClient, DEFAULT_SETTINGS, type AfterPlay, type IdleScreen, type IdleContent, type InkMode, type LabelLayout, type LabelVary, type GlobalSearchResponse, type LibraryPlaylist, type OpenMode, type ProviderAlbumDetail, type Player, type PlayerState, type SearchAlbum, type SearchSong, type Settings, type Shelf, type ShelfItem, type ShelfKind, type SortBy, type SpineMode, type SpineTextDir, type SpineThickness, type SpineWidthMode, type SystemStatus, type Track, type WsMessage, type YearDisplay, type YearEmphasis, type YearPos } from '@crate/shared';
// Fonts bundled locally (§12) — the kiosk must not depend on Google Fonts.
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource/oswald/400.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/600.css';
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
let shelfAdding = false; // showing the inline "name this shelf" box
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
const TRACK_EQ = '<span class="track-eq"><i></i><i></i><i></i></span>';
let openMode: OpenMode = 'cover';

const shelf = document.getElementById('shelf') as HTMLDivElement;
const toast = document.getElementById('toast') as HTMLDivElement;
let openIdx: number | null = null;
let playingIdx: number | null = null;
let playingTrack = 0;
let activePlayerId: string | null = null;
let activeSolo = false; // the target was picked as an individual speaker (vs a group)
let volume = 42;

/** Live now-playing state, driven by WS state + progress ticks. */
interface NowState {
  playerId: string | null;
  albumId: string | null;
  trackIndex: number;
  elapsed: number;
  duration: number;
  state: 'playing' | 'paused' | 'idle';
  at: number; // performance.now() at last elapsed sample
}
let now: NowState = { playerId: null, albumId: null, trackIndex: 0, elapsed: 0, duration: 0, state: 'idle', at: performance.now() };
/** Latch: the user paused. Some MA player providers report a paused queue as
    'idle', so we hold the now-playing paused until resume / a new play. */
let userPaused = false;
/** After a user pause/resume, ignore stale frames for this player until this time
    (the command hasn't propagated through MA yet): pauseGuard drops stale
    'playing' frames, resumeGuard drops stale non-playing frames. */
let pauseGuardUntil = 0;
let resumeGuardUntil = 0;

const trackCache = new Map<string, Track[]>();
/** For playlist song spines: cached off-shelf album detail (keyed by album uri)
    and the resolved album-track index each song cues to. */
const albumDetailCache = new Map<string, ProviderAlbumDetail>();
const songCue = new Map<string, number>();

/** Live shelf search (control center). Empty = everything matches; non-matches
    collapse to slivers via spineWidthPx. */
let filterQuery = '';
function matchesFilter(a: ShelfItem): boolean {
  if (!filterQuery) return true;
  const q = filterQuery.toLowerCase();
  return a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q);
}

function roomName(id: string | null): string {
  return players.find((p) => p.id === id)?.name ?? 'player';
}

function coverW(): number {
  return shelf.clientHeight * 0.89;
}
function panelW(): number {
  return Math.min(window.innerWidth * 0.3, 420);
}
/** Base spine width, proportional to a real CD jewel case (~10mm spine on a
    ~117mm case ≈ 9% of the case height). This is the uniform "every CD is the
    same size" width, and the anchor a duration-scaled width flexes around. */
const THICKNESS_RATIO: Record<SpineThickness, number> = { thin: 0.05, medium: 0.062, thick: 0.082 };
function spineBaseW(): number {
  return Math.round(Math.max(26, Math.min(coverW() * THICKNESS_RATIO[settings.spineThickness], 92)));
}
/** A 40-minute album sits at the base thickness; longer/shorter runtimes flex
    the width around it (SPINE_RENDERING §4). Clamped so an EP is still grabbable
    and a boxed set never dominates the shelf. */
const WIDTH_REF_SEC = 2400;
const SLIVER_W = 0; // search non-matches are hidden (.sliver → display:none); width 0 keeps settledLeft exact
/** Effective spine width (px) for one album, honoring the width mode and the
    live search filter. Deterministic → layout math (settledLeft) stays exact. */
function spineWidthPx(a: ShelfItem): number {
  if (!matchesFilter(a)) return SLIVER_W;
  const base = spineBaseW();
  if (settings.spineWidthMode !== 'duration' || !a.durationSec) return base;
  const mult = Math.max(0.68, Math.min(a.durationSec / WIDTH_REF_SEC, 1.7));
  return Math.round(Math.max(20, Math.min(base * mult, 120)));
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

/** Size the glow to a uniform square halo of width `d` (the gap the open album
    opens up around itself) so it fills the blank space and stops at the neighbors. */
function positionGlow(i: number): void {
  const a = items[i];
  const el = shelf.children[i] as HTMLElement | undefined;
  if (!a || !el) return;
  const d = 0.05 * window.innerWidth; // halo spread — a soft backlight beyond the cover
  const cw = coverW();
  // Centre a square-ish halo on the open cover (which sits ~a spine-width right of
  // the settled position). y from the element (top/height don't animate).
  shelfGlow.style.left = `${settledLeft(i) - d}px`;
  shelfGlow.style.width = `${cw + 2 * d}px`;
  shelfGlow.style.top = `${el.offsetTop - d}px`;
  shelfGlow.style.height = `${el.offsetHeight + 2 * d}px`;
  shelfGlow.style.backgroundImage = a.artworkUrl ? `url('${a.artworkUrl}')` : 'none';
  if (!a.artworkUrl) shelfGlow.style.backgroundColor = a.primaryColor;
  shelfGlow.classList.add('on');
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
    const fontSize = Math.min(baseW * (font.includes('Newsreader') ? 0.66 : 0.6), 19);
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
    const labelCss = `font-size:${fontSize}px; font-family:${font}; font-weight:${ts.weight}; text-transform:${ts.transform}; letter-spacing:${tracking}`;
    const artistSpan = `<span class="artist" style="color:${artistCol}">${escapeHtml(a.artist)}</span>`;
    const titleSpan = `<span class="title" style="color:${titleCol}">${escapeHtml(a.title)}</span>`;
    const labelHtml =
      layout === 'split'
        ? `<div class="spine-label artist-label" style="${labelCss}">${artistSpan}</div>` +
          `<div class="spine-label title-label" style="${labelCss}">${titleSpan}</div>`
        : `<div class="spine-label" style="${labelCss}; color:${baseInk}">${artistSpan}&nbsp;&nbsp;${titleSpan}</div>`;

    // A playlist *case* (on the All Playlists shelf) gets a "Songs" action that
    // opens it as its own single-playlist song shelf. Song spines don't.
    const isPlaylistCase = a.kind === 'playlist' && !a.albumUri;

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
      <button class="cover-btn cover-play" aria-label="Play">▶</button>
      <button class="cover-btn cover-menu" aria-label="More">⋯</button>
      <div class="panel">
        <button class="panel-menu" aria-label="More">⋯</button>
        <div class="panel-pop" hidden>
          <div class="panel-pop-label">Add to shelf</div>
          <div class="panel-add-shelves"></div>
          <button class="panel-remove">Remove from shelf</button>
        </div>
        <div class="eyebrow">From your library</div>
        <h1>${escapeHtml(a.title)}</h1>
        <h2>${escapeHtml(a.artist)}</h2>
        <div class="actions">
          <button class="play">Play</button>
          ${isPlaylistCase ? '<button class="songs">Songs</button>' : ''}
          <div class="rooms"></div>
          <div class="vol">
            <span class="vol-ico">${VOL_LOW_SVG}</span>
            <input type="range" min="0" max="100" value="42">
            <span class="vol-ico">${VOL_HIGH_SVG}</span>
          </div>
        </div>
        <div class="nowbar" hidden>
          <div class="seek"><div class="seek-fill"></div></div>
          <div class="times"><span class="cur">0:00</span><span class="dur">0:00</span></div>
        </div>
        <div class="tracks"></div>
      </div>
      <div class="eq"><i></i><i></i><i></i></div>`;

    const stop = (e: Event): void => e.stopPropagation();
    el.querySelector('.cover-play')!.addEventListener('pointerdown', stop);
    el.querySelector('.cover-play')!.addEventListener('click', (e) => {
      stop(e);
      void play(i);
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
    el.querySelector('.songs')?.addEventListener('click', (e) => {
      stop(e);
      void openAsSongShelf(a.albumId, a.title);
    });
    // ⋯ menu on the card (will also hold "Add to shelf…"). Toggles the popover.
    const panelPop = el.querySelector('.panel-pop') as HTMLElement;
    el.querySelector('.panel-menu')!.addEventListener('click', (e) => {
      stop(e);
      panelPop.hidden = !panelPop.hidden;
      if (!panelPop.hidden) renderAddShelves(el.querySelector('.panel-add-shelves') as HTMLElement, a.albumId);
    });
    // Remove from shelf — two-tap to arm, so it can't fire by accident on a wall.
    const removeBtn = el.querySelector('.panel-remove') as HTMLButtonElement;
    let removeArmed = false;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;
    removeBtn.addEventListener('click', (e) => {
      stop(e);
      if (!removeArmed) {
        removeArmed = true;
        removeBtn.textContent = 'Tap again to remove';
        removeBtn.classList.add('armed');
        removeTimer = setTimeout(() => {
          removeArmed = false;
          removeBtn.textContent = 'Remove from shelf';
          removeBtn.classList.remove('armed');
        }, 3000);
        return;
      }
      if (removeTimer) clearTimeout(removeTimer);
      void client
        .removeFromShelf(a.albumId)
        .then(() => showToast('Removed'))
        .catch(() => showToast('Remove failed'));
    });
    (el.querySelector('.vol input') as HTMLInputElement).addEventListener('input', (e) => {
      volume = +(e.target as HTMLInputElement).value;
      if (activePlayerId) void client.setVolume({ playerId: activePlayerId, level: volume }).catch(() => {});
    });
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
  renderChoices();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function sizeFaces(): void {
  const cw = coverW();
  const pw = panelW();
  document.querySelectorAll<HTMLElement>('.spine').forEach((el) => {
    const a = items[+el.dataset['idx']!];
    const sw = a ? spineWidthPx(a) : spineBaseW();
    el.style.setProperty('--cover-w', cw + 'px');
    el.style.setProperty('--panel-w', pw + 'px');
    el.style.setProperty('--spine-w', sw + 'px');
    el.style.width = el.classList.contains('open') ? openWidth(el) + 'px' : sw + 'px';
  });
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
  renderRooms(el);
  void renderTracks(el, i);
  (el.querySelector('.vol input') as HTMLInputElement).value = String(volume);
  handleState(lastStates); // refocus now-playing on the newly-opened album
  el.classList.add('open');
  if (openMode === 'card') el.classList.add('expanded');
  el.style.width = openWidth(el) + 'px';
  positionGlow(i);
  if (!autoscroll) return;
  requestAnimationFrame(() => {
    smoothScrollTo(vp, settledLeft(i) - vp.clientWidth * 0.12);
  });
}

function expand(el: HTMLElement, on: boolean): void {
  el.classList.toggle('expanded', on);
  el.style.width = openWidth(el) + 'px';
}

function closeAlbum(): void {
  if (openIdx === null) return;
  const el = shelf.children[openIdx] as HTMLElement;
  el.classList.remove('open', 'expanded');
  el.style.width = el.style.getPropertyValue('--spine-w');
  shelfGlow.classList.remove('on');
  openIdx = null;
}

function settledLeft(i: number): number {
  const cs = getComputedStyle(shelf);
  const gap = parseFloat(cs.columnGap) || 3;
  let x = parseFloat(cs.paddingLeft);
  for (let j = 0; j < i; j++) {
    x += parseFloat((shelf.children[j] as HTMLElement).style.getPropertyValue('--spine-w')) + gap;
  }
  return x;
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

/** Album-card play-target picker: chips for each real group AND every individual
    speaker. Group management + volume live in the control center; here you just
    choose where this album plays. */
function renderRooms(el: HTMLElement): void {
  const wrap = el.querySelector('.rooms') as HTMLElement;
  wrap.innerHTML = '';
  // Group chips first — play to the whole group (targets its leader).
  for (const leader of [...new Set(rooms.map((r) => leaderOf(r.id)))]) {
    const members = groupMembers(leader);
    if (members.length < 2) continue;
    const name = rooms.find((r) => r.id === leader)?.name ?? 'Group';
    const b = document.createElement('button');
    b.className = 'room room-group' + (!activeSolo && activePlayerId === leader ? ' on' : '');
    b.textContent = `${name} +${members.length - 1}`;
    b.onclick = (e) => {
      e.stopPropagation();
      activePlayerId = leader;
      activeSolo = false;
      renderRooms(el);
    };
    wrap.appendChild(b);
  }
  // Outline the targeted group's members (only when a GROUP is the target).
  const activeGroup = !activeSolo ? groupMembers(leaderOf(activePlayerId ?? '')) : [];
  const inActiveGroup = new Set(activeGroup.length >= 2 ? activeGroup.map((r) => r.id) : []);
  // Then every individual speaker. Picking a grouped one just selects it — it's
  // only pulled out of its group when you actually hit Play (so a mis-tap is safe).
  rooms.forEach((r) => {
    const b = document.createElement('button');
    b.className = 'room' + (activeSolo && r.id === activePlayerId ? ' on' : inActiveGroup.has(r.id) ? ' in-group' : '');
    b.textContent = r.name;
    b.onclick = (e) => {
      e.stopPropagation();
      activePlayerId = r.id;
      activeSolo = true;
      renderRooms(el);
    };
    wrap.appendChild(b);
  });
}

async function renderTracks(el: HTMLElement, i: number): Promise<void> {
  const item = items[i]!;
  const wrap = el.querySelector('.tracks') as HTMLElement;
  const draw = (tracks: Track[], cueIdx: number): void => {
    wrap.innerHTML = '';
    tracks.forEach((t, ti) => {
      const row = document.createElement('div');
      const isNow = playingIdx === i && playingTrack === ti;
      row.className = 'track' + (isNow ? ' now' : ti === cueIdx ? ' cued' : '');
      const dur = t.duration ? fmtDur(t.duration) : '';
      row.innerHTML = `<span class="n">${isNow ? TRACK_EQ : ti + 1}</span>${escapeHtml(t.title)}<span class="dur">${dur}</span>`;
      // Tap = select/highlight only; the card's Play button plays the selected track.
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        songCue.set(item.albumId, ti);
        wrap.querySelectorAll('.track').forEach((r, idx) => {
          if (!r.classList.contains('now')) r.classList.toggle('cued', idx === ti);
        });
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
/** Panel Play button: toggles pause/resume when this album is loaded, else plays it.
   Full transport (prev/next) lives in the control center (§6, Phase 3). */
async function onPlayButton(i: number): Promise<void> {
  if (playingIdx === i && now.playerId && now.state !== 'idle') {
    const playerId = now.playerId;
    const pausing = now.state === 'playing';
    // Freeze at the displayed (interpolated) position so pause doesn't jump back.
    now.elapsed = liveElapsed();
    now.at = performance.now();
    now.state = pausing ? 'paused' : 'playing';
    userPaused = pausing;
    pauseGuardUntil = pausing ? performance.now() + 3000 : 0;
    resumeGuardUntil = pausing ? 0 : performance.now() + 3000;
    applyNow();
    await client.transport({ playerId, cmd: pausing ? 'pause' : 'play' }).catch(() => {});
    return;
  }
  await play(i);
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
}

async function play(i: number, trackIndex?: number): Promise<void> {
  const item = items[i]!;
  await ungroupActiveSoloIfNeeded();
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
  try {
    await client.play({
      albumId: item.albumId,
      ...(activePlayerId ? { playerId: activePlayerId } : {}),
      ...(providerUri ? { providerUri } : {}),
      ...(cue > 0 ? { trackIndex: cue } : {}),
    });
  } catch (e) {
    console.error('play failed', e);
    showToast('Playback failed');
    return;
  }
  // Optimistic now-state; the next WS state/progress corrects it.
  userPaused = false;
  pauseGuardUntil = 0;
  resumeGuardUntil = 0;
  now = { playerId: activePlayerId, albumId: item.albumId, trackIndex: cue, elapsed: 0, duration: 0, state: 'playing', at: performance.now() };
  applyNow();
  scheduleAfterPlayClose();
  showToast(`Playing on ${roomName(activePlayerId)}`);
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
function swipeToClose(sheet: HTMLElement, dir: 'up' | 'down', close: () => void): void {
  let startY = 0;
  let active = false;
  sheet.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('input[type="range"]')) {
      active = false;
      return;
    }
    active = true;
    startY = e.clientY;
  });
  sheet.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    const dy = e.clientY - startY;
    if (dir === 'up' ? dy < -45 : dy > 45) close();
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
  'year-choices': 'Show the release year on the spine (vertical or horizontal), or hide it.',
  'yearpos-choices': 'Which end of the spine the year sits at.',
  'yearemph-choices': 'A faint catalog stamp, or bolder text readable from across the room.',
  'layout-choices': 'Where the artist and title sit along the spine.',
  'vary-choices': 'One shared font for every spine, or a different type style per artist.',
  'open-choices': 'Tapping a spine shows just the cover, or a full details card.',
  'afterplay-choices': 'What the open card does after you hit play.',
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
      ['duration', 'By length', 'Longer albums render fatter'],
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
      void client.putSettings({ afterPlay: settings.afterPlay }).catch(() => {});
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
  choiceRow(
    'idle-screen-choices',
    [['on', 'Stay on', ''], ['dim', 'Dim', ''], ['off', 'Screen off', '']],
    (k) => settings.idleScreen === k,
    (k) => {
      settings.idleScreen = k as IdleScreen;
      void client.putSettings({ idleScreen: settings.idleScreen }).catch(() => {});
      updateConditionalRows(); // show/hide the dim slider for the new screen mode
    },
  );
  // Idle dim brightness is a slider (see idleDimSlider wiring below); just sync it here.
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
      ['autoOpen', 'Auto-open', ''],
    ],
    (k) => settings.idleContent === k,
    (k) => {
      settings.idleContent = k as IdleContent;
      void client.putSettings({ idleContent: settings.idleContent }).catch(() => {});
      updateConditionalRows();
    },
  );
  // Idle / auto-open target shelf — dynamic: "All" plus every album shelf.
  choiceRow(
    'idle-shelf-choices',
    [['all', 'All', ''], ...shelves.filter((s) => s.kind === 'album' && s.id !== 'all').map((s) => [s.id, s.name, ''] as const)],
    (k) => (settings.idleShelf ?? 'all') === k,
    (k) => {
      settings.idleShelf = k === 'all' ? null : k;
      void client.putSettings({ idleShelf: settings.idleShelf }).catch(() => {});
    },
  );
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
  renderWallSchedule();
  updateConditionalRows();
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
  // The "when idle" behaviors only matter if idle can ever trigger (a timer or the sensor).
  const idleOn = settings.idleAfterMin > 0 || settings.idleUseSensor;
  const show = (id: string, on: boolean): void =>
    void document.getElementById(id)?.closest('.setting-row')?.classList.toggle('hidden-row', !on);
  // Screen + dim slider live in one .setting-keep block: hide the whole block when
  // idle is off, and hide the dim row itself unless the screen mode is Dim. The
  // Device columns are independent, so collapsing this row only reflows column 2.
  document.querySelector('.setting-keep')?.classList.toggle('hidden-row', !idleOn);
  show('idle-dim-slider', settings.idleScreen === 'dim');
  show('idle-content-choices', idleOn);
  // Target shelf is used by "A shelf" content and by auto-open when its pool is "A shelf".
  const needsShelf =
    settings.idleContent === 'shelf' ||
    (settings.idleContent === 'autoOpen' && settings.autoOpenPool === 'shelf');
  show('idle-shelf-choices', idleOn && needsShelf);
  const attract = idleOn && settings.idleContent === 'autoOpen';
  for (const id of ['autoopen-every-choices', 'autoopen-pool-choices', 'autoopen-random-choices'])
    show(id, attract);
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

/** Which player's playback the now-playing hero follows (for multi-room). Null =
    auto-pick whatever's playing. Set by tapping a room name. */
let focusedPlayerId: string | null = null;
/** Which group cells have their member list expanded (by leader id) — per-group. */
const expandedGroups = new Set<string>();
/** 2-tap grouping: the "armed" room waiting for a second one to group with. */
let pendingGroup: string | null = null;
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
}
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
  if (gripDown) gripDown = false;
  if (handleDown) {
    handleDown = false;
    if (handleY - e.clientY > 40 || Math.abs(handleY - e.clientY) < 8) closeCC();
  }
});

/* ---- Transport ---- */
(document.getElementById('cc-prev') as HTMLElement).addEventListener('click', () => ccSkip('previous'));
(document.getElementById('cc-next') as HTMLElement).addEventListener('click', () => ccSkip('next'));
ccPlayPauseBtn.addEventListener('click', () => void ccPlayPause());

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
  // Prefer the shelf item (has cover art); fall back to the player's now-playing
  // metadata so the hero shows ANY room's content, even off the current shelf.
  const it = playingIdx !== null ? items[playingIdx] : null;
  const np = lastStates.find((s) => s.playerId === now.playerId)?.nowPlaying ?? null;
  const title = it?.title ?? np?.album ?? np?.title ?? '';
  if (now.state === 'idle' || !title) {
    ccArt.style.backgroundImage = '';
    ccTitle.textContent = 'Nothing playing';
    ccArtistEl.textContent = '';
    ccPlayPauseBtn.textContent = '▶';
    updateCCSeek();
    return;
  }
  const art = it?.artworkUrl ?? np?.artworkUrl ?? null;
  ccArt.style.backgroundImage = art ? `url('${art}')` : '';
  ccTitle.textContent = title;
  ccArtistEl.textContent = it?.artist ?? np?.artist ?? '';
  ccPlayPauseBtn.textContent = now.state === 'playing' ? '❚❚' : '▶';
  updateCCSeek();
}
function updateCCSeek(): void {
  if (!ccIsOpen()) return;
  if (now.duration > 0 && now.state !== 'idle') {
    const e = liveElapsed();
    ccSeekFill.style.width = `${Math.min(100, (e / now.duration) * 100)}%`;
    ccCur.textContent = fmtDur(e);
    ccDur.textContent = fmtDur(now.duration);
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
function wireVolume(input: HTMLInputElement, playerId: string): void {
  input.addEventListener('input', (e) => {
    void client.setVolume({ playerId, level: +(e.target as HTMLInputElement).value }).catch(() => {});
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
  if (focusedPlayerId) activePlayerId = id;
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
  const row = document.createElement('div');
  row.className =
    'cc-room' + (r.id === focusedPlayerId ? ' focused' : '') + (armed ? ' pending' : '') + (playing ? ' playing' : '');
  const isAdd = !armed && pendingGroup;
  row.innerHTML =
    `<div class="cc-room-top">` +
    `<span class="cc-room-name">${playing ? TRACK_EQ + ' ' : ''}${escapeHtml(r.name)}</span>` +
    `<button class="cc-room-join${isAdd ? ' is-add' : ''}">${armed ? 'Cancel' : pendingGroup ? 'Add' : 'Group'}</button>` +
    `</div>` +
    `<input type="range" min="0" max="100" value="${roomVol(r.id)}">`;
  wireVolume(row.querySelector('input') as HTMLInputElement, r.id);
  // Tap the row (name / blank area) → make the now-playing hero follow this room.
  (row.querySelector('.cc-room-top') as HTMLElement).addEventListener('click', () => focusRoom(r.id));
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
  const playing = roomIsPlaying(leader); // the group plays through its leader
  const cell = document.createElement('div');
  cell.className = 'cc-room grouped cc-group' + (groupArmed ? ' pending' : '') + (playing ? ' playing' : '');
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
  (cell.querySelector('input') as HTMLInputElement).addEventListener('input', (e) => {
    const level = +(e.target as HTMLInputElement).value;
    for (const r of members) void client.setVolume({ playerId: r.id, level }).catch(() => {});
  });
  const toggleGroup = (): void => {
    if (expandedGroups.has(leader)) expandedGroups.delete(leader);
    else expandedGroups.add(leader);
    renderCCRooms();
  };
  // Caret expands; tapping the row (name / blank area) focuses the hero on the group.
  (cell.querySelector('.cc-group-toggle') as HTMLElement).addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGroup();
  });
  (cell.querySelector('.cc-room-top') as HTMLElement).addEventListener('click', () => focusRoom(leader));
  const memWrap = cell.querySelector('.cc-group-members') as HTMLElement;
  for (const r of members) {
    const mPlaying = roomIsPlaying(r.id);
    const m = document.createElement('div');
    m.className = 'cc-group-member' + (r.id === focusedPlayerId ? ' focused' : '') + (mPlaying ? ' playing' : '');
    m.innerHTML =
      `<div class="cc-room-top">` +
      `<span class="cc-room-name">${mPlaying ? TRACK_EQ + ' ' : ''}${escapeHtml(r.name)}${r.id === leader ? ' <span class="cc-room-tag">leader</span>' : ''}</span>` +
      `<button class="cc-room-join">Leave</button>` +
      `</div>` +
      `<input type="range" min="0" max="100" value="${roomVol(r.id)}">`;
    wireVolume(m.querySelector('input') as HTMLInputElement, r.id);
    (m.querySelector('.cc-room-top') as HTMLElement).addEventListener('click', () => focusRoom(r.id));
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
  renderCCSort();
  renderShelfList();
  // No auto-focus: the shelf list is the primary content; tapping the search
  // field is what pops the on-screen keyboard.
}
function closeFind(): void {
  find.classList.remove('open');
  clearFindResults();
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
  if (fGripDown) fGripDown = false;
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
let searchSource = 'all'; // selected global-search source (instance id or 'all')
let globalResults: GlobalSearchResponse | null = null;
let libPlaylistsCache: LibraryPlaylist[] | null = null;

/* Search paging: show 20 per section, "Load more" raises the fetch limit + reveals
   the next 20. MA search has no offset, so we re-fetch with a larger per-section cap. */
const SEARCH_PAGE = 20;
let searchLimit = SEARCH_PAGE;
const searchShown = { albums: SEARCH_PAGE, playlists: SEARCH_PAGE, songs: SEARCH_PAGE };
function resetSearchPaging(): void {
  searchLimit = SEARCH_PAGE;
  searchShown.albums = searchShown.playlists = searchShown.songs = SEARCH_PAGE;
}
function loadMoreSection(key: 'albums' | 'playlists' | 'songs'): void {
  searchShown[key] += SEARCH_PAGE;
  const need = Math.max(searchShown.albums, searchShown.playlists, searchShown.songs);
  if (need > searchLimit) {
    searchLimit = need;
    void runGlobalSearch(); // fetch the bigger page, then re-render
  } else {
    renderGlobal(false); // already fetched — just reveal more
  }
}

findSearch.addEventListener('input', () => {
  filterQuery = findSearch.value.trim();
  items.forEach((a, i) => {
    (shelf.children[i] as HTMLElement | undefined)?.classList.toggle('sliver', !matchesFilter(a));
  });
  sizeFaces();
  if (searchTimer) clearTimeout(searchTimer);
  if (filterQuery.length >= 2) {
    resetSearchPaging(); // a new query starts back at the first page
    renderGlobal(true); // show the loading scaffold immediately
    searchTimer = setTimeout(() => void runGlobalSearch(), 400);
  } else {
    clearFindResults();
  }
});
// Enter (hardware keyboards / the on-screen "Go" key) searches immediately.
findSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && filterQuery) {
    if (searchTimer) clearTimeout(searchTimer);
    void runGlobalSearch();
  }
});

function clearFindResults(): void {
  searchSeq++; // cancel any in-flight render
  globalResults = null;
  findResults.hidden = true;
  findResults.innerHTML = '';
}

/** Global search across the connected sources → albums, playlists, songs. */
async function runGlobalSearch(): Promise<void> {
  const q = findSearch.value.trim();
  if (!q) return;
  const seq = ++searchSeq;
  try {
    const res = await client.globalSearch(q, searchSource, searchLimit);
    if (seq !== searchSeq) return;
    globalResults = res;
  } catch {
    if (seq !== searchSeq) return;
    globalResults = null;
  }
  renderGlobal(false);
}

/** Sonos-style results: a source dropdown + three columns (Albums / Playlists / Songs). */
function renderGlobal(loading: boolean): void {
  if (!filterQuery) {
    clearFindResults();
    return;
  }
  findResults.hidden = false;
  findResults.innerHTML = '';
  const g = globalResults;

  const bar = document.createElement('div');
  bar.className = 'find-srcbar';
  bar.appendChild(sourceDropdown(g?.sources ?? []));
  findResults.appendChild(bar);

  const cats = document.createElement('div');
  cats.className = 'find-cats';
  const localMatches = items.filter(matchesFilter).map(shelfCard); // your shelf's own hits, in Albums
  const remoteAlbums = (g?.albums ?? []).filter((a) => !a.onShelf);
  const playlists = g?.playlists ?? [];
  const songs = g?.songs ?? [];
  cats.appendChild(catColumn('Albums', [...localMatches, ...remoteAlbums.map(addCard)], loading, 'albums', remoteAlbums.length));
  cats.appendChild(catColumn('Playlists', playlists.map(playlistCard), loading, 'playlists', playlists.length));
  cats.appendChild(catColumn('Songs', songs.map(songResultCard), loading, 'songs', songs.length));
  findResults.appendChild(cats);
}

function catColumn(
  title: string,
  cards: HTMLElement[],
  loading: boolean,
  key: 'albums' | 'playlists' | 'songs',
  remoteCount: number,
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
    // Offer more when we have extra fetched-but-hidden cards, or the source's page
    // came back saturated (so there are likely more beyond what we've fetched).
    if (!loading && (cards.length > shown || remoteCount >= searchLimit)) {
      const more = document.createElement('button');
      more.className = 'find-more';
      more.textContent = 'Load more';
      more.onclick = () => loadMoreSection(key);
      list.appendChild(more);
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

/** Source dropdown at the top of the results (All + each connected streaming source). */
function sourceDropdown(sources: GlobalSearchResponse['sources']): HTMLElement {
  const cur = sources.find((s) => s.instanceId === searchSource);
  const btn = document.createElement('button');
  btn.className = 'find-src-btn';
  btn.textContent = `Source: ${cur?.name ?? 'All'} ▾`;
  btn.onclick = (e) => {
    e.stopPropagation();
    if (activeAddMenu) {
      closeAddMenu();
      return;
    }
    openAddMenu(btn, [
      { label: 'All sources', on: searchSource === 'all', fn: () => pickSource('all') },
      ...sources.map((s) => ({ label: s.name, on: s.instanceId === searchSource, fn: () => pickSource(s.instanceId) })),
    ]);
  };
  return btn;
}
function pickSource(id: string): void {
  searchSource = id;
  resetSearchPaging(); // switching source is a fresh search
  void runGlobalSearch();
}

/** A song result — tap the card to open its album with the track cued; the ▶ button
    plays the song straight away (search song cards are the one place a tap-to-play
    lives; inside album/playlist track lists, tapping only selects — see the top Play). */
function songResultCard(s: SearchSong): HTMLElement {
  const card = cardShell(s.title, s.artist + (s.album ? ` · ${s.album}` : ''), s.artworkUrl, '');
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap');
  card.addEventListener('click', () => void openProviderAlbum(s.trackUri));
  const playBtn = document.createElement('button');
  playBtn.className = 'find-card-play';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.textContent = '▶';
  playBtn.onclick = (e) => {
    e.stopPropagation(); // don't also open the album
    void playSong(s.trackUri);
  };
  card.appendChild(playBtn);
  return card;
}

/** Play a searched song now: resolve its album + track index, play from that track. */
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
    showToast(`Playing on ${roomName(activePlayerId)}`);
  } catch {
    showToast('Playback failed');
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

(albumModal.querySelector('.am-backdrop') as HTMLElement).addEventListener('click', closeAlbumModal);
(albumModal.querySelector('.am-play') as HTMLElement).addEventListener('click', () => void playModal());

function closeAlbumModal(): void {
  albumModal.hidden = true;
  modalUri = null;
  modalAlbumUri = null;
}

async function openProviderAlbum(uri: string): Promise<void> {
  modalUri = uri;
  modalAlbumUri = null;
  modalCue = -1;
  const set = (sel: string, text: string): void => {
    (albumModal.querySelector(sel) as HTMLElement).textContent = text;
  };
  set('.am-title', 'Loading…');
  set('.am-artist', '');
  set('.am-eyebrow', 'Apple Music');
  (albumModal.querySelector('.am-cover') as HTMLElement).style.backgroundImage = '';
  (albumModal.querySelector('.am-tracks') as HTMLElement).innerHTML = '';
  (albumModal.querySelector('.am-add') as HTMLElement).innerHTML = '';
  albumModal.hidden = false;

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
  set('.am-title', d.title);
  set('.am-artist', d.artist);
  const tw = albumModal.querySelector('.am-tracks') as HTMLElement;
  tw.innerHTML = '';
  d.tracks.forEach((t, ti) => {
    const row = document.createElement('div');
    row.className = 'track' + (ti === d.cueIndex ? ' cued' : '');
    const dur = t.duration ? fmtDur(t.duration) : '';
    row.innerHTML = `<span class="n">${ti + 1}</span>${escapeHtml(t.title)}<span class="dur">${dur}</span>`;
    // Tap = select/highlight only; the top Play button plays the selected track.
    row.addEventListener('click', () => {
      modalCue = ti;
      tw.querySelectorAll('.track').forEach((r, idx) => r.classList.toggle('cued', idx === ti));
    });
    tw.appendChild(row);
  });
  renderRooms(albumModal.querySelector('.am-card') as HTMLElement); // reuse the room picker
  (albumModal.querySelector('.am-add') as HTMLElement).appendChild(addAlbumControl(d.providerUri));
}

async function playModal(trackIndex?: number): Promise<void> {
  if (!modalAlbumUri) return;
  const cue = trackIndex ?? (modalCue >= 0 ? modalCue : 0);
  if (activePlayerId && activeSolo) await ungroupActiveSoloIfNeeded();
  try {
    await client.play({
      albumId: modalAlbumUri,
      providerUri: modalAlbumUri,
      ...(activePlayerId ? { playerId: activePlayerId } : {}),
      ...(cue > 0 ? { trackIndex: cue } : {}),
    });
    showToast(`Playing on ${roomName(activePlayerId)}`);
  } catch {
    showToast('Playback failed');
  }
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
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  const out = (e: Event): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) closeAddMenu();
  };
  (menu as unknown as { _out: (e: Event) => void })._out = out;
  activeAddMenu = menu;
  setTimeout(() => document.addEventListener('pointerdown', out, true), 0);
}

function cardShell(title: string, artist: string, artUrl: string | null, action: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'find-card';
  const art = artUrl ? ` style="background-image:url('${artUrl}')"` : '';
  card.innerHTML =
    `<div class="find-card-art"${art}></div>` +
    `<div class="find-card-meta"><span class="t">${escapeHtml(title)}</span><span class="a">${escapeHtml(artist)}</span></div>` +
    `<button class="find-card-add">${action}</button>`;
  return card;
}

/** A shelf match — tap anywhere to open the album; the Open button carries a ▾ that
    adds this already-in-library album to other shelves too. */
function shelfCard(it: ShelfItem): HTMLElement {
  const card = cardShell(it.title, it.artist, it.artworkUrl, '');
  card.querySelector('.find-card-add')?.remove();
  const open = (): void => {
    const idx = items.findIndex((x) => x.albumId === it.albumId);
    clearSearch();
    closeFind();
    if (idx >= 0) openAlbum(idx);
  };
  card.classList.add('find-card-tap');
  card.addEventListener('click', open);
  card.appendChild(addedAlbumControl(it.albumId, open));
  return card;
}

/** "Open" + a ▾ that adds an already-in-library album (by id) to other album shelves
    or a new one. Used on search cards for albums that are already on a shelf. */
function addedAlbumControl(albumId: string, open: () => void): HTMLElement {
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
    ]);
  };
  ctrl.append(mainBtn, caret);
  return ctrl;
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
      libPlaylistsCache = null;
      return true;
    } catch {
      showToast('Add failed');
      return false;
    }
  };

  mainBtn.onclick = async () => {
    if (added) {
      void openAddedPlaylist(pl.name);
      return;
    }
    mainBtn.disabled = true;
    caret.disabled = true;
    mainBtn.textContent = 'Adding…';
    if (await ensureAdded()) {
      mainBtn.textContent = 'Added';
    } else {
      mainBtn.disabled = false;
      caret.disabled = false;
      mainBtn.textContent = 'Add';
    }
  };
  caret.onclick = (e) => {
    e.stopPropagation();
    if (activeAddMenu) {
      closeAddMenu();
      return;
    }
    openAddMenu(caret, [{ label: 'New song shelf', fn: () => void makeSongShelfFromPlaylist(pl) }]);
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
    libPlaylistsCache = null;
  } catch {
    showToast('Add failed');
    return;
  }
  const res = await client.getShelf('playlists');
  shelves = res.shelves;
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
async function revealAddedAlbum(shelfId: string, providerUri: string): Promise<void> {
  closeAlbumModal();
  await revealAddedAlbumById(shelfId, albumIdFromUri(providerUri));
}

/** Switch the wall to a shelf and scroll to an album by id, leaving the Find bar open. */
async function revealAddedAlbumById(shelfId: string, albumId: string): Promise<void> {
  await switchShelf(shelfId, false); // keep the Find bar open
  const idx = items.findIndex((it) => it.albumId === albumId);
  if (idx >= 0) requestAnimationFrame(() => smoothScrollTo(vp, settledLeft(idx) - vp.clientWidth * 0.12));
}

/** A provider album match — the button adds to the open shelf (or library on All);
    a ▾ dropdown picks a different destination (or a new shelf). */
function addCard(al: SearchAlbum): HTMLElement {
  const card = cardShell(al.title, al.artist, al.artworkUrl, '');
  card.querySelector('.find-card-add')?.remove();
  card.classList.add('find-card-tap'); // tap the card → open it (preview / play now)
  card.addEventListener('click', () => void openProviderAlbum(al.providerUri));
  card.appendChild(addAlbumControl(al.providerUri));
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
      await client.addToShelf({ providerUri, ...(shelfId !== 'all' ? { shelfId } : {}) });
      const n = nameOf(shelfId);
      mainBtn.textContent = n ? `Added to ${n}` : 'Added';
      // Added to a named shelf → switch the wall to it and reveal the album, but
      // keep the Find bar open so you can add more (#7).
      if (shelfId !== 'all') void revealAddedAlbum(shelfId, providerUri);
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

/** Clear the search query and un-hide every spine. */
function clearSearch(): void {
  filterQuery = '';
  findSearch.value = '';
  items.forEach((_, i) => (shelf.children[i] as HTMLElement | undefined)?.classList.remove('sliver'));
  sizeFaces();
  clearFindResults();
}

/* =====================================================================
   Shelves ("crates"): the Find bar doubles as the shelf switcher — Albums /
   Playlists tabs + a list of shelves you tap to switch the wall.
   ===================================================================== */
const findShelfList = document.getElementById('find-shelf-list') as HTMLElement;

document.querySelectorAll<HTMLElement>('.find-shelf-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    shelfTab = tab.dataset['kind'] as ShelfKind;
    shelfAdding = false;
    shelfDeleteArmed = null;
    shelfRenaming = null;
    clearSearch(); // search behaves differently per tab; reset it
    document.querySelectorAll('.find-shelf-tab').forEach((t) => t.classList.toggle('on', t === tab));
    renderShelfList();
  });
});

function renderShelfList(): void {
  findShelfList.innerHTML = '';
  for (const s of shelves.filter((sh) => sh.kind === shelfTab)) {
    const selected = s.id === activeShelf;
    const editable = selected && s.id !== 'all' && s.id !== 'playlists';
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
      const name = document.createElement('span');
      name.className = 'find-shelf-name';
      name.textContent = s.name;
      name.onclick = () => void switchShelf(s.id);
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
  // Add control: album shelves are named here; playlist shelves come from the library.
  if (shelfTab === 'playlist') {
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
  if (!list.length) {
    findResults.innerHTML = '<div class="find-empty">No playlists in your library.</div>';
    return;
  }
  for (const pl of list) findResults.appendChild(playlistCard(pl));
}

function playlistCard(pl: LibraryPlaylist): HTMLElement {
  const card = cardShell(pl.name, pl.owner ?? 'Playlist', pl.artworkUrl, '');
  card.querySelector('.find-card-add')?.remove();
  card.appendChild(playlistAddControl(pl));
  return card;
}

async function switchShelf(id: string, close = true): Promise<void> {
  shelfAdding = false;
  shelfDeleteArmed = null;
  shelfRenaming = null;
  const tok = ++shelfLoadToken;
  const res = await client.getShelf(id === 'all' ? undefined : id);
  if (tok !== shelfLoadToken) return; // a newer load superseded this one
  activeShelf = id;
  items = res.items;
  shelves = res.shelves;
  applySort();
  openIdx = null;
  buildShelf();
  sizeFaces();
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
}

// Brightness: dim live while dragging, persist (and drive hardware) on release.
ccBrightness.addEventListener('input', () => {
  if (system) {
    system.brightness = +ccBrightness.value;
    applyDim();
  }
});
ccBrightness.addEventListener('change', () => {
  void client.setBrightness(+ccBrightness.value).then(applySystemStatus).catch(() => {});
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

/* =====================================================================
   Gesture engine (verbatim from the prototype — do not rework)
   - nothing open + drag  → scroll the shelf (with momentum)
   - quick tap            → flip album out / flip the open one closed
   - hold                 → flip out under the finger
   - anything open + drag → step through albums, shelf glides along
   ===================================================================== */
const vp = document.getElementById('shelf-viewport') as HTMLElement;
const STEP_PX = 110;
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
  stepAccum = 0;

function followOpen(): void {
  if (openIdx === null) return;
  smoothScrollTo(vp, settledLeft(openIdx) - vp.clientWidth * 0.12, 320);
}

function stepAlbum(dir: number): void {
  if (openIdx === null) return;
  const next = Math.min(Math.max(openIdx + dir, 0), items.length - 1);
  if (next === openIdx) return;
  openAlbum(next, false);
  followOpen();
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
  pDown = true;
  moved = false;
  startX = lastX = e.clientX;
  scrollStart = vp.scrollLeft;
  if (raf !== null) cancelAnimationFrame(raf);
  vel = 0;
  downTarget = (e.target as HTMLElement).closest('.spine');

  stepping = openIdx !== null;
  stepAccum = 0;

  if (downTarget && openIdx === null) {
    holdTimer = setTimeout(() => {
      if (!moved && pDown) {
        openAlbum(+downTarget!.dataset['idx']!);
        stepping = true;
        stepAccum = 0;
        lastX = startX;
      }
    }, settings.longPressMs);
  }
});

window.addEventListener('pointermove', (e) => {
  if (!pDown) return;

  if (stepping) {
    stepAccum += e.clientX - lastX;
    lastX = e.clientX;
    while (stepAccum <= -STEP_PX) {
      stepAlbum(1);
      stepAccum += STEP_PX;
    }
    while (stepAccum >= STEP_PX) {
      stepAlbum(-1);
      stepAccum -= STEP_PX;
    }
    return;
  }

  if (Math.abs(e.clientX - startX) > 8) {
    moved = true;
    if (holdTimer) clearTimeout(holdTimer);
  }
  vel = e.clientX - lastX;
  lastX = e.clientX;
  if (moved) vp.scrollLeft = scrollStart - (e.clientX - startX);
});

window.addEventListener('pointerup', (e) => {
  if (!pDown) return;
  pDown = false;
  if (holdTimer) clearTimeout(holdTimer);

  if (stepping) {
    stepping = false;
    if (Math.abs(e.clientX - startX) <= 8 && downTarget) {
      // Resolve by layout position (not the visually-hit element) so tapping a
      // LEFT neighbor opens it instead of hitting the open album's overlapping cover.
      const j = spineAtX(e.clientX);
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
    if (openIdx !== null) {
      const inp = (shelf.children[openIdx] as HTMLElement).querySelector('.vol input') as HTMLInputElement | null;
      if (inp) inp.value = String(volume);
    }
  }
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
  // A tapped room (focusedPlayerId) wins, so the hero follows the room you picked.
  const forFocus = focusedPlayerId
    ? pool.find((s) => s.playerId === focusedPlayerId && (s.state === 'playing' || s.state === 'paused') && s.nowPlaying)
    : undefined;
  const forOpen = openAlbumId
    ? pool.find((s) => (s.state === 'playing' || s.state === 'paused') && s.nowPlaying?.albumId === openAlbumId)
    : undefined;
  const playingS =
    pool.find((s) => s.state === 'playing' && s.nowPlaying?.albumId) ??
    pool.find((s) => s.state === 'playing' && s.nowPlaying);
  const pausedS =
    pool.find((s) => s.state === 'paused' && s.nowPlaying?.albumId) ??
    pool.find((s) => s.state === 'paused' && s.nowPlaying);
  const cand = forFocus ?? forOpen ?? playingS ?? pausedS;
  if (cand?.nowPlaying) {
    const st = cand.state === 'playing' ? 'playing' : 'paused';
    if (st === 'playing') userPaused = false;
    const samePlayer = cand.playerId === now.playerId;
    now = {
      playerId: cand.playerId,
      albumId: cand.nowPlaying.albumId ?? (samePlayer ? now.albumId : null),
      trackIndex: cand.nowPlaying.trackIndex ?? (samePlayer ? now.trackIndex : 0),
      elapsed: cand.nowPlaying.elapsed ?? now.elapsed,
      duration: cand.nowPlaying.duration ?? (samePlayer ? now.duration : 0),
      state: st,
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
  const psig = lastStates
    .filter((s) => s.state === 'playing' && s.nowPlaying)
    .map((s) => s.playerId)
    .sort()
    .join(',');
  if (sig !== lastGroupSig || psig !== lastPlayingSig) {
    const groupChanged = sig !== lastGroupSig;
    lastGroupSig = sig;
    lastPlayingSig = psig;
    if (ccIsOpen()) renderCCRooms();
    if (groupChanged && openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
  }
}

/** EQ every album that's playing on any player (multi-room), plus an optimistic
    just-played album. Independent of the open card's focused `now`. */
function markPlayingSpines(): void {
  const playing = new Set<string>();
  for (const s of lastStates) if (s.state === 'playing' && s.nowPlaying?.albumId) playing.add(s.nowPlaying.albumId);
  if (now.state === 'playing' && now.albumId) playing.add(now.albumId);
  items.forEach((it, i) => {
    (shelf.children[i] as HTMLElement | undefined)?.classList.toggle('playing', playing.has(it.albumId));
  });
}

function applyNow(): void {
  const idx = now.albumId ? items.findIndex((it) => it.albumId === now.albumId) : -1;
  const loaded = idx >= 0 && now.state !== 'idle';
  playingIdx = loaded ? idx : null;
  playingTrack = now.trackIndex;
  markPlayingSpines();
  if (openIdx !== null) {
    updateOpenTrackIndicator();
    updateNowbar();
    updatePlayButton();
  }
  renderCCNow();
}

function updatePlayButton(): void {
  if (openIdx === null) return;
  const panel = shelf.children[openIdx] as HTMLElement;
  const btn = panel.querySelector('.play') as HTMLElement | null;
  const eyebrow = panel.querySelector('.eyebrow') as HTMLElement | null;
  const isThis = playingIdx === openIdx;
  if (btn) btn.textContent = isThis ? (now.state === 'playing' ? 'Pause' : 'Resume') : 'Play';
  if (eyebrow) eyebrow.textContent = isThis ? 'Now playing' : 'From your library';
}

function updateOpenTrackIndicator(): void {
  if (openIdx === null) return;
  const panel = shelf.children[openIdx] as HTMLElement;
  panel.querySelectorAll('.track').forEach((row, ti) => {
    const isNow = playingIdx === openIdx && ti === playingTrack;
    row.classList.toggle('now', isNow);
    const n = row.querySelector('.n');
    if (n) n.innerHTML = isNow ? TRACK_EQ : String(ti + 1);
  });
}

function liveElapsed(): number {
  const e = now.state === 'playing' ? now.elapsed + (performance.now() - now.at) / 1000 : now.elapsed;
  return now.duration > 0 ? Math.min(e, now.duration) : e;
}

function updateNowbar(): void {
  if (openIdx === null) return;
  const panel = shelf.children[openIdx] as HTMLElement;
  const bar = panel.querySelector('.nowbar') as HTMLElement | null;
  if (!bar) return;
  const show = playingIdx === openIdx && now.duration > 0;
  bar.hidden = !show;
  if (!show) return;
  const e = liveElapsed();
  (bar.querySelector('.seek-fill') as HTMLElement).style.width = `${Math.min(100, (e / now.duration) * 100)}%`;
  (bar.querySelector('.cur') as HTMLElement).textContent = fmtDur(e);
  (bar.querySelector('.dur') as HTMLElement).textContent = fmtDur(now.duration);
}

function handleProgress(playerId: string, elapsed: number): void {
  if (playerId !== now.playerId) return;
  now.elapsed = elapsed;
  now.at = performance.now();
  if (now.state === 'idle') now.state = 'playing';
}

function tick(): void {
  if (openIdx !== null && playingIdx === openIdx) updateNowbar();
  if (ccIsOpen()) updateCCSeek();
  requestAnimationFrame(tick);
}

function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(ev.data as string) as WsMessage;
    } catch {
      return;
    }
    if (msg.type === 'state') handleState(msg.state);
    else if (msg.type === 'progress') handleProgress(msg.playerId, msg.elapsed);
    else if (msg.type === 'shelf' || msg.type === 'shelves') void reloadShelf();
    else if (msg.type === 'players') void reloadPlayers();
    else if (msg.type === 'settings') applySettings(msg.settings);
    else if (msg.type === 'system') applySystemStatus(msg.status);
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

async function reloadShelf(): Promise<void> {
  const tok = ++shelfLoadToken;
  const res = await client.getShelf(activeShelf === 'all' ? undefined : activeShelf);
  if (tok !== shelfLoadToken) return; // a newer load (e.g. a shelf switch) superseded this
  const openId = openIdx !== null ? (items[openIdx]?.albumId ?? null) : null;
  items = res.items;
  shelves = res.shelves;
  applySort();
  openIdx = null;
  buildShelf();
  sizeFaces();
  const reopen = openId ? items.findIndex((it) => it.albumId === openId) : -1;
  if (reopen >= 0) openAlbum(reopen, false);
  applyNow(); // restore EQ on playing spines after the rebuild
  renderShelfList();
}

async function reloadPlayers(): Promise<void> {
  const res = await client.getPlayers();
  players = res.players;
  rooms = players.filter((p) => p.type === 'sonos' && p.available);
  if (rooms.length === 0) rooms = players.filter((p) => p.available);
  if (!activePlayerId) activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? null;
  if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
  if (ccIsOpen()) renderCCRooms();
}

function applySettings(s: Settings): void {
  const prev = settings;
  settings = s;
  openMode = s.openMode;
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
    s.yearDisplay !== prev.yearDisplay ||
    s.yearPos !== prev.yearPos
  ) {
    buildShelf();
    sizeFaces();
    applyNow();
  }
  renderChoices();
  renderCCSort();
}

/* ---------- Idle chrome ---------- */
/** After a spell without touch, fade the edge pull-tab hints (via body.idle)
    so the resting shelf is pure art. Any input restores them; the edge swipe
    zones stay live regardless, so a single swipe both reveals and opens. */
const IDLE_MS = 10000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function markActive(): void {
  document.body.classList.remove('idle');
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), IDLE_MS);
  // A touch during scheduled sleep wakes the screen for a couple of minutes.
  if (scheduledAsleep) {
    tempWakeUntil = Date.now() + 120000;
    checkSchedule(); // wake immediately, don't wait for the 30s tick
  }
  if (isIdle) exitIdle();
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
let idleActionTimer: ReturnType<typeof setTimeout> | null = null;
let attractTimer: ReturnType<typeof setInterval> | null = null;
let preIdleBrightness: number | null = null;
let attractIdx = -1;

function restartIdleWatch(): void {
  if (idleActionTimer) clearTimeout(idleActionTimer);
  const min = settings.idleAfterMin;
  if (min > 0) idleActionTimer = setTimeout(() => void enterIdle(), min * 60000);
}

async function enterIdle(): Promise<void> {
  if (isIdle) return;
  isIdle = true;
  // Screen
  if (settings.idleScreen === 'off') {
    void client.setDisplaySleep(true).catch(() => {});
  } else if (settings.idleScreen === 'dim') {
    preIdleBrightness = system?.brightness ?? 100;
    void client.setBrightness(settings.idleDimPercent).then(applySystemStatus).catch(() => {});
  }
  // Content
  if (settings.idleContent === 'nowPlaying') {
    if (playingIdx !== null) openCover(playingIdx);
  } else if (settings.idleContent === 'currentShelf') {
    closeAlbum(); // stay on whatever shelf is showing; just drop any open album
  } else if (settings.idleContent === 'shelf') {
    await switchShelf(settings.idleShelf ?? 'all', true);
  } else if (settings.idleContent === 'autoOpen') {
    await startAttract();
  }
}

function exitIdle(): void {
  if (!isIdle) return;
  isIdle = false;
  stopAttract();
  if (settings.idleScreen === 'off') void client.setDisplaySleep(false).catch(() => {});
  else if (settings.idleScreen === 'dim' && preIdleBrightness != null) {
    void client.setBrightness(preIdleBrightness).then(applySystemStatus).catch(() => {});
    preIdleBrightness = null;
  }
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
function checkSchedule(): void {
  const d = new Date();
  const day = settings.sleepSchedule?.[d.getDay()];
  let inWindow = false;
  if (day?.on) {
    const cur = d.getHours() * 60 + d.getMinutes();
    const [sh, sm] = day.sleep.split(':').map(Number);
    const [wh, wm] = day.wake.split(':').map(Number);
    const s = (sh ?? 0) * 60 + (sm ?? 0);
    const w = (wh ?? 0) * 60 + (wm ?? 0);
    inWindow = s <= w ? cur >= s && cur < w : cur >= s || cur < w; // handles overnight
  }
  const shouldSleep = inWindow && Date.now() > tempWakeUntil;
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
    client.getShelf().catch(() => ({ items: [], stacks: [], shelves: [] })),
    client.getPlayers().catch(() => ({ players: [], state: [] })),
    client.getSettings().catch(() => settings),
  ]);
  items = shelfRes.items;
  shelves = shelfRes.shelves;
  players = playersRes.players;
  rooms = players.filter((p) => p.type === 'sonos' && p.available);
  if (rooms.length === 0) rooms = players.filter((p) => p.available);
  settings = settingsRes;
  openMode = settings.openMode;
  activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? null;

  applySort();
  buildShelf();
  applyTextDir();
  applyYearGutter();
  applyYearEmphasis();
  sizeFaces();
  renderChoices();
  handleState(playersRes.state);
  refreshSystem();
  connectWs();
  requestAnimationFrame(tick);
  markActive(); // start the idle countdown
  restartIdleWatch(); // start the idle-action timer from settings
  checkSchedule();
  setInterval(checkSchedule, 30000); // per-day sleep window
}

void boot();
