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

import { CrateClient, DEFAULT_SETTINGS, type AfterPlay, type InkMode, type LabelLayout, type LabelVary, type OpenMode, type Player, type PlayerState, type SearchAlbum, type Settings, type Shelf, type ShelfItem, type ShelfKind, type SortBy, type SpineMode, type SpineTextDir, type SpineThickness, type SpineWidthMode, type SystemStatus, type Track, type WsMessage, type YearDisplay, type YearEmphasis, type YearPos } from '@crate/shared';
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
  const d = 0.015 * window.innerWidth; // the 1.5vw margin .spine.open adds on each side
  const cw = coverW();
  // x from settledLeft (stable; the open album's own left margin == d), y from the
  // element (top/height don't animate, unlike the margin/width).
  shelfGlow.style.left = `${settledLeft(i)}px`;
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

    const spineBg = useCustom
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
  return coverW() + (el.classList.contains('expanded') ? panelW() : 0);
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
    b.className = 'room room-group' + (activePlayerId === leader ? ' on' : '');
    b.textContent = `${name} +${members.length - 1}`;
    b.onclick = (e) => {
      e.stopPropagation();
      activePlayerId = leader;
      renderRooms(el);
    };
    wrap.appendChild(b);
  }
  // Members of the currently-targeted group get outlined so you can see the group.
  const activeGroup = groupMembers(leaderOf(activePlayerId ?? ''));
  const inActiveGroup = new Set(activeGroup.length >= 2 ? activeGroup.map((r) => r.id) : []);
  // Then every individual speaker — picking a grouped one pulls it out to play solo.
  rooms.forEach((r) => {
    const b = document.createElement('button');
    b.className = 'room' + (r.id === activePlayerId ? ' on' : inActiveGroup.has(r.id) ? ' in-group' : '');
    b.textContent = r.name;
    b.onclick = (e) => {
      e.stopPropagation();
      if (groupMembers(leaderOf(r.id)).length >= 2) ungroupRoom(r.id);
      activePlayerId = r.id;
      renderRooms(el);
    };
    wrap.appendChild(b);
  });
}

async function renderTracks(el: HTMLElement, i: number): Promise<void> {
  const item = items[i]!;
  const wrap = el.querySelector('.tracks') as HTMLElement;
  const draw = (tracks: Track[]): void => {
    wrap.innerHTML = '';
    tracks.forEach((t, ti) => {
      const row = document.createElement('div');
      const isNow = playingIdx === i && playingTrack === ti;
      row.className = 'track' + (isNow ? ' now' : '');
      const dur = t.duration ? fmtDur(t.duration) : '';
      row.innerHTML = `<span class="n">${isNow ? TRACK_EQ : ti + 1}</span>${escapeHtml(t.title)}<span class="dur">${dur}</span>`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        void play(i, ti);
      });
      wrap.appendChild(row);
    });
  };
  const cached = trackCache.get(item.albumId);
  if (cached) {
    draw(cached);
    return;
  }
  try {
    const detail = await client.getAlbum(item.albumId);
    trackCache.set(item.albumId, detail.tracks);
    if (openIdx === i) draw(detail.tracks);
  } catch {
    /* leave empty */
  }
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

