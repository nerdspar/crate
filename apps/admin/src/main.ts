/**
 * Crate admin — a small web app (phone or desktop) with a bottom tab bar:
 * Search (add albums), Shelves (curate collections; "All" is the default shelf),
 * and Settings (mirrors the wall). Per-album spine overrides live in a modal.
 */

import { CrateClient, type LibraryAlbum, type LibraryPlaylist, type MusicSourceInfo, type OverrideRequest, type SearchAlbum, type Settings, type Shelf, type ShelfItem } from '@crate/shared';
import crateMark from './crate-mark.svg';
import crateMarkMono from './crate-mark-mono.svg';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource-variable/newsreader/standard.css';
import './styles.css';

const client = new CrateClient('');

const toast = document.getElementById('toast') as HTMLElement;

type ShelfView = 'list' | 'tile';
type ShelfSort = 'custom' | 'added' | 'artist' | 'title' | 'year';
type AddType = 'album' | 'playlist';

// Add tab: one search over your library + the catalog, per content type. Source-aware.
let addType: AddType = 'album';
let sources: MusicSourceInfo[] = [];
let curSource = 'all';
let addQuery = '';
let libAlbums: LibraryAlbum[] = [];
let catAlbums: SearchAlbum[] = [];
let libPlaylists: LibraryPlaylist[] = [];
let catPlaylists: LibraryPlaylist[] = [];
let addOffset = 0;
let addHasMore = false;
let addLoading = false;
let addToken = 0; // guards against out-of-order async responses
const ADD_PAGE = 60;
let shelves: Shelf[] = [];
let settings: Settings | null = null;
const crateMembers = new Map<string, Set<string>>(); // shelf id → member album ids (named shelves)
let libraryCount = 0; // size of the "All" shelf
let playlistCount = 0; // size of the "All Playlists" shelf
const playlistSongCounts = new Map<string, number>(); // named playlist shelf id → song count

