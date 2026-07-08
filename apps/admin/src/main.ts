/**
 * Crate admin — a small web app (phone or desktop) with a bottom tab bar:
 * Search (add albums), Shelves (curate collections; "All" is the default shelf),
 * and Settings (mirrors the wall). Per-album spine overrides live in a modal.
 */

import { CrateClient, type LibraryAlbum, type MusicSourceInfo, type OverrideRequest, type SearchAlbum, type Settings, type Shelf, type ShelfItem } from '@crate/shared';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource-variable/newsreader/standard.css';
import './styles.css';

const client = new CrateClient('');

const qInput = document.getElementById('q') as HTMLInputElement;
const form = document.getElementById('search-form') as HTMLFormElement;
const resultsEl = document.getElementById('results') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

type ShelfView = 'list' | 'tile';
type ShelfSort = 'custom' | 'added' | 'artist' | 'title' | 'year';

let results: SearchAlbum[] = [];
// Add tab: "My Library" browse/import vs "Search", both source-aware.
let addMode: 'library' | 'search' = 'library';
let sources: MusicSourceInfo[] = [];
let curSource = 'all';
let libItems: LibraryAlbum[] = [];
let libOffset = 0;
let libHasMore = false;
let libLoading = false;
let libSearch = '';
let libFav = false;
const LIB_PAGE = 60;
let shelves: Shelf[] = [];
let settings: Settings | null = null;
const crateMembers = new Map<string, Set<string>>(); // shelf id → member album ids (named shelves)
let libraryCount = 0; // size of the "All" shelf

// Currently open shelf detail: 'all' = the library, else a named shelf id; null = index.
let openShelfId: string | null = null;
let openShelfName = '';
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

function artHtml(url: string | null): string {
  return `<div class="art">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</div>`;
}

/* ================= Tab navigation ================= */
function switchTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.tab-pane').forEach((p) => p.classList.toggle('on', p.dataset['tab'] === name));
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((b) => b.classList.toggle('on', b.dataset['tab'] === name));
}
document.querySelectorAll<HTMLElement>('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset['tab']!));
});

