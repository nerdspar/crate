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

import { CrateClient, type LabelStyle, type OpenMode, type Player, type PlayerState, type Settings, type ShelfItem, type Track, type WsMessage } from '@crate/shared';
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
let settings: Settings = {
  labelStyle: 'uniform',
  openMode: 'cover',
  spineMode: 'palette',
  sortBy: 'artist',
  defaultPlayerId: null,
  longPressMs: 420,
  idleAutoOpen: true,
  idleMinutes: 5,
};

const LABEL_STYLES: Record<LabelStyle, string[]> = {
  uniform: [''],
  collected: ['', 'v-top', 'v-bottom', '', 'v-bottom', 'v-top'],
  eclectic: ['', 'v-top', 'v-bottom', '', 'v-flip', ''],
};

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
let labelStyle: LabelStyle = 'uniform';
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

function roomName(id: string | null): string {
  return players.find((p) => p.id === id)?.name ?? 'player';
}

function coverW(): number {
  return shelf.clientHeight * 0.89;
}
function panelW(): number {
  return Math.min(window.innerWidth * 0.3, 420);
}

/* ---------- Build the shelf ---------- */
function buildShelf(): void {
  shelf.innerHTML = '';
  items.forEach((a, i) => {
    const spineW = a.spineWidth;
    const el = document.createElement('div');
    el.className = 'spine';
    el.dataset['idx'] = String(i);
    el.style.width = spineW + 'px';
    el.style.setProperty('--spine-w', spineW + 'px');
    // Per-artist type identity; base width (prototype's `w`) is half the rendered spine width.
    const ts = TYPE_STYLES[hashStr(a.artist) % TYPE_STYLES.length]!;
    const baseW = spineW / 2;
    const fontSize = Math.min(baseW * (ts.font.includes('Newsreader') ? 0.66 : 0.6), 19);
    const ink = a.inkColor === 'dark' ? 'rgba(20,18,16,0.88)' : 'rgba(240,236,228,0.92)';

    const spineBg =
      settings.spineMode === 'art' && a.spineStripUrl
        ? `background-image:url('${a.spineStripUrl}')`
        : `background:linear-gradient(90deg, ${a.darkColor}, ${a.primaryColor} 45%, ${a.darkColor})`;
    const coverArt = a.artworkUrl ? ` has-art" style="background-image:url('${a.artworkUrl}')` : '';
    // Catalog imprint on wider spines with a known year (SPINE_RENDERING §1).
    const cat = spineW >= 56 && a.year ? `<div class="cat" style="color:${ink}">${a.year}</div>` : '';

    el.innerHTML = `
      <div class="flap">
        <div class="face face-spine" style="${spineBg}">
          <div class="spine-label" style="font-size:${fontSize}px; color:${ink}; font-family:${ts.font}; font-weight:${ts.weight}; text-transform:${ts.transform}; letter-spacing:${ts.tracking}">
            <span class="artist">${escapeHtml(a.artist)}</span>&nbsp;&nbsp;<span class="title">${escapeHtml(a.title)}</span>
          </div>
          ${cat}
        </div>
        <div class="face face-cover${coverArt || `" style="background:linear-gradient(145deg, ${a.primaryColor}, ${a.darkColor} 85%)`}">
          <div class="cover-type" style="color:${ink}">${escapeHtml(a.title)}</div>
        </div>
      </div>
      <button class="cover-btn cover-play" aria-label="Play">▶</button>
      <button class="cover-btn cover-menu" aria-label="More">⋯</button>
      <div class="panel">
        <div class="eyebrow">From your library</div>
        <h1>${escapeHtml(a.title)}</h1>
        <h2>${escapeHtml(a.artist)}</h2>
        <div class="actions">
          <button class="play">Play</button>
          <div class="rooms"></div>
          <div class="vol">
            <span class="vol-ico">🔉</span>
            <input type="range" min="0" max="100" value="42">
            <span class="vol-ico">🔊</span>
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
  applyLabelStyle(labelStyle);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function sizeFaces(): void {
  const cw = coverW();
  document.querySelectorAll<HTMLElement>('.spine').forEach((el) => {
    el.style.setProperty('--cover-w', cw + 'px');
    el.style.setProperty('--panel-w', panelW() + 'px');
    if (el.classList.contains('open')) {
      el.style.width = openWidth(el) + 'px';
    }
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
  updateNowbar();
  updatePlayButton();
  el.classList.add('open');
  if (openMode === 'card') el.classList.add('expanded');
  el.style.width = openWidth(el) + 'px';
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

function renderRooms(el: HTMLElement): void {
  const wrap = el.querySelector('.rooms') as HTMLElement;
  wrap.innerHTML = '';
  rooms.forEach((r) => {
    const b = document.createElement('button');
    b.className = 'room' + (r.id === activePlayerId ? ' on' : '');
    b.textContent = r.name;
    b.onclick = (e) => {
      e.stopPropagation();
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
      row.innerHTML = `<span class="n">${isNow ? '♪' : ti + 1}</span>${escapeHtml(t.title)}<span class="dur">${dur}</span>`;
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
  playingIdx = i;
  playingTrack = trackIndex;
  document.querySelectorAll('.spine').forEach((s) => s.classList.remove('playing'));
  (shelf.children[i] as HTMLElement).classList.add('playing');
  closeAlbum();
  showToast(`Playing on ${roomName(activePlayerId)}`);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

/* ---------- Settings ---------- */
function applyLabelStyle(style: LabelStyle): void {
  labelStyle = style;
  const variants = LABEL_STYLES[style];
  [...shelf.children].forEach((el, i) => {
    el.classList.remove('v-top', 'v-bottom', 'v-flip');
    const v = variants[i % variants.length];
    if (v) el.classList.add(v);
  });
  renderChoices();
}

const settingsEl = document.getElementById('settings') as HTMLElement;
(document.getElementById('gear') as HTMLElement).onclick = () => settingsEl.classList.add('open');
(document.getElementById('settings-close') as HTMLElement).onclick = () => settingsEl.classList.remove('open');
settingsEl.addEventListener('click', (e) => {
  if (e.target === settingsEl) settingsEl.classList.remove('open');
});

function renderChoices(): void {
  const labelWrap = document.getElementById('label-choices') as HTMLElement;
  labelWrap.innerHTML = '';
  (
    [
      ['uniform', 'Uniform', 'Centered, top to bottom'],
      ['collected', 'Collected', 'Mixed placement, all readable'],
      ['eclectic', 'Eclectic', 'Full variation, some flipped'],
    ] as const
  ).forEach(([key, name, hint]) => {
    const b = document.createElement('button');
    b.className = 'choice' + (key === labelStyle ? ' on' : '');
    b.innerHTML = `${name}<span class="hint">${hint}</span>`;
    b.onclick = () => {
      applyLabelStyle(key);
      void client.putSettings({ labelStyle: key }).catch(() => {});
    };
    labelWrap.appendChild(b);
  });

  const openWrap = document.getElementById('open-choices') as HTMLElement;
  openWrap.innerHTML = '';
  (
    [
      ['cover', 'Cover only', 'Art with play + menu buttons'],
      ['card', 'Full card', 'Cover plus details panel'],
    ] as const
  ).forEach(([key, name, hint]) => {
    const b = document.createElement('button');
    b.className = 'choice' + (key === openMode ? ' on' : '');
    b.innerHTML = `${name}<span class="hint">${hint}</span>`;
    b.onclick = () => {
      openMode = key;
      renderChoices();
      void client.putSettings({ openMode: key }).catch(() => {});
    };
    openWrap.appendChild(b);
  });
}

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
function handleState(states: PlayerState[]): void {
  // Volume of the active player → open slider.
  const active = states.find((s) => s.playerId === activePlayerId);
  if (active && active.volume !== null) {
    volume = active.volume;
    if (openIdx !== null) {
      const inp = (shelf.children[openIdx] as HTMLElement).querySelector('.vol input') as HTMLInputElement | null;
      if (inp) inp.value = String(volume);
    }
  }
  // Now-playing: a playing player mapped to a shelf album — includes playback
  // started externally (phone / Sonos app), which MA reports over the same WS.
  // A playing player wins (also picks up externally-started playback); otherwise
  // an explicitly paused one. Album identity is sticky per player so a frame that
  // loses resolution doesn't wipe it. If nothing is playing/paused but the user
  // just paused (MA may report the queue as idle), hold it paused in place.
  // Guard windows drop this player's not-yet-propagated frames after a user
  // pause/resume: pauseGuard drops stale 'playing' frames, resumeGuard drops
  // stale non-playing frames.
  const t = performance.now();
  const pauseGuard = t < pauseGuardUntil;
  const resumeGuard = t < resumeGuardUntil;
  let pool = states;
  if (pauseGuard) pool = pool.filter((s) => !(s.playerId === now.playerId && s.state === 'playing'));
  if (resumeGuard) pool = pool.filter((s) => !(s.playerId === now.playerId && s.state !== 'playing'));

  const playingS =
    pool.find((s) => s.state === 'playing' && s.nowPlaying?.albumId) ??
    pool.find((s) => s.state === 'playing' && s.nowPlaying);
  const pausedS =
    pool.find((s) => s.state === 'paused' && s.nowPlaying?.albumId) ??
    pool.find((s) => s.state === 'paused' && s.nowPlaying);
  const cand = playingS ?? pausedS;
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
}

function applyNow(): void {
  document.querySelectorAll('.spine.playing').forEach((s) => s.classList.remove('playing'));
  const idx = now.albumId ? items.findIndex((it) => it.albumId === now.albumId) : -1;
  const loaded = idx >= 0 && now.state !== 'idle';
  playingIdx = loaded ? idx : null;
  playingTrack = now.trackIndex;
  if (loaded && now.state === 'playing') (shelf.children[idx] as HTMLElement | undefined)?.classList.add('playing');
  if (openIdx !== null) {
    updateOpenTrackIndicator();
    updateNowbar();
    updatePlayButton();
  }
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
    if (n) n.textContent = isNow ? '♪' : String(ti + 1);
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
    else if (msg.type === 'shelf') void reloadShelf();
    else if (msg.type === 'players') void reloadPlayers();
    else if (msg.type === 'settings') applySettings(msg.settings);
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

async function reloadShelf(): Promise<void> {
  const res = await client.getShelf();
  items = res.items;
  const wasOpen = openIdx;
  openIdx = null;
  buildShelf();
  sizeFaces();
  if (wasOpen !== null && wasOpen < items.length) openAlbum(wasOpen, false);
}

async function reloadPlayers(): Promise<void> {
  const res = await client.getPlayers();
  players = res.players;
  rooms = players.filter((p) => p.type === 'sonos' && p.available);
  if (rooms.length === 0) rooms = players.filter((p) => p.available);
  if (!activePlayerId) activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? null;
  if (openIdx !== null) renderRooms(shelf.children[openIdx] as HTMLElement);
}

function applySettings(s: Settings): void {
  settings = s;
  if (s.labelStyle !== labelStyle) applyLabelStyle(s.labelStyle);
  openMode = s.openMode;
}

/* ---------- Boot ---------- */
async function boot(): Promise<void> {
  const [shelfRes, playersRes, settingsRes] = await Promise.all([
    client.getShelf().catch(() => ({ items: [], stacks: [] })),
    client.getPlayers().catch(() => ({ players: [], state: [] })),
    client.getSettings().catch(() => settings),
  ]);
  items = shelfRes.items;
  players = playersRes.players;
  rooms = players.filter((p) => p.type === 'sonos' && p.available);
  if (rooms.length === 0) rooms = players.filter((p) => p.available);
  settings = settingsRes;
  labelStyle = settings.labelStyle;
  openMode = settings.openMode;
  activePlayerId = settings.defaultPlayerId ?? rooms[0]?.id ?? null;

  buildShelf();
  sizeFaces();
  renderChoices();
  handleState(playersRes.state);
  connectWs();
  requestAnimationFrame(tick);
}

void boot();
