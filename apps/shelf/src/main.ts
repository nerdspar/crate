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
let labelStyle: LabelStyle = 'uniform';
let openMode: OpenMode = 'cover';

const shelf = document.getElementById('shelf') as HTMLDivElement;
const toast = document.getElementById('toast') as HTMLDivElement;
let openIdx: number | null = null;
let playingIdx: number | null = null;
let playingTrack = 0;
let activePlayerId: string | null = null;
let volume = 42;

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
    const fontSize = Math.min(spineW * 0.31, 19);
    const ink = a.inkColor === 'dark' ? 'rgba(20,18,16,0.88)' : 'rgba(240,236,228,0.92)';

    const spineBg =
      settings.spineMode === 'art' && a.spineStripUrl
        ? `background-image:url('${a.spineStripUrl}')`
        : `background:linear-gradient(90deg, ${a.darkColor}, ${a.primaryColor} 45%, ${a.darkColor})`;
    const coverArt = a.artworkUrl ? ` has-art" style="background-image:url('${a.artworkUrl}')` : '';

    el.innerHTML = `
      <div class="flap">
        <div class="face face-spine" style="${spineBg}">
          <div class="spine-label" style="font-size:${fontSize}px; color:${ink}">
            <span class="artist">${escapeHtml(a.artist)}</span>&nbsp;&nbsp;<span class="title">${escapeHtml(a.title)}</span>
          </div>
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
      void play(i);
    });
    (el.querySelector('.vol input') as HTMLInputElement).addEventListener('input', (e) => {
      volume = +(e.target as HTMLInputElement).value;
      if (activePlayerId) void client.setVolume({ playerId: activePlayerId, level: volume }).catch(() => {});
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
async function play(i: number): Promise<void> {
  const item = items[i]!;
  try {
    await client.play({ albumId: item.albumId, ...(activePlayerId ? { playerId: activePlayerId } : {}) });
  } catch (e) {
    console.error('play failed', e);
    showToast('Playback failed');
    return;
  }
  document.querySelectorAll('.spine').forEach((s) => s.classList.remove('playing'));
  (shelf.children[i] as HTMLElement).classList.add('playing');
  playingIdx = i;
  playingTrack = 0;
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
  const playing = states.find((s) => s.state === 'playing' && s.nowPlaying?.albumId);
  document.querySelectorAll('.spine.playing').forEach((s) => s.classList.remove('playing'));
  if (playing?.nowPlaying?.albumId) {
    const idx = items.findIndex((it) => it.albumId === playing.nowPlaying!.albumId);
    if (idx >= 0) {
      (shelf.children[idx] as HTMLElement | undefined)?.classList.add('playing');
      playingIdx = idx;
      playingTrack = playing.nowPlaying.trackIndex ?? 0;
    }
  }
  const active = states.find((s) => s.playerId === activePlayerId);
  if (active && active.volume !== null) {
    volume = active.volume;
    if (openIdx !== null) {
      const inp = (shelf.children[openIdx] as HTMLElement).querySelector('.vol input') as HTMLInputElement | null;
      if (inp) inp.value = String(volume);
    }
  }
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
}

void boot();