// Currently open shelf detail: 'all' = the library, else a named shelf id; null = index.
let openShelfId: string | null = null;
let openShelfName = '';
let shelfFilter = '';
let detailItems: ShelfItem[] = [];
const sortByShelf = new Map<string, ShelfSort>();
const viewByShelf = new Map<string, ShelfView>();

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// Cover art with the Crate mark as the fallback: shown when there's no artwork, or when the
// image fails to load (e.g. personal Apple Music uploads whose signed art URLs MA can't re-serve).
document.documentElement.style.setProperty('--crate-mark', `url("${crateMark}")`);
function artHtml(url: string | null): string {
  const img = url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="art">${img}</div>`;
}

/* ================= Tab navigation ================= */
function switchTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.tab-pane').forEach((p) => p.classList.toggle('on', p.dataset['tab'] === name));
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((b) => b.classList.toggle('on', b.dataset['tab'] === name));
}
document.querySelectorAll<HTMLElement>('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset['tab']!));
});

/* ================= Add — one search over your library + the catalog ================= */
const sourceSel = document.getElementById('source-sel') as HTMLSelectElement;
const addSearchInput = document.getElementById('add-search') as HTMLInputElement;
const importBtn = document.getElementById('lib-import') as HTMLButtonElement;
const addListEl = document.getElementById('add-list') as HTMLElement;
const addMoreBtn = document.getElementById('add-more') as HTMLButtonElement;

function mkBtn(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  b.textContent = label;
  return b;
}
const taKey = (t: string, a: string): string => `${t} ${a}`.toLowerCase().replace(/\s+/g, ' ').trim();

function updateAddToolbar(): void {
  addSearchInput.placeholder = `Search your library & Apple Music — ${addType === 'album' ? 'album or artist' : 'playlist'}…`;
  importBtn.hidden = addType !== 'album'; // "Add all" only for albums
}
// Albums vs Playlists is one shared choice across Add and Shelves.
function setContentType(type: AddType): void {
  addType = type;
  document
    .querySelectorAll<HTMLElement>('#add-type .seg-btn, #shelves-type .seg-btn')
    .forEach((b) => b.classList.toggle('on', b.dataset['type'] === type));
  updateAddToolbar();
  backToIndex(); // switching type drops any open shelf detail / songs view
  renderShelvesIndex();
  void reloadAdd(true);
}
document
  .querySelectorAll<HTMLElement>('#add-type .seg-btn, #shelves-type .seg-btn')
  .forEach((b) => b.addEventListener('click', () => setContentType(b.dataset['type'] as AddType)));

function syncSourceSel(): void {
  if (sources.length <= 1) {
    sourceSel.hidden = true;
    return;
  }
  if (sourceSel.options.length !== sources.length + 1) {
    sourceSel.innerHTML = '';
    sourceSel.add(new Option('All sources', 'all'));
    for (const s of sources) sourceSel.add(new Option(s.name, s.instanceId));
  }
  sourceSel.value = curSource;
  sourceSel.hidden = false;
}
async function loadSources(): Promise<void> {
  try {
    sources = await client.getSources();
    syncSourceSel();
  } catch {
    /* ignore */
  }
}
sourceSel.addEventListener('change', () => {
  curSource = sourceSel.value;
  void reloadAdd(true);
});

/** Header for the catalog section — one source (dropdown-scoped) or the single source's name. */
function catalogLabel(): string {
  if (curSource !== 'all') return `From ${sources.find((s) => s.instanceId === curSource)?.name ?? 'source'}`;
  return sources.length === 1 ? `From ${sources[0]!.name}` : 'From Apple Music';
}

/** Load the current type into #add-list: your library on top, catalog results below when
    searching. A monotonic token guards against a slower earlier request landing late. */
async function reloadAdd(reset: boolean): Promise<void> {
  if (!reset && addLoading) return; // don't double-fire "Load more"
  const token = ++addToken;
  addLoading = true;
  const q = addQuery;
  if (reset) {
    addOffset = 0;
    addListEl.className = '';
    addListEl.innerHTML = `<div class="empty">Loading…</div>`;
  } else {
    addMoreBtn.textContent = 'Loading…';
  }
  try {
    if (addType === 'album') {
      const res = await client.listLibraryAlbums({
        source: curSource === 'all' ? undefined : curSource,
        search: q || undefined,
        limit: ADD_PAGE,
        offset: addOffset,
      });
      if (token !== addToken) return;
      sources = res.sources;
      syncSourceSel();
      libAlbums = reset ? res.items : [...libAlbums, ...res.items];
      addHasMore = res.hasMore;
      addOffset += res.items.length;
      catAlbums = q ? await client.search(q, curSource) : [];
      if (token !== addToken) return;
    } else {
      let pls = await client.listLibraryPlaylists();
      if (token !== addToken) return;
      if (q) {
        const ql = q.toLowerCase();
        pls = pls.filter((p) => p.name.toLowerCase().includes(ql) || (p.owner ?? '').toLowerCase().includes(ql));
      }
      libPlaylists = pls;
      catPlaylists = q ? await client.searchPlaylists(q) : [];
      if (token !== addToken) return;
    }
    renderAdd();
  } catch {
    if (token === addToken) addListEl.innerHTML = `<div class="empty">Could not load — check the connection.</div>`;
  } finally {
    if (token === addToken) addLoading = false;
    addMoreBtn.textContent = 'Load more';
  }
}

function addSection(title: string, cards: HTMLElement[]): void {
  const sec = document.createElement('div');
  sec.className = 'add-section';
  if (title) {
    const h = document.createElement('div');
    h.className = 'sec-head';
    h.textContent = title;
    sec.appendChild(h);
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  cards.forEach((c) => grid.appendChild(c));
  sec.appendChild(grid);
  addListEl.appendChild(sec);
}

function renderAdd(): void {
  const searching = !!addQuery;
  addListEl.className = '';
  addListEl.innerHTML = '';
  const kind = addType === 'album' ? 'albums' : 'playlists';

  // Browsing (no query): just your library, one flat grid.
  if (!searching) {
    const cards = addType === 'album' ? libAlbums.map(albumCard) : libPlaylists.map(playlistCard);
    if (!cards.length) {
      addListEl.innerHTML = `<div class="empty">No ${kind} in your library yet.</div>`;
      addMoreBtn.hidden = true;
      return;
    }
    addSection('', cards);
    addMoreBtn.hidden = addType !== 'album' || !addHasMore;
    return;
  }

  // Searching: On your shelf (already added, anywhere) → In your library (owned) → From source.
  addMoreBtn.hidden = true;
  if (addType === 'album') {
    const libKeys = new Set(libAlbums.map((a) => taKey(a.title, a.artist)));
    // One row per shelved album — many catalog editions can resolve to the same one.
    const seenId = new Set<string>();
    const onShelf = [
      ...libAlbums.filter((a) => a.onShelf),
      ...catAlbums.filter((a) => a.onShelf && !libKeys.has(taKey(a.title, a.artist))),
    ].filter((a) => {
      const id = 'albumId' in a ? a.albumId : null;
      if (id && seenId.has(id)) return false;
      if (id) seenId.add(id);
      return true;
    });
    const owned = libAlbums.filter((a) => !a.onShelf);
    const catalog = catAlbums.filter((a) => !a.onShelf && !libKeys.has(taKey(a.title, a.artist)));
    if (!onShelf.length && !owned.length && !catalog.length) {
      addListEl.innerHTML = `<div class="empty">No matches.</div>`;
      return;
    }
    if (onShelf.length) addSection('On your shelf', onShelf.map(albumCard));
    if (owned.length) addSection('In your library', owned.map(albumCard));
    if (catalog.length) addSection(catalogLabel(), catalog.map(albumCard));
  } else {
    const uris = new Set(libPlaylists.map((p) => p.providerUri));
    const names = new Set(libPlaylists.map((p) => p.name.toLowerCase()));
    const dup = (p: LibraryPlaylist): boolean => uris.has(p.providerUri) || names.has(p.name.toLowerCase());
    const seenName = new Set<string>();
    const onShelf = [...libPlaylists.filter((p) => p.onShelf), ...catPlaylists.filter((p) => p.onShelf && !dup(p))].filter((p) => {
      const k = p.name.toLowerCase();
      if (seenName.has(k)) return false;
      seenName.add(k);
      return true;
    });
    const owned = libPlaylists.filter((p) => !p.onShelf);
    const catalog = catPlaylists.filter((p) => !p.onShelf && !dup(p));
    if (!onShelf.length && !owned.length && !catalog.length) {
      addListEl.innerHTML = `<div class="empty">No matches.</div>`;
      return;
    }
    if (onShelf.length) addSection('On your shelf', onShelf.map(playlistCard));
    if (owned.length) addSection('In your library', owned.map(playlistCard));
    if (catalog.length) addSection(catalogLabel(), catalog.map(playlistCard));
  }
}

function albumCard(it: LibraryAlbum | SearchAlbum): HTMLElement {
  const albumId = 'albumId' in it ? it.albumId : null;
  const card = document.createElement('div');
  card.className = 'card';
  const srcName = sources.length > 1 ? it.source : '';
  const src = srcName ? ` · ${esc(srcName)}` : '';
  const ex = it.explicit ? ` <span class="ex-badge" title="Explicit">E</span>` : '';
  const ver = it.version && !it.title.toLowerCase().includes(it.version.toLowerCase()) ? ` <span class="ver-tag">${esc(it.version)}</span>` : '';
  card.innerHTML = `
    ${artHtml(it.artworkUrl)}
    <div class="body">
      <div class="meta">
        <div class="t">${esc(it.title)}${ex}${ver}</div>
        <div class="a">${esc(it.artist)}</div>
        <div class="y">${it.year ?? ''}${src}</div>
      </div>
      <div class="card-actions"></div>
    </div>`;
  const actions = card.querySelector('.card-actions') as HTMLElement;
  if (it.onShelf && albumId) {
    // Tapping the art/meta (not the buttons) jumps to the album in All albums.
    const nav = card.querySelector('.art') as HTMLElement;
    const meta = card.querySelector('.meta') as HTMLElement;
    nav.classList.add('tappable');
    meta.classList.add('tappable');
    const go = (): void => void openAlbumInAllShelf(albumId);
    nav.addEventListener('click', go);
    meta.addEventListener('click', go);
    const shelvesBtn = mkBtn('Shelves', 'ghost');
    shelvesBtn.addEventListener('click', (e) => openCratePicker(e.currentTarget as HTMLElement, albumId));
    const rmBtn = mkBtn('Remove', 'ghost');
    rmBtn.addEventListener('click', () => void removeAlbumFromBrowse(it, albumId, card));
    actions.append(shelvesBtn, rmBtn);
  } else if (it.onShelf) {
    const b = mkBtn('On shelf', 'ghost');
    b.disabled = true;
    actions.append(b);
  } else {
    const b = mkBtn('Add', '');
    b.addEventListener('click', () => void addAlbumFromBrowse(it, card, b));
    actions.append(b);
  }
  return card;
}

/** Jump from an Add-tab album to that album inside the All-albums shelf, and flash it. */
async function openAlbumInAllShelf(albumId: string): Promise<void> {
  switchTab('shelves');
  await openShelf('all', 'All albums');
  const card = shelfListEl.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(albumId)}"]`);
  if (card) {
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1600);
  }
}

