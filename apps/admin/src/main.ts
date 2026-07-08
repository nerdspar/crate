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
function setAddType(type: AddType): void {
  addType = type;
  document.querySelectorAll<HTMLElement>('#add-type .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset['type'] === type));
  updateAddToolbar();
  void reloadAdd(true);
}
document.querySelectorAll<HTMLElement>('#add-type .seg-btn').forEach((b) => b.addEventListener('click', () => setAddType(b.dataset['type'] as AddType)));

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
      if (q) {
        const cat = await client.search(q, curSource);
        if (token !== addToken) return;
        // Only drop catalog hits that duplicate a library-section row; keep already-shelved
        // ones (they show "On shelf") so an album you own never silently vanishes from search.
        const libKeys = new Set(libAlbums.map((a) => taKey(a.title, a.artist)));
        catAlbums = cat.filter((a) => !libKeys.has(taKey(a.title, a.artist)));
      } else {
        catAlbums = [];
      }
    } else {
      let pls = await client.listLibraryPlaylists();
      if (token !== addToken) return;
      if (q) {
        const ql = q.toLowerCase();
        pls = pls.filter((p) => p.name.toLowerCase().includes(ql) || (p.owner ?? '').toLowerCase().includes(ql));
      }
      libPlaylists = pls;
      if (q) {
        const cat = await client.searchPlaylists(q);
        if (token !== addToken) return;
        const libUris = new Set(libPlaylists.map((p) => p.providerUri));
        const libNames = new Set(libPlaylists.map((p) => p.name.toLowerCase()));
        catPlaylists = cat.filter((p) => !libUris.has(p.providerUri) && !libNames.has(p.name.toLowerCase()));
      } else {
        catPlaylists = [];
      }
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
  const libCards = addType === 'album' ? libAlbums.map(albumCard) : libPlaylists.map(playlistCard);
  const catCards = addType === 'album' ? catAlbums.map(albumCard) : catPlaylists.map(playlistCard);
  if (!libCards.length && !catCards.length) {
    const kind = addType === 'album' ? 'albums' : 'playlists';
    addListEl.innerHTML = `<div class="empty">${searching ? 'No matches.' : `No ${kind} in your library yet.`}</div>`;
    addMoreBtn.hidden = true;
    return;
  }
  addListEl.innerHTML = '';
  if (libCards.length) addSection(searching ? 'In your library' : '', libCards);
  if (searching && catCards.length) addSection(catalogLabel(), catCards);
  // Load-more paginates the browsed library only; searches show all matches at once.
  addMoreBtn.hidden = searching || addType !== 'album' || !addHasMore;
}

function albumCard(it: LibraryAlbum | SearchAlbum): HTMLElement {
  const albumId = 'albumId' in it ? it.albumId : null;
  const card = document.createElement('div');
  card.className = 'card';
  const srcName = sources.length > 1 ? it.source : '';
  const src = srcName ? ` · ${esc(srcName)}` : '';
  card.innerHTML = `
    ${artHtml(it.artworkUrl)}
    <div class="body">
      <div class="meta">
        <div class="t">${esc(it.title)}</div>
        <div class="a">${esc(it.artist)}</div>
        <div class="y">${it.year ?? ''}${src}</div>
      </div>
      <div class="card-actions"></div>
    </div>`;
  const actions = card.querySelector('.card-actions') as HTMLElement;
  if (it.onShelf && albumId) {
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

let addSearchTimer: ReturnType<typeof setTimeout> | undefined;
addSearchInput.addEventListener('input', () => {
  clearTimeout(addSearchTimer);
  addSearchTimer = setTimeout(() => {
    addQuery = addSearchInput.value.trim();
    void reloadAdd(true);
  }, 300);
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
    const res = await client.getShelf();
    shelves = res.shelves;
    libraryCount = res.items.length;
    if (openShelfId === 'all') detailItems = res.items; // keep the open All detail fresh
  } catch {
    shelvesListEl.innerHTML = `<div class="empty">Could not reach the device service.</div>`;
    return;
  }
  crateMembers.clear();
  await Promise.all(
    albumCrates().map(async (c) => {
      try {
        const m = await client.getShelf(c.id);
        crateMembers.set(c.id, new Set(m.items.map((i) => i.albumId)));
      } catch {
        crateMembers.set(c.id, new Set());
      }
    }),
  );
  renderShelvesIndex();
  if (openShelfId) renderShelfDetail();
}

function renderShelvesIndex(): void {
  shelvesListEl.innerHTML = '';
  // "All albums" is just the default shelf, shown first.
  shelvesListEl.appendChild(shelfRow('all', 'All albums', libraryCount, true));
  for (const c of albumCrates()) {
    shelvesListEl.appendChild(shelfRow(c.id, c.name, crateMembers.get(c.id)?.size ?? 0, false));
  }
}

function shelfRow(id: string, name: string, count: number, isDefault: boolean): HTMLElement {
  const row = document.createElement('button');
  row.className = 'shelf-row' + (isDefault ? ' default' : '');
  row.innerHTML =
    `<span class="sh-name">${esc(name)}</span>` +
    `<span class="sh-n">${count} album${count === 1 ? '' : 's'}</span>` +
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
  shelvesIndexEl.hidden = false;
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
  const view = viewByShelf.get(openShelfId) ?? 'tile';
  const sort = sortByShelf.get(openShelfId) ?? 'custom';
  shelfDetailCount.textContent = `${detailItems.length} album${detailItems.length === 1 ? '' : 's'}`;
  shelfListEl.className = view === 'list' ? 'list' : 'grid';
  if (detailItems.length === 0) {
    shelfListEl.innerHTML = `<div class="empty">${openShelfId === 'all' ? 'Nothing on the shelf yet — add albums from Search.' : 'No albums in this shelf yet — add them from All albums.'}</div>`;
    return;
  }
  const rows = sortedDetail();
  if (rows.length === 0) {
    shelfListEl.innerHTML = `<div class="empty">No albums match “${esc(shelfFilter)}”.</div>`;
    return;
  }
  shelfListEl.innerHTML = '';
  // Drag-reorder only makes sense on the full, custom-ordered list — not a filtered subset.
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
    shelfListEl.appendChild(card);
  }
}

async function removeFromDetail(albumId: string): Promise<void> {
  try {
    if (openShelfId === 'all') await client.removeFromShelf(albumId);
    else if (openShelfId) await client.removeAlbumFromShelf(openShelfId, albumId);
    detailItems = detailItems.filter((it) => it.albumId !== albumId);
    renderShelfDetail();
    showToast(openShelfId === 'all' ? 'Removed from library' : 'Taken out of shelf');
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
setAddType('album'); // seeds the Add tab (Albums) via reloadAdd
void loadShelvesIndex();
void loadSettingsPanel();
