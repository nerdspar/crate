/**
 * Crate admin — Phase 1 scope: just enough to search Apple Music (via the
 * device service → Music Assistant) and add/remove albums on the shelf.
 * The full admin (sources, curation, players, appearance, system) is Phase 4.
 */

import { CrateClient, type OverrideRequest, type SearchAlbum, type Shelf, type ShelfItem } from '@crate/shared';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource-variable/newsreader/standard.css';
import './styles.css';

const client = new CrateClient('');

const qInput = document.getElementById('q') as HTMLInputElement;
const form = document.getElementById('search-form') as HTMLFormElement;
const resultsEl = document.getElementById('results') as HTMLElement;
const shelfListEl = document.getElementById('shelf-list') as HTMLElement;
const shelfCountEl = document.getElementById('shelf-count') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

let results: SearchAlbum[] = [];
let shelf: ShelfItem[] = [];
let shelfView: 'list' | 'tile' = 'tile';
let shelfSort = 'added';
let shelves: Shelf[] = [];
const crateMembers = new Map<string, Set<string>>(); // album crate id → member album ids

const shelfSortSel = document.getElementById('shelf-sort') as HTMLSelectElement;
const viewListBtn = document.getElementById('view-list') as HTMLButtonElement;
const viewTileBtn = document.getElementById('view-tile') as HTMLButtonElement;
const cratesListEl = document.getElementById('crates-list') as HTMLElement;
const crateForm = document.getElementById('crate-form') as HTMLFormElement;
const crateNameInput = document.getElementById('crate-name') as HTMLInputElement;
const defaultSpeakerSel = document.getElementById('default-speaker') as HTMLSelectElement;

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

function artThumb(url: string | null): string {
  return url ? `<img src="${esc(url)}" alt="">` : `<div class="noart"></div>`;
}

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
      ${artThumb(a.artworkUrl)}
      <div class="meta">
        <div class="t">${esc(a.title)}</div>
        <div class="a">${esc(a.artist)}</div>
        <div class="y">${a.year ?? ''} · ${esc(a.provider)}</div>
      </div>
      <button ${a.onShelf ? 'disabled' : ''} data-i="${i}">${a.onShelf ? 'On shelf' : 'Add'}</button>`;
    const btn = card.querySelector('button')!;
    if (!a.onShelf) btn.addEventListener('click', () => void addToShelf(a, btn));
    resultsEl.appendChild(card);
  });
}

function sortedShelf(): ShelfItem[] {
  const s = [...shelf];
  s.sort((a, b) => {
    if (shelfSort === 'artist') return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
    if (shelfSort === 'title') return a.title.localeCompare(b.title);
    if (shelfSort === 'year') return (b.year ?? 0) - (a.year ?? 0);
    return (b.addedAt || '').localeCompare(a.addedAt || ''); // added: newest first
  });
  return s;
}

function renderShelf(): void {
  shelfCountEl.textContent = String(shelf.length);
  shelfListEl.className = shelfView === 'list' ? 'list' : 'grid';
  if (shelf.length === 0) {
    shelfListEl.innerHTML = `<div class="empty">Nothing on the shelf yet.</div>`;
    return;
  }
  shelfListEl.innerHTML = '';
  for (const it of sortedShelf()) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      ${artThumb(it.artworkUrl)}
      <div class="meta">
        <div class="t">${esc(it.title)}</div>
        <div class="a">${esc(it.artist)}</div>
        <div class="y">${it.year ?? ''}</div>
      </div>
      <div class="card-actions">
        <button class="ghost crate-btn">Crates</button>
        <button class="ghost edit-btn">Edit</button>
        <button class="ghost rm-btn">Remove</button>
      </div>`;
    card.querySelector('.crate-btn')!.addEventListener('click', (e) => openCratePicker(e.currentTarget as HTMLElement, it));
    card.querySelector('.edit-btn')!.addEventListener('click', () => void openEditor(it));
    card.querySelector('.rm-btn')!.addEventListener('click', () => void removeFromShelf(it.albumId));
    shelfListEl.appendChild(card);
  }
}

async function search(query: string): Promise<void> {
  resultsEl.innerHTML = `<div class="empty">Searching…</div>`;
  try {
    results = await client.search(query);
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
    await loadShelf();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Add';
    showToast(`Failed: ${(e as Error).message}`);
  }
}

async function removeFromShelf(albumId: string): Promise<void> {
  try {
    await client.removeFromShelf(albumId);
    showToast('Removed');
    await loadShelf();
  } catch (e) {
    showToast(`Failed: ${(e as Error).message}`);
  }
}