async function addAlbumFromBrowse(it: LibraryAlbum | SearchAlbum, card: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Adding…';
  card.classList.add('busy');
  try {
    const r = await client.addToShelf({ providerUri: it.providerUri });
    it.onShelf = true;
    if ('albumId' in it) it.albumId = r.albumId;
    showToast(`Added ${it.title}`);
    renderAdd();
    void loadShelvesIndex();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Add';
    showToast(`Failed: ${(e as Error).message}`);
  } finally {
    card.classList.remove('busy');
  }
}

async function removeAlbumFromBrowse(it: LibraryAlbum | SearchAlbum, albumId: string, card: HTMLElement): Promise<void> {
  card.classList.add('busy');
  try {
    await client.removeFromShelf(albumId);
    it.onShelf = false;
    if ('albumId' in it) it.albumId = null;
    showToast(`Removed ${it.title}`);
    renderAdd();
    void loadShelvesIndex();
  } catch (e) {
    showToast(`Failed: ${(e as Error).message}`);
  } finally {
    card.classList.remove('busy');
  }
}

function playlistCard(p: LibraryPlaylist): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    ${artHtml(p.artworkUrl)}
    <div class="body">
      <div class="meta">
        <div class="t">${esc(p.name)}</div>
        <div class="a">${esc(p.owner ?? 'Playlist')}</div>
      </div>
      <div class="card-actions"></div>
    </div>`;
  const actions = card.querySelector('.card-actions') as HTMLElement;
  if (p.onShelf) {
    const b = mkBtn('Added', 'ghost');
    b.disabled = true;
    actions.append(b);
  } else {
    const b = mkBtn('Add', '');
    b.addEventListener('click', () => void addPlaylistToShelf(p, card, b));
    actions.append(b);
  }
  return card;
}

async function addPlaylistToShelf(p: LibraryPlaylist, card: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Adding…';
  card.classList.add('busy');
  try {
    await client.addPlaylist(p.providerUri);
    p.onShelf = true;
    showToast(`Added ${p.name}`);
    renderAdd();
    void loadShelvesIndex();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Add';
    showToast(`Failed: ${(e as Error).message}`);
  } finally {
    card.classList.remove('busy');
  }
}

async function importAll(): Promise<void> {
  const where =
    curSource !== 'all' ? (sources.find((s) => s.instanceId === curSource)?.name ?? 'this source') : 'your library';
  if (!confirm(`Add every album in ${where} to Crate? Albums already added are skipped.`)) return;
  const orig = importBtn.textContent;
  importBtn.disabled = true;
  importBtn.textContent = 'Adding…';
  try {
    const r = await client.importLibrary(curSource === 'all' ? undefined : curSource);
    showToast(`Added ${r.added}, skipped ${r.skipped} of ${r.total}`);
    await reloadAdd(true);
    void loadShelvesIndex();
  } catch (e) {
    showToast(`Import failed: ${(e as Error).message}`);
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = orig;
  }
}

const addClearBtn = document.getElementById('add-clear') as HTMLButtonElement;
let addSearchTimer: ReturnType<typeof setTimeout> | undefined;
addSearchInput.addEventListener('input', () => {
  addClearBtn.hidden = !addSearchInput.value;
  clearTimeout(addSearchTimer);
  addSearchTimer = setTimeout(() => {
    addQuery = addSearchInput.value.trim();
    void reloadAdd(true);
  }, 300);
});
addClearBtn.addEventListener('click', () => {
  addSearchInput.value = '';
  addClearBtn.hidden = true;
  addQuery = '';
  addSearchInput.focus();
  void reloadAdd(true);
});
importBtn.addEventListener('click', () => void importAll());
addMoreBtn.addEventListener('click', () => void reloadAdd(false));

/* ================= Shelves — index ================= */
const shelvesIndexEl = document.getElementById('shelves-index') as HTMLElement;
const shelvesListEl = document.getElementById('shelves-list') as HTMLElement;
const shelfDetailEl = document.getElementById('shelf-detail') as HTMLElement;
const crateForm = document.getElementById('crate-form') as HTMLFormElement;
const crateNameInput = document.getElementById('crate-name') as HTMLInputElement;

function albumCrates(): Shelf[] {
  return shelves.filter((s) => s.kind === 'album' && s.id !== 'all');
}

async function loadShelvesIndex(): Promise<void> {
  try {
    const [res, pl] = [await client.getShelf(), await client.getShelf('playlists').catch(() => ({ items: [] }))];
    shelves = res.shelves;
    libraryCount = res.items.length;
    playlistCount = pl.items.length;
    if (openShelfId === 'all') detailItems = res.items; // keep the open All detail fresh
    if (openShelfId === 'playlists') detailItems = pl.items;
  } catch {
    shelvesListEl.innerHTML = `<div class="empty">Could not reach the device service.</div>`;
    return;
  }
  crateMembers.clear();
  playlistSongCounts.clear();
  await Promise.all([
    ...albumCrates().map(async (c) => {
      try {
        const m = await client.getShelf(c.id);
        crateMembers.set(c.id, new Set(m.items.map((i) => i.albumId)));
      } catch {
        crateMembers.set(c.id, new Set());
      }
    }),
    ...shelves
      .filter((s) => s.kind === 'playlist' && s.id !== 'playlists')
      .map(async (s) => {
        try {
          playlistSongCounts.set(s.id, (await client.getShelf(s.id)).items.length);
        } catch {
          playlistSongCounts.set(s.id, 0);
        }
      }),
  ]);
  renderShelvesIndex();
  if (openShelfId) renderShelfDetail();
}

function renderShelvesIndex(): void {
  shelvesListEl.innerHTML = '';
  if (addType === 'playlist') {
    crateForm.hidden = true; // playlist shelves are created by opening a playlist, not named here
    shelvesListEl.appendChild(shelfRow('playlists', 'All Playlists', playlistCount, true, 'playlist'));
    // Each opened playlist is its own shelf (of songs), like on the wall.
    for (const s of shelves.filter((x) => x.kind === 'playlist' && x.id !== 'playlists')) {
      shelvesListEl.appendChild(playlistShelfRow(s));
    }
    return;
  }
  crateForm.hidden = false;
  // "All albums" is just the default shelf, shown first.
  shelvesListEl.appendChild(shelfRow('all', 'All albums', libraryCount, true, 'album'));
  for (const c of albumCrates()) {
    shelvesListEl.appendChild(shelfRow(c.id, c.name, crateMembers.get(c.id)?.size ?? 0, false, 'album'));
  }
}

function shelfRow(id: string, name: string, count: number, isDefault: boolean, unit: 'album' | 'playlist'): HTMLElement {
  const row = document.createElement('button');
  row.className = 'shelf-row' + (isDefault ? ' default' : '');
  row.innerHTML =
    `<span class="sh-name">${esc(name)}</span>` +
    `<span class="sh-n">${count} ${unit}${count === 1 ? '' : 's'}</span>` +
    (isDefault ? '' : `<span class="sh-del" role="button" aria-label="Delete shelf">✕</span>`) +
    `<span class="sh-chev">›</span>`;
  row.addEventListener('click', () => void openShelf(id, name));
  const del = row.querySelector('.sh-del');
  if (del)
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteCrate(id, name);
    });
  return row;
}

async function deleteCrate(id: string, name: string): Promise<void> {
  if (!confirm(`Delete shelf "${name}"? Its albums stay in your library.`)) return;
  await client.deleteShelf(id).catch(() => {});
  await loadShelvesIndex();
  showToast('Shelf deleted');
}

/** A named playlist shelf row (a single playlist's songs) — opens to its songs, deletable. */
function playlistShelfRow(s: Shelf): HTMLElement {
  const row = document.createElement('button');
  row.className = 'shelf-row';
  const n = playlistSongCounts.get(s.id);
  row.innerHTML =
    `<span class="sh-name">${esc(s.name)}</span>` +
    `<span class="sh-n">${n == null ? '…' : `${n} song${n === 1 ? '' : 's'}`}</span>` +
    `<span class="sh-del" role="button" aria-label="Remove playlist shelf">✕</span>` +
    `<span class="sh-chev">›</span>`;
  row.addEventListener('click', () => void openSongShelf(s.id, s.name));
  row.querySelector('.sh-del')!.addEventListener('click', (e) => {
    e.stopPropagation();
    void deletePlaylistShelf(s.id, s.name);
  });
  return row;
}

async function deletePlaylistShelf(id: string, name: string): Promise<void> {
  if (!confirm(`Remove the "${name}" playlist shelf? The playlist stays in All Playlists.`)) return;
  await client.deleteShelf(id).catch(() => {});
  await loadShelvesIndex();
  showToast('Playlist shelf removed');
}

crateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = crateNameInput.value.trim();
  if (!name) return;
  await client.createShelf({ name, kind: 'album' }).catch(() => {});
  crateNameInput.value = '';
  await loadShelvesIndex();
  showToast('Shelf created');
});

/* ================= Shelves — detail ================= */
const shelfDetailName = document.getElementById('shelf-detail-name') as HTMLElement;
const shelfDetailCount = document.getElementById('shelf-detail-count') as HTMLElement;
const shelfListEl = document.getElementById('shelf-list') as HTMLElement;
const shelfSortSel = document.getElementById('shelf-sort') as HTMLSelectElement;
const viewListBtn = document.getElementById('view-list') as HTMLButtonElement;
const viewTileBtn = document.getElementById('view-tile') as HTMLButtonElement;
(document.getElementById('shelf-back') as HTMLElement).addEventListener('click', backToIndex);

function backToIndex(): void {
  openShelfId = null;
  shelfDetailEl.hidden = true;
  playlistSongsEl.hidden = true;
  shelvesIndexEl.hidden = false;
}

/* ---------- A single playlist's songs (read-only) ---------- */
const playlistSongsEl = document.getElementById('playlist-songs') as HTMLElement;
const songsNameEl = document.getElementById('songs-name') as HTMLElement;
const songsCountEl = document.getElementById('songs-count') as HTMLElement;
const songsListEl = document.getElementById('songs-list') as HTMLElement;
const songsBackEl = document.getElementById('songs-back') as HTMLElement;
let songsBackTo: 'index' | 'detail' = 'index';
songsBackEl.addEventListener('click', () => {
  playlistSongsEl.hidden = true;
  if (songsBackTo === 'detail') shelfDetailEl.hidden = false;
  else shelvesIndexEl.hidden = false;
});

let openSongShelfId: string | null = null;

function showSongsView(name: string, from: 'index' | 'detail'): void {
  songsBackTo = from;
  songsBackEl.textContent = from === 'detail' ? '‹ All Playlists' : '‹ Playlists';
  shelfDetailEl.hidden = true;
  if (from !== 'detail') shelvesIndexEl.hidden = true;
  playlistSongsEl.hidden = false;
  songsNameEl.textContent = name;
  songsCountEl.textContent = '';
  songsListEl.innerHTML = `<div class="empty">Loading songs…</div>`;
}

/** A playlist shelf's songs — drag to reorder, ✕ to remove (both Crate-local, per shelf). */
async function openSongShelf(shelfId: string, name: string, from: 'index' | 'detail' = 'index'): Promise<void> {
  openSongShelfId = shelfId;
  showSongsView(name, from);
  try {
    const items = (await client.getShelf(shelfId)).items;
    renderSongs(items);
  } catch {
    songsListEl.innerHTML = `<div class="empty">Could not load songs.</div>`;
  }
}

/** Opening a playlist (from All Playlists) reuses or creates its own song shelf, like the wall. */
async function openPlaylistAsShelf(mediaId: string, name: string): Promise<void> {
  let sh = shelves.find((s) => s.kind === 'playlist' && s.id !== 'playlists' && s.name === name);
  if (!sh) {
    const created = await client.createShelf({ name, kind: 'playlist' }).catch(() => null);
    if (!created) {
      showToast('Could not open playlist');
      return;
    }
    await client.addAlbumToShelf(created.id, mediaId).catch(() => {});
    shelves.push(created);
    sh = created;
    void loadShelvesIndex();
  }
  await openSongShelf(sh.id, name, 'detail');
}

function renumberSongs(): void {
  songsListEl.querySelectorAll<HTMLElement>('.song-row .song-n').forEach((n, i) => (n.textContent = String(i + 1)));
  songsCountEl.textContent = `${songsListEl.querySelectorAll('.song-row').length} songs`;
}

function renderSongs(items: ShelfItem[]): void {
  songsCountEl.textContent = `${items.length} song${items.length === 1 ? '' : 's'}`;
  if (!items.length) {
    songsListEl.innerHTML = `<div class="empty">No songs.</div>`;
    return;
  }
  songsListEl.innerHTML = '';
  items.forEach((it, i) => {
    const uri = it.albumUri ?? ''; // song spines carry the track uri here
    const row = document.createElement('div');
    row.className = 'song-row';
    row.dataset['uri'] = uri;
    if (uri) row.draggable = true;
    row.innerHTML =
      `<span class="drag-handle">⠿</span>` +
      `<span class="song-n">${i + 1}</span>` +
      `<span class="song-meta"><span class="song-t">${esc(it.title)}</span><span class="song-a">${esc(it.artist || '')}</span></span>` +
      `<button class="song-rm" aria-label="Remove song">✕</button>`;
    if (uri) {
      row.addEventListener('dragstart', () => row.classList.add('dragging'));
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        void saveSongOrder();
      });
    }
    row.querySelector('.song-rm')!.addEventListener('click', () => void removeSong(uri, row));
    songsListEl.appendChild(row);
  });
}

songsListEl.addEventListener('dragover', (e) => {
  const dragging = songsListEl.querySelector<HTMLElement>('.song-row.dragging');
  if (!dragging) return;
  e.preventDefault();
  const rows = [...songsListEl.querySelectorAll<HTMLElement>('.song-row:not(.dragging)')];
  let after: HTMLElement | null = null;
  let closest = -Infinity;
  for (const r of rows) {
    const box = r.getBoundingClientRect();
    const offset = e.clientY - box.top - box.height / 2;
    if (offset < 0 && offset > closest) {
      closest = offset;
      after = r;
    }
  }
  if (after == null) songsListEl.appendChild(dragging);
  else songsListEl.insertBefore(dragging, after);
});

async function saveSongOrder(): Promise<void> {
  if (!openSongShelfId) return;
  const uris = [...songsListEl.querySelectorAll<HTMLElement>('.song-row')].map((r) => r.dataset['uri']!).filter(Boolean);
  renumberSongs();
  await client.reorderPlaylistSongs(openSongShelfId, uris).catch(() => {});
  showToast('Song order saved');
}

async function removeSong(uri: string, row: HTMLElement): Promise<void> {
  if (!openSongShelfId || !uri) return;
  await client.hidePlaylistSong(openSongShelfId, uri, true).catch(() => {});
  row.remove();
  renumberSongs();
  showToast('Song removed');
}

const shelfFilterInput = document.getElementById('shelf-filter') as HTMLInputElement;
let shelfFilterTimer: ReturnType<typeof setTimeout> | undefined;
shelfFilterInput.addEventListener('input', () => {
  clearTimeout(shelfFilterTimer);
  shelfFilterTimer = setTimeout(() => {
    shelfFilter = shelfFilterInput.value.trim();
    renderShelfDetail();
  }, 200);
});

async function openShelf(id: string, name: string): Promise<void> {
  openShelfId = id;
  openShelfName = name;
  shelfFilter = '';
  shelfFilterInput.value = '';
  shelvesIndexEl.hidden = true;
  shelfDetailEl.hidden = false;
  shelfDetailName.textContent = name;
  // restore this shelf's saved sort/view
  shelfSortSel.value = sortByShelf.get(id) ?? 'custom';
  const view = viewByShelf.get(id) ?? 'tile';
  viewListBtn.classList.toggle('on', view === 'list');
  viewTileBtn.classList.toggle('on', view === 'tile');
  shelfListEl.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    detailItems = (await client.getShelf(id === 'all' ? undefined : id)).items;
  } catch {
    shelfListEl.innerHTML = `<div class="empty">Could not load this shelf.</div>`;
    return;
  }
  renderShelfDetail();
}

function sortedDetail(): ShelfItem[] {
  const sort = sortByShelf.get(openShelfId ?? '') ?? 'custom';
  let base = detailItems;
  if (shelfFilter) {
    const q = shelfFilter.toLowerCase();
    base = base.filter((it) => it.title.toLowerCase().includes(q) || it.artist.toLowerCase().includes(q));
  }
  if (sort === 'custom') return [...base]; // as fetched = the saved manual order
  const s = [...base];
  s.sort((a, b) => {
    if (sort === 'artist') return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'year') return (b.year ?? 0) - (a.year ?? 0);
    return (b.addedAt || '').localeCompare(a.addedAt || ''); // added: newest first
  });
  return s;
}

function renderShelfDetail(): void {
  if (!openShelfId) return;
  const playlists = openShelfId === 'playlists';
  const unit = playlists ? 'playlist' : 'album';
  const view = viewByShelf.get(openShelfId) ?? 'tile';
  const sort = sortByShelf.get(openShelfId) ?? 'custom';
  shelfDetailCount.textContent = `${detailItems.length} ${unit}${detailItems.length === 1 ? '' : 's'}`;
  shelfListEl.className = view === 'list' ? 'list' : 'grid';
  if (detailItems.length === 0) {
    const msg = playlists
      ? 'No playlists yet — add them from Add › Playlists.'
      : openShelfId === 'all'
        ? 'Nothing on the shelf yet — add albums from Add.'
        : 'No albums in this shelf yet — add them from All albums.';
    shelfListEl.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  const rows = sortedDetail();
  if (rows.length === 0) {
    shelfListEl.innerHTML = `<div class="empty">No ${unit}s match “${esc(shelfFilter)}”.</div>`;
    return;
  }
  shelfListEl.innerHTML = '';
  // Drag-reorder the custom-ordered, unfiltered list (albums in a shelf, or playlists in All
  // Playlists — both persist via reorderShelf).
  const draggable = sort === 'custom' && !shelfFilter;
  shelfListEl.classList.toggle('draggable', draggable);
  for (const it of rows) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset['id'] = it.albumId;
    if (draggable) {
      card.draggable = true;
      card.addEventListener('dragstart', () => card.classList.add('dragging'));
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        void saveShelfOrder();
      });
    }
    if (playlists) {
      card.innerHTML = `
        ${artHtml(it.artworkUrl)}
        <div class="body">
          <div class="meta">
            <div class="t">${esc(it.title)}</div>
            <div class="a">${esc(it.artist)}</div>
          </div>
          <div class="card-actions">
            <button class="ghost edit-btn">Edit</button>
            <button class="ghost rm-btn">Remove</button>
          </div>
        </div>`;
      const nav = (): void => void openPlaylistAsShelf(it.albumId, it.title);
      const art = card.querySelector('.art') as HTMLElement;
      const meta = card.querySelector('.meta') as HTMLElement;
      art.classList.add('tappable');
      meta.classList.add('tappable');
      art.addEventListener('click', nav);
      meta.addEventListener('click', nav);
      card.querySelector('.edit-btn')!.addEventListener('click', () => void openEditor(it));
      card.querySelector('.rm-btn')!.addEventListener('click', () => void removeFromDetail(it.albumId));
    } else {
      card.innerHTML = `
        ${artHtml(it.artworkUrl)}
        <div class="body">
          <div class="meta">
            <div class="t">${esc(it.title)}</div>
            <div class="a">${esc(it.artist)}</div>
            <div class="y">${it.year ?? ''}</div>
          </div>
          <div class="card-actions">
            <button class="ghost crate-btn">Shelves</button>
            <button class="ghost edit-btn">Edit</button>
            <button class="ghost rm-btn">${openShelfId === 'all' ? 'Remove' : 'Take out'}</button>
          </div>
        </div>`;
      card.querySelector('.crate-btn')!.addEventListener('click', (e) => openCratePicker(e.currentTarget as HTMLElement, it.albumId));
      card.querySelector('.edit-btn')!.addEventListener('click', () => void openEditor(it));
      card.querySelector('.rm-btn')!.addEventListener('click', () => void removeFromDetail(it.albumId));
    }
    shelfListEl.appendChild(card);
  }
}

async function removeFromDetail(albumId: string): Promise<void> {
  const fromLibrary = openShelfId === 'all' || openShelfId === 'playlists';
  try {
    if (fromLibrary) await client.removeFromShelf(albumId);
    else if (openShelfId) await client.removeAlbumFromShelf(openShelfId, albumId);
    detailItems = detailItems.filter((it) => it.albumId !== albumId);
    renderShelfDetail();
    showToast(openShelfId === 'playlists' ? 'Removed playlist' : fromLibrary ? 'Removed from library' : 'Taken out of shelf');
    void loadShelvesIndex();
  } catch (e) {
    showToast(`Failed: ${(e as Error).message}`);
  }
}

shelfSortSel.addEventListener('change', () => {
  if (!openShelfId) return;
  sortByShelf.set(openShelfId, shelfSortSel.value as ShelfSort);
  renderShelfDetail();
});
viewListBtn.addEventListener('click', () => {
  if (!openShelfId) return;
  viewByShelf.set(openShelfId, 'list');
  viewListBtn.classList.add('on');
  viewTileBtn.classList.remove('on');
  renderShelfDetail();
});
viewTileBtn.addEventListener('click', () => {
  if (!openShelfId) return;
  viewByShelf.set(openShelfId, 'tile');
  viewTileBtn.classList.add('on');
  viewListBtn.classList.remove('on');
  renderShelfDetail();
});

/* Drag-to-reorder within the open shelf (Custom sort). */
function dragAfter(container: HTMLElement, y: number): HTMLElement | null {
  const cards = [...container.querySelectorAll<HTMLElement>('.card:not(.dragging)')];
  let closest: { offset: number; el: HTMLElement | null } = { offset: -Infinity, el: null };
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}
shelfListEl.addEventListener('dragover', (e) => {
  if ((sortByShelf.get(openShelfId ?? '') ?? 'custom') !== 'custom') return;
  e.preventDefault();
  const dragging = shelfListEl.querySelector<HTMLElement>('.dragging');
  if (!dragging) return;
  const after = dragAfter(shelfListEl, e.clientY);
  if (after == null) shelfListEl.appendChild(dragging);
  else shelfListEl.insertBefore(dragging, after);
});
async function saveShelfOrder(): Promise<void> {
  const ids = [...shelfListEl.querySelectorAll<HTMLElement>('.card')].map((c) => c.dataset['id']!).filter(Boolean);
  const byId = new Map(detailItems.map((it) => [it.albumId, it]));
  detailItems = ids.map((id) => byId.get(id)).filter((x): x is ShelfItem => !!x);
  await client.reorderShelf(ids, openShelfId === 'all' ? undefined : openShelfId ?? undefined).catch(() => {});
  showToast('Order saved');
}

/* ================= Per-album crate assignment (floating checklist) ================= */
let activeCrateMenu: HTMLElement | null = null;
function closeCrateMenu(): void {
  if (!activeCrateMenu) return;
  document.removeEventListener('pointerdown', onCrateOutside, true);
  activeCrateMenu.remove();
  activeCrateMenu = null;
}
function onCrateOutside(e: Event): void {
  if (activeCrateMenu && !activeCrateMenu.contains(e.target as Node)) closeCrateMenu();
}
function openCratePicker(anchor: HTMLElement, albumId: string): void {
  closeCrateMenu();
  const crates = albumCrates();
  const menu = document.createElement('div');
  menu.className = 'crate-menu';
  if (!crates.length) menu.innerHTML = `<div class="empty">No shelves yet — create one in Shelves.</div>`;
  for (const c of crates) {
    const on = crateMembers.get(c.id)?.has(albumId) ?? false;
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span>${esc(c.name)}</span>`;
    const cb = label.querySelector('input') as HTMLInputElement;
    cb.addEventListener('change', async () => {
      const set = crateMembers.get(c.id) ?? new Set<string>();
      if (cb.checked) {
        await client.addAlbumToShelf(c.id, albumId).catch(() => {});
        set.add(albumId);
      } else {
        await client.removeAlbumFromShelf(c.id, albumId).catch(() => {});
        set.delete(albumId);
      }
      crateMembers.set(c.id, set);
      renderShelvesIndex();
      // If we're viewing that shelf, drop the row live when unchecked.
      if (openShelfId === c.id && !cb.checked) {
        detailItems = detailItems.filter((x) => x.albumId !== albumId);
        renderShelfDetail();
      }
    });
    menu.appendChild(label);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  const top = r.bottom + 6;
  menu.style.top = `${Math.min(top, window.innerHeight - menu.offsetHeight - 8)}px`;
  activeCrateMenu = menu;
  setTimeout(() => document.addEventListener('pointerdown', onCrateOutside, true), 0);
}