/* ================= Search ================= */
function renderResults(): void {
  if (results.length === 0) {
    resultsEl.innerHTML = `<div class="empty">No results yet — search above.</div>`;
    return;
  }
  resultsEl.innerHTML = '';
  results.forEach((a, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      ${artHtml(a.artworkUrl)}
      <div class="body">
        <div class="meta">
          <div class="t">${esc(a.title)}</div>
          <div class="a">${esc(a.artist)}</div>
          <div class="y">${a.year ?? ''} · ${esc(a.provider)}</div>
        </div>
        <button ${a.onShelf ? 'disabled' : ''} data-i="${i}">${a.onShelf ? 'On shelf' : 'Add'}</button>
      </div>`;
    const btn = card.querySelector('button')!;
    if (!a.onShelf) btn.addEventListener('click', () => void addToShelf(a, btn));
    resultsEl.appendChild(card);
  });
}

async function search(query: string): Promise<void> {
  resultsEl.innerHTML = `<div class="empty">Searching…</div>`;
  try {
    results = await client.search(query, curSource);
    renderResults();
  } catch (e) {
    resultsEl.innerHTML = `<div class="empty">Search failed: ${esc((e as Error).message)}</div>`;
  }
}

async function addToShelf(album: SearchAlbum, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    await client.addToShelf({ providerUri: album.providerUri });
    album.onShelf = true;
    btn.textContent = 'On shelf';
    showToast(`Added ${album.title}`);
    await loadShelvesIndex();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Add';
    showToast(`Failed: ${(e as Error).message}`);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (q) void search(q);
});

/* ================= Add: mode toggle + source filter ================= */
const sourceSel = document.getElementById('source-sel') as HTMLSelectElement;
const libraryModeEl = document.getElementById('library-mode') as HTMLElement;
const searchModeEl = document.getElementById('search-mode') as HTMLElement;

function setAddMode(mode: 'library' | 'search'): void {
  addMode = mode;
  document.querySelectorAll<HTMLElement>('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset['mode'] === mode));
  libraryModeEl.hidden = mode !== 'library';
  searchModeEl.hidden = mode !== 'search';
  if (mode === 'library' && libItems.length === 0) void loadLibrary(true);
}
document.querySelectorAll<HTMLElement>('.seg-btn').forEach((b) => b.addEventListener('click', () => setAddMode(b.dataset['mode'] as 'library' | 'search')));

function syncSourceSel(): void {
  if (sources.length <= 1) {
    sourceSel.hidden = true;
    return;
  }
  if (sourceSel.options.length !== sources.length + 1) {
    sourceSel.innerHTML = '';
    const all = new Option('All sources', 'all');
    sourceSel.add(all);
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
  if (addMode === 'library') void loadLibrary(true);
  else if (qInput.value.trim()) void search(qInput.value.trim());
});

/* ================= My Library: browse + bulk import ================= */
const libraryListEl = document.getElementById('library-list') as HTMLElement;
const libSearchInput = document.getElementById('lib-search') as HTMLInputElement;
const libFavCb = document.getElementById('lib-fav') as HTMLInputElement;
const libImportBtn = document.getElementById('lib-import') as HTMLButtonElement;
const libMoreBtn = document.getElementById('lib-more') as HTMLButtonElement;

async function loadLibrary(reset: boolean): Promise<void> {
  if (libLoading) return;
  libLoading = true;
  if (reset) {
    libOffset = 0;
    libItems = [];
    libraryListEl.innerHTML = `<div class="empty">Loading…</div>`;
  } else {
    libMoreBtn.textContent = 'Loading…';
  }
  try {
    const res = await client.listLibraryAlbums({
      source: curSource === 'all' ? undefined : curSource,
      search: libSearch || undefined,
      favorite: libFav || undefined,
      limit: LIB_PAGE,
      offset: libOffset,
    });
    sources = res.sources;
    syncSourceSel();
    libItems = reset ? res.items : libItems.concat(res.items);
    libHasMore = res.hasMore;
    libOffset += res.items.length;
    renderLibrary();
  } catch {
    libraryListEl.innerHTML = `<div class="empty">Could not load your library.</div>`;
  } finally {
    libLoading = false;
    libMoreBtn.textContent = 'Load more';
  }
}

function renderLibrary(): void {
  if (libItems.length === 0) {
    libraryListEl.innerHTML = `<div class="empty">${libSearch || libFav ? 'No matching albums in your library.' : 'No albums in your library yet.'}</div>`;
    libMoreBtn.hidden = true;
    return;
  }
  libraryListEl.innerHTML = '';
  for (const it of libItems) {
    const card = document.createElement('div');
    card.className = 'card';
    const src = sources.length > 1 ? ` · ${esc(it.source)}` : '';
    card.innerHTML = `
      ${artHtml(it.artworkUrl)}
      <div class="body">
        <div class="meta">
          <div class="t">${esc(it.title)}</div>
          <div class="a">${esc(it.artist)}</div>
          <div class="y">${it.year ?? ''}${src}</div>
        </div>
        <button ${it.onShelf ? 'disabled' : ''}>${it.onShelf ? 'On shelf' : 'Add'}</button>
      </div>`;
    const btn = card.querySelector('button')!;
    if (!it.onShelf) btn.addEventListener('click', () => void addLibraryAlbum(it, card, btn));
    libraryListEl.appendChild(card);
  }
  libMoreBtn.hidden = !libHasMore;
}

async function addLibraryAlbum(it: LibraryAlbum, card: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Adding…';
  card.classList.add('busy');
  try {
    await client.addToShelf({ providerUri: it.providerUri });
    it.onShelf = true;
    btn.textContent = 'On shelf';
    showToast(`Added ${it.title}`);
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
  const orig = libImportBtn.textContent;
  libImportBtn.disabled = true;
  libImportBtn.textContent = 'Adding…';
  try {
    const r = await client.importLibrary(curSource === 'all' ? undefined : curSource);
    showToast(`Added ${r.added}, skipped ${r.skipped} of ${r.total}`);
    await loadLibrary(true);
    void loadShelvesIndex();
  } catch (e) {
    showToast(`Import failed: ${(e as Error).message}`);
  } finally {
    libImportBtn.disabled = false;
    libImportBtn.textContent = orig;
  }
}

let libSearchTimer: ReturnType<typeof setTimeout> | undefined;
libSearchInput.addEventListener('input', () => {
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(() => {
    libSearch = libSearchInput.value.trim();
    void loadLibrary(true);
  }, 300);
});
libFavCb.addEventListener('change', () => {
  libFav = libFavCb.checked;
  void loadLibrary(true);
});
libImportBtn.addEventListener('click', () => void importAll());
libMoreBtn.addEventListener('click', () => void loadLibrary(false));

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

async function openShelf(id: string, name: string): Promise<void> {
  openShelfId = id;
  openShelfName = name;
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
  if (sort === 'custom') return [...detailItems]; // as fetched = the saved manual order
  const s = [...detailItems];
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
  shelfListEl.innerHTML = '';
  const draggable = sort === 'custom';
  shelfListEl.classList.toggle('draggable', draggable);
  for (const it of sortedDetail()) {
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
    card.querySelector('.crate-btn')!.addEventListener('click', (e) => openCratePicker(e.currentTarget as HTMLElement, it));
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
function openCratePicker(anchor: HTMLElement, it: ShelfItem): void {
  closeCrateMenu();
  const crates = albumCrates();
  const menu = document.createElement('div');
  menu.className = 'crate-menu';
  if (!crates.length) menu.innerHTML = `<div class="empty">No shelves yet — create one in Shelves.</div>`;
  for (const c of crates) {
    const on = crateMembers.get(c.id)?.has(it.albumId) ?? false;
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span>${esc(c.name)}</span>`;
    const cb = label.querySelector('input') as HTMLInputElement;
    cb.addEventListener('change', async () => {
      const set = crateMembers.get(c.id) ?? new Set<string>();
      if (cb.checked) {
        await client.addAlbumToShelf(c.id, it.albumId).catch(() => {});
        set.add(it.albumId);
      } else {
        await client.removeAlbumFromShelf(c.id, it.albumId).catch(() => {});
        set.delete(it.albumId);
      }
      crateMembers.set(c.id, set);
      renderShelvesIndex();
      // If we're viewing that shelf, drop the row live when unchecked.
      if (openShelfId === c.id && !cb.checked) {
        detailItems = detailItems.filter((x) => x.albumId !== it.albumId);
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
renderResults();
void loadSources();
setAddMode('library'); // loads the library browser
void loadShelvesIndex();
void loadSettingsPanel();