async function loadShelf(): Promise<void> {
  try {
    shelf = (await client.getShelf()).items;
    renderShelf();
  } catch {
    shelfListEl.innerHTML = `<div class="empty">Could not reach the device service.</div>`;
  }
}

/* ---------- Per-album spine override editor ---------- */
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
  ovYear.value = '';
  try {
    const ov = (await client.getAlbum(it.albumId)).override;
    ovFont.value = ov.font ?? '';
    ovTracking.value = ov.tracking ?? '';
    ovSpineMode.value = ov.spineMode ?? '';
    ovLayout.value = ov.layout ?? '';
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
      yearDisplay: (ovYear.value || null) as OverrideRequest['yearDisplay'],
    });
    showToast('Saved');
    closeEditor();
    await loadShelf();
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

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (q) void search(q);
});

/* ---------- Crates (curated shelves) ---------- */
async function loadCrates(): Promise<void> {
  try {
    shelves = (await client.getShelf()).shelves;
  } catch {
    return;
  }
  crateMembers.clear();
  await Promise.all(
    shelves
      .filter((s) => s.kind === 'album' && s.id !== 'all')
      .map(async (c) => {
        try {
          const m = await client.getShelf(c.id);
          crateMembers.set(c.id, new Set(m.items.map((i) => i.albumId)));
        } catch {
          crateMembers.set(c.id, new Set());
        }
      }),
  );
  renderCrates();
}

function albumCrates(): Shelf[] {
  return shelves.filter((s) => s.kind === 'album' && s.id !== 'all');
}

function renderCrates(): void {
  const crates = albumCrates();
  cratesListEl.innerHTML = '';
  if (!crates.length) {
    cratesListEl.innerHTML = `<div class="empty">No crates yet — create one below.</div>`;
    return;
  }
  for (const c of crates) {
    const row = document.createElement('div');
    row.className = 'crate-row';
    row.innerHTML =
      `<span class="crate-name">${esc(c.name)}</span>` +
      `<span class="crate-n">${crateMembers.get(c.id)?.size ?? 0} albums</span>` +
      `<button class="ghost crate-del">Delete</button>`;
    row.querySelector('.crate-del')!.addEventListener('click', () => void deleteCrate(c.id, c.name));
    cratesListEl.appendChild(row);
  }
}

async function deleteCrate(id: string, name: string): Promise<void> {
  if (!confirm(`Delete crate "${name}"? Its albums stay in your library.`)) return;
  await client.deleteShelf(id).catch(() => {});
  await loadCrates();
  showToast('Crate deleted');
}

crateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = crateNameInput.value.trim();
  if (!name) return;
  await client.createShelf({ name, kind: 'album' }).catch(() => {});
  crateNameInput.value = '';
  await loadCrates();
  showToast('Crate created');
});

/* Per-album crate assignment — a floating checklist. */
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
  if (!crates.length) {
    menu.innerHTML = `<div class="empty">No crates yet — create one below.</div>`;
  }
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
      renderCrates();
    });
    menu.appendChild(label);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6}px`;
  activeCrateMenu = menu;
  setTimeout(() => document.addEventListener('pointerdown', onCrateOutside, true), 0);
}

/* ---------- Settings: default speaker ---------- */
async function loadSettingsPanel(): Promise<void> {
  try {
    const [players, settings] = [await client.getPlayers(), await client.getSettings()];
    defaultSpeakerSel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '(auto — first available)';
    defaultSpeakerSel.appendChild(auto);
    for (const p of players.players) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.available ? p.name : `${p.name} (offline)`;
      if (settings.defaultPlayerId === p.id) o.selected = true;
      defaultSpeakerSel.appendChild(o);
    }
  } catch {
    defaultSpeakerSel.innerHTML = '<option>Could not load players</option>';
  }
}
defaultSpeakerSel.addEventListener('change', async () => {
  await client.putSettings({ defaultPlayerId: defaultSpeakerSel.value || null }).catch(() => {});
  showToast('Default speaker saved');
});

/* ---------- View toggle + sort ---------- */
viewListBtn.addEventListener('click', () => {
  shelfView = 'list';
  viewListBtn.classList.add('on');
  viewTileBtn.classList.remove('on');
  renderShelf();
});
viewTileBtn.addEventListener('click', () => {
  shelfView = 'tile';
  viewTileBtn.classList.add('on');
  viewListBtn.classList.remove('on');
  renderShelf();
});
shelfSortSel.addEventListener('change', () => {
  shelfSort = shelfSortSel.value;
  renderShelf();
});

renderResults();
void loadShelf();
void loadCrates();
void loadSettingsPanel();