/* ================= Per-album spine override editor ================= */
const editorEl = document.getElementById('editor') as HTMLElement;
const editorTitle = document.getElementById('editor-title') as HTMLElement;
const ovCover = document.getElementById('ov-cover') as HTMLInputElement;
const ovSpine = document.getElementById('ov-spine') as HTMLInputElement;
const ovFont = document.getElementById('ov-font') as HTMLSelectElement;
const ovTracking = document.getElementById('ov-tracking') as HTMLInputElement;
const ovArtistOn = document.getElementById('ov-artist-on') as HTMLInputElement;
const ovArtist = document.getElementById('ov-artist') as HTMLInputElement;
const ovTitleOn = document.getElementById('ov-title-on') as HTMLInputElement;
const ovTitle = document.getElementById('ov-title') as HTMLInputElement;
const ovSpineMode = document.getElementById('ov-spinemode') as HTMLSelectElement;
const ovLayout = document.getElementById('ov-layout') as HTMLSelectElement;
const ovInkSize = document.getElementById('ov-inksize') as HTMLSelectElement;
const ovInkWeight = document.getElementById('ov-inkweight') as HTMLSelectElement;
const ovYear = document.getElementById('ov-year') as HTMLSelectElement;
const saveBtn = document.getElementById('editor-save') as HTMLButtonElement;
let editingId: string | null = null;