async function play(i: number, trackIndex = 0): Promise<void> {
  const item = items[i]!;
  try {
    await client.play({
      albumId: item.albumId,
      ...(activePlayerId ? { playerId: activePlayerId } : {}),
      ...(trackIndex > 0 ? { trackIndex } : {}),
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
  now = { playerId: activePlayerId, albumId: item.albumId, trackIndex, elapsed: 0, duration: 0, state: 'playing', at: performance.now() };
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
settingsEl.addEventListener('click', (e) => {
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
  updateConditionalRows();
}

/** Hide settings that only apply in another setting's state — the year position
    and emphasis are meaningless when the year is off. */
function updateConditionalRows(): void {
  const yearOn = settings.yearDisplay !== 'off';
  for (const id of ['yearpos-choices', 'yearemph-choices']) {
    document.getElementById(id)?.closest('.setting-row')?.classList.toggle('hidden-row', !yearOn);
  }
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
  const it = playingIdx !== null ? items[playingIdx] : null;
  if (!it || now.state === 'idle') {
    ccArt.style.backgroundImage = '';
    ccTitle.textContent = 'Nothing playing';
    ccArtistEl.textContent = '';
    ccPlayPauseBtn.textContent = '▶';
    updateCCSeek();
    return;
  }
  ccArt.style.backgroundImage = it.artworkUrl ? `url('${it.artworkUrl}')` : '';
  ccTitle.textContent = it.title;
  ccArtistEl.textContent = it.artist;
  ccPlayPauseBtn.textContent = now.state === 'playing' ? '❚❚' : '▶';
  updateCCSeek();
}
function updateCCSeek(): void {
  if (!ccIsOpen()) return;
  if (now.duration > 0 && playingIdx !== null) {
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
function roomCell(r: Player): HTMLElement {
  const armed = r.id === pendingGroup;
  const row = document.createElement('div');
  row.className = 'cc-room' + (r.id === focusedPlayerId ? ' focused' : '') + (armed ? ' pending' : '');
  row.innerHTML =
    `<div class="cc-room-top">` +
    `<span class="cc-room-name">${escapeHtml(r.name)}</span>` +
    `<button class="cc-room-join">${armed ? 'Cancel' : pendingGroup ? 'Add' : 'Group'}</button>` +
    `</div>` +
    `<input type="range" min="0" max="100" value="${roomVol(r.id)}">`;
  wireVolume(row.querySelector('input') as HTMLInputElement, r.id);
  (row.querySelector('.cc-room-name') as HTMLElement).addEventListener('click', () => focusRoom(r.id));
  (row.querySelector('.cc-room-join') as HTMLElement).addEventListener('click', () => groupRoom(r.id));
  return row;
}

/** A real group: one combined volume (sets them all) + a dropdown of members. */
function groupCell(leader: string, members: Player[]): HTMLElement {
  const avg = Math.round(members.reduce((s, r) => s + roomVol(r.id), 0) / members.length);
  const leaderName = rooms.find((r) => r.id === leader)?.name ?? 'Group';
  const expanded = expandedGroups.has(leader);
  const cell = document.createElement('div');
  cell.className = 'cc-room grouped cc-group';
  cell.innerHTML =
    `<div class="cc-room-top">` +
    `<span class="cc-room-name">${escapeHtml(leaderName)} <span class="cc-room-tag">leader</span> +${members.length - 1}</span>` +
    `<button class="cc-group-toggle">${expanded ? 'Hide' : 'Rooms'}</button>` +
    `</div>` +
    `<input type="range" min="0" max="100" value="${avg}">` +
    `<div class="cc-group-members"${expanded ? '' : ' hidden'}></div>`;
  (cell.querySelector('input') as HTMLInputElement).addEventListener('input', (e) => {
    const level = +(e.target as HTMLInputElement).value;
    for (const r of members) void client.setVolume({ playerId: r.id, level }).catch(() => {});
  });
  (cell.querySelector('.cc-group-toggle') as HTMLElement).addEventListener('click', () => {
    if (expandedGroups.has(leader)) expandedGroups.delete(leader);
    else expandedGroups.add(leader);
    renderCCRooms();
  });
  const memWrap = cell.querySelector('.cc-group-members') as HTMLElement;
  for (const r of members) {
    const m = document.createElement('div');
    m.className = 'cc-group-member' + (r.id === focusedPlayerId ? ' focused' : '');
    m.innerHTML =
      `<div class="cc-room-top">` +
      `<span class="cc-room-name">${escapeHtml(r.name)}${r.id === leader ? ' <span class="cc-room-tag">leader</span>' : ''}</span>` +
      `<button class="cc-room-join">Leave</button>` +
      `</div>` +
      `<input type="range" min="0" max="100" value="${roomVol(r.id)}">`;
    wireVolume(m.querySelector('input') as HTMLInputElement, r.id);
    (m.querySelector('.cc-room-name') as HTMLElement).addEventListener('click', () => focusRoom(r.id));
    (m.querySelector('.cc-room-join') as HTMLElement).addEventListener('click', () => ungroupRoom(r.id));
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
let providerResults: SearchAlbum[] = [];
let providerSearching = false;

findSearch.addEventListener('input', () => {
  filterQuery = findSearch.value.trim();
  items.forEach((a, i) => {
    (shelf.children[i] as HTMLElement | undefined)?.classList.toggle('sliver', !matchesFilter(a));
  });
  sizeFaces();
  providerResults = [];
  providerSearching = filterQuery.length >= 2;
  renderResults();
  if (searchTimer) clearTimeout(searchTimer);
  if (filterQuery.length >= 2) searchTimer = setTimeout(() => void searchProvider(), 450);
  else clearFindResults();
});
// Enter (hardware keyboards / the on-screen "Go" key) searches immediately.
findSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && filterQuery) {
    if (searchTimer) clearTimeout(searchTimer);
    void searchProvider();
  }
});

function clearFindResults(): void {
  searchSeq++; // cancel any in-flight render
  providerResults = [];
  providerSearching = false;
  findResults.hidden = true;
  findResults.innerHTML = '';
}

/** Search the provider (Apple Music via MA) for albums to add. */
async function searchProvider(): Promise<void> {
  const q = findSearch.value.trim();
  if (!q) return;
  const seq = ++searchSeq;
  try {
    const res = await client.search(q);
    if (seq !== searchSeq) return;
    providerResults = res;
    providerSearching = false;
    renderResults();
  } catch {
    if (seq !== searchSeq) return;
    providerResults = [];
    providerSearching = false;
    renderResults();
  }
}

/** Render the pick-list: shelf matches (open) + provider matches not on the shelf (add). */
function renderResults(): void {
  if (!filterQuery) {
    clearFindResults();
    return;
  }
  const locals = items.filter(matchesFilter);
  const adds = providerResults.filter((a) => !a.onShelf);
  findResults.hidden = false;
  findResults.innerHTML = '';
  for (const it of locals) findResults.appendChild(shelfCard(it));
  for (const al of adds) findResults.appendChild(addCard(al));
  if (!locals.length && !adds.length) {
    findResults.innerHTML = `<div class="find-empty">${providerSearching ? 'Searching Apple Music…' : 'Nothing found.'}</div>`;
  }
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

/** A shelf match — tap anywhere to clear the search and open that album. */
function shelfCard(it: ShelfItem): HTMLElement {
  const card = cardShell(it.title, it.artist, it.artworkUrl, 'Open');
  const open = (): void => {
    const idx = items.findIndex((x) => x.albumId === it.albumId);
    clearSearch();
    closeFind();
    if (idx >= 0) openAlbum(idx);
  };
  card.addEventListener('click', open);
  return card;
}

/** A provider match not on the shelf — Add it. */
function addCard(al: SearchAlbum): HTMLElement {
  const card = cardShell(al.title, al.artist, al.artworkUrl, 'Add');
  const btn = card.querySelector('.find-card-add') as HTMLButtonElement;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      await client.addToShelf({ providerUri: al.providerUri });
      btn.textContent = 'Added';
    } catch {
      btn.disabled = false;
      btn.textContent = 'Add';
      showToast('Add failed');
    }
  };
  return card;
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
    document.querySelectorAll('.find-shelf-tab').forEach((t) => t.classList.toggle('on', t === tab));
    renderShelfList();
  });
});

function renderShelfList(): void {
  findShelfList.innerHTML = '';
  for (const s of shelves.filter((sh) => sh.kind === shelfTab)) {
    const b = document.createElement('button');
    b.className = 'find-shelf' + (s.id === activeShelf ? ' on' : '');
    b.textContent = s.name;
    b.onclick = () => void switchShelf(s.id);
    findShelfList.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'find-shelf find-shelf-new';
  add.textContent = '+ New';
  add.onclick = () => newShelfInput();
  findShelfList.appendChild(add);
}

async function switchShelf(id: string, close = true): Promise<void> {
  const res = await client.getShelf(id === 'all' ? undefined : id);
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

function newShelfInput(): void {
  const input = document.createElement('input');
  input.className = 'find-shelf-input';
  input.placeholder = 'Name this shelf…';
  input.autocomplete = 'off';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) void createNamedShelf(input.value.trim());
    else if (e.key === 'Escape') renderShelfList();
  });
  findShelfList.appendChild(input);
  input.focus({ preventScroll: true });
}

async function createNamedShelf(name: string): Promise<void> {
  const sh = await client.createShelf({ name, kind: shelfTab }).catch(() => null);
  if (!sh) return;
  shelves.push(sh);
  await switchShelf(sh.id, false); // keep the Find bar open after creating
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
      if (downTarget.classList.contains('open')) {
        closeAlbum();
      } else {
        openAlbum(+downTarget.dataset['idx']!);
      }
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
  const sig = groupSig();
  if (sig !== lastGroupSig) {
    lastGroupSig = sig;
    if (ccIsOpen()) renderCCRooms();
    if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
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
  const res = await client.getShelf(activeShelf === 'all' ? undefined : activeShelf);
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
}
window.addEventListener('pointerdown', markActive, { passive: true });
window.addEventListener('pointermove', markActive, { passive: true });
window.addEventListener('keydown', markActive);

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
}

void boot();