async function openEditor(it: ShelfItem): Promise<void> {
  editingId = it.albumId;
  editorTitle.textContent = `${it.artist} — ${it.title}`;
  ovCover.value = '';
  ovSpine.value = '';
  ovFont.value = '';
  ovTracking.value = '';
  ovArtistOn.checked = false;
  ovTitleOn.checked = false;
  ovSpineMode.value = '';
  ovLayout.value = '';
  ovInkSize.value = '';
  ovInkWeight.value = '';
  ovYear.value = '';
  try {
    const ov = (await client.getAlbum(it.albumId)).override;
    ovFont.value = ov.font ?? '';
    ovTracking.value = ov.tracking ?? '';
    ovSpineMode.value = ov.spineMode ?? '';
    ovLayout.value = ov.layout ?? '';
    ovInkSize.value = ov.size ?? '';
    ovInkWeight.value = ov.weight ?? '';
    ovYear.value = ov.yearDisplay ?? '';
    if (ov.artistColor) {
      ovArtistOn.checked = true;
      ovArtist.value = ov.artistColor;
    }
    if (ov.titleColor) {
      ovTitleOn.checked = true;
      ovTitle.value = ov.titleColor;
    }
  } catch {
    /* no existing override */
  }
  editorEl.hidden = false;
}

function closeEditor(): void {
  editorEl.hidden = true;
  editingId = null;
}

async function saveEditor(): Promise<void> {
  const id = editingId;
  if (!id) return;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const cover = ovCover.files?.[0];
    const spine = ovSpine.files?.[0];
    if (cover) await client.uploadArt(id, 'cover', cover);
    if (spine) await client.uploadArt(id, 'spine', spine);
    await client.putOverride(id, {
      font: ovFont.value || null,
      tracking: ovTracking.value.trim() || null,
      artistColor: ovArtistOn.checked ? ovArtist.value : null,
      titleColor: ovTitleOn.checked ? ovTitle.value : null,
      spineMode: (ovSpineMode.value || null) as OverrideRequest['spineMode'],
      layout: (ovLayout.value || null) as OverrideRequest['layout'],
      size: (ovInkSize.value || null) as OverrideRequest['size'],
      weight: (ovInkWeight.value || null) as OverrideRequest['weight'],
      yearDisplay: (ovYear.value || null) as OverrideRequest['yearDisplay'],
    });
    showToast('Saved');
    closeEditor();
    if (openShelfId) await openShelf(openShelfId, openShelfName);
  } catch (e) {
    showToast(`Failed: ${(e as Error).message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save spine';
  }
}

(document.getElementById('editor-close') as HTMLElement).onclick = closeEditor;
saveBtn.onclick = () => void saveEditor();
editorEl.addEventListener('click', (e) => {
  if (e.target === editorEl) closeEditor();
});

/* ================= Settings (mirrors the wall's on-screen Settings) ================= */
const defaultSpeakerSel = document.getElementById('default-speaker') as HTMLSelectElement;
const SETTING_SELECTS: Array<[keyof Settings, string, Array<[string, string]>]> = [
  ['spineMode', 'Spine art', [['scan', 'Real when available'], ['art', 'Generated']]],
  ['spineThickness', 'CD thickness', [['thin', 'Thin'], ['medium', 'Medium'], ['thick', 'Thick']]],
  ['spineWidthMode', 'Spine width', [['uniform', 'Uniform'], ['duration', 'By length']]],
  ['spineTextDir', 'Text direction', [['ttb', 'Top → bottom'], ['btt', 'Bottom → top']]],
  ['inkMode', 'Label ink', [['contrast', 'Contrast'], ['match', 'Match accent']]],
  ['inkSize', 'Label size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]],
  ['inkWeight', 'Label weight', [['light', 'Light'], ['regular', 'Regular'], ['bold', 'Bold']]],
  ['labelLayout', 'Label layout', [['split', 'Split'], ['center', 'Centered'], ['top', 'Top'], ['bottom', 'Bottom'], ['varied', 'Varied']]],
  ['labelVary', 'Typography', [['uniform', 'Uniform'], ['varied', 'Varied']]],
  ['glowEnabled', 'Album glow', [['true', 'On'], ['false', 'Off']]],
  ['glowRadius', 'Glow radius', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]],
  ['glowIntensity', 'Glow intensity', [['soft', 'Soft'], ['medium', 'Medium'], ['bold', 'Bold']]],
  ['yearDisplay', 'Album year', [['off', 'Off'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal']]],
  ['yearPos', 'Year position', [['top', 'Top'], ['bottom', 'Bottom']]],
  ['yearEmphasis', 'Year emphasis', [['thin', 'Thin'], ['bold', 'Bold']]],
  ['openMode', 'Opening an album', [['cover', 'Cover only'], ['card', 'Full card']]],
  ['afterPlay', 'After playing', [['close', 'Close'], ['linger', 'Linger'], ['stay', 'Stay open']]],
  ['idleScreen', 'When idle — screen', [['on', 'Stay on'], ['dim', 'Dim'], ['off', 'Screen off']]],
  ['idleContent', 'When idle — show', [['nothing', 'Nothing'], ['nowPlaying', 'Now playing'], ['currentShelf', 'Current shelf'], ['shelf', 'A shelf'], ['autoOpen', 'Auto-open']]],
  ['autoOpenPool', 'Auto-open from', [['all', 'All albums'], ['current', 'Current shelf'], ['shelf', 'A specific shelf']]],
];
const SETTING_NUMBERS: Array<[keyof Settings, string, number, number]> = [
  ['afterPlayLingerSec', 'Linger seconds', 1, 60],
  ['longPressMs', 'Long-press (ms)', 100, 1500],
  ['idleAfterMin', 'Go idle after (min, 0=never)', 0, 240],
  ['idleDimPercent', 'Idle dim brightness (%)', 1, 100],
  ['autoOpenEverySec', 'Auto-open every (sec)', 5, 300],
];
const SETTING_TOGGLES: Array<[keyof Settings, string]> = [
  ['openOnExternalPlay', 'Open album on outside playback'],
  ['autoOpenRandom', 'Auto-open in random order'],
  ['idleUseSensor', 'Idle from proximity sensor (needs sensor)'],
  ['wakeOnSensor', 'Wake from proximity sensor (needs sensor)'],
  ['autoBrightness', 'Auto-brightness from ambient light (needs sensor)'],
];
// Settings persisted as booleans but edited via a two-option select.
const BOOL_SELECTS = new Set<keyof Settings>(['glowEnabled']);

async function loadSettingsPanel(): Promise<void> {
  try {
    const [players, s] = [await client.getPlayers(), await client.getSettings()];
    settings = s;
    defaultSpeakerSel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '(auto — first available)';
    defaultSpeakerSel.appendChild(auto);
    for (const p of players.players) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.available ? p.name : `${p.name} (offline)`;
      if (s.defaultPlayerId === p.id) o.selected = true;
      defaultSpeakerSel.appendChild(o);
    }
    renderSettingsForm();
  } catch {
    defaultSpeakerSel.innerHTML = '<option>Could not load players</option>';
  }
}

function renderSettingsForm(): void {
  const formEl = document.getElementById('settings-form') as HTMLElement;
  if (!settings) return;
  formEl.innerHTML = '';
  for (const [key, label, opts] of SETTING_SELECTS) {
    const field = document.createElement('div');
    field.className = 'field';
    const sel = document.createElement('select');
    for (const [v, l] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      if (String(settings![key]) === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const val = BOOL_SELECTS.has(key) ? (sel.value === 'true') : sel.value;
      void saveSetting(key, val as Settings[typeof key]);
    });
    field.innerHTML = `<label>${label}</label>`;
    field.appendChild(sel);
    formEl.appendChild(field);
  }
  for (const [key, label, min, max] of SETTING_NUMBERS) {
    const field = document.createElement('div');
    field.className = 'field';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = String(min);
    inp.max = String(max);
    inp.value = String(settings![key]);
    inp.addEventListener('change', () => void saveSetting(key, Math.max(min, Math.min(max, Number(inp.value))) as Settings[typeof key]));
    field.innerHTML = `<label>${label}</label>`;
    field.appendChild(inp);
    formEl.appendChild(field);
  }
  // Idle shelf (for content 'A shelf' and auto-open 'A specific shelf').
  const isf = document.createElement('div');
  isf.className = 'field';
  const issel = document.createElement('select');
  const optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = 'All';
  if (!settings.idleShelf) optAll.selected = true;
  issel.appendChild(optAll);
  for (const sh of shelves.filter((s) => s.id !== 'all')) {
    const o = document.createElement('option');
    o.value = sh.id;
    o.textContent = sh.name;
    if (settings.idleShelf === sh.id) o.selected = true;
    issel.appendChild(o);
  }
  issel.addEventListener('change', () => void saveSetting('idleShelf', issel.value || null));
  isf.innerHTML = '<label>Idle / auto-open shelf</label>';
  isf.appendChild(issel);
  formEl.appendChild(isf);
  // Toggles
  for (const [key, label] of SETTING_TOGGLES) {
    const tf = document.createElement('div');
    tf.className = 'field field-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings[key];
    cb.addEventListener('change', () => void saveSetting(key, cb.checked as Settings[typeof key]));
    const lab = document.createElement('label');
    lab.appendChild(cb);
    lab.append(' ' + label);
    tf.appendChild(lab);
    formEl.appendChild(tf);
  }
  renderSchedule();
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function renderSchedule(): void {
  const el = document.getElementById('schedule-editor');
  if (!el || !settings) return;
  el.innerHTML = '<h3 class="sched-h">Sleep schedule <span class="hint">(screen off; touch wakes it briefly)</span></h3>';
  DAYS.forEach((name, i) => {
    const day = settings!.sleepSchedule?.[i] ?? { on: false, sleep: '23:00', wake: '07:00' };
    const row = document.createElement('div');
    row.className = 'sched-row';
    row.innerHTML =
      `<label class="sched-day"><input type="checkbox" ${day.on ? 'checked' : ''}> ${name}</label>` +
      `<span class="sched-t">sleep <input type="time" class="sched-sleep" value="${day.sleep}"></span>` +
      `<span class="sched-t">wake <input type="time" class="sched-wake" value="${day.wake}"></span>`;
    const save = (): void => {
      const on = (row.querySelector('.sched-day input') as HTMLInputElement).checked;
      const sleep = (row.querySelector('.sched-sleep') as HTMLInputElement).value || '23:00';
      const wake = (row.querySelector('.sched-wake') as HTMLInputElement).value || '07:00';
      const next = [...(settings!.sleepSchedule ?? DAYS.map(() => ({ on: false, sleep: '23:00', wake: '07:00' })))];
      next[i] = { on, sleep, wake };
      void saveSetting('sleepSchedule', next);
    };
    row.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', save));
    el.appendChild(row);
  });
}

async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  if (settings) settings[key] = value;
  await client.putSettings({ [key]: value } as Partial<Settings>).catch(() => {});
  showToast('Saved');
}

defaultSpeakerSel.addEventListener('change', async () => {
  await client.putSettings({ defaultPlayerId: defaultSpeakerSel.value || null }).catch(() => {});
  showToast('Default speaker saved');
});

/* ================= Init ================= */
// Crate mark, top-right of each main tab header.
document.querySelectorAll<HTMLImageElement>('img[data-logo]').forEach((img) => (img.src = crateMarkMono));
void loadSources();
updateAddToolbar();
setContentType('album'); // seeds Add + Shelves for the shared Albums/Playlists choice
void loadShelvesIndex();
void loadSettingsPanel();
