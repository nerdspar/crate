/**
 * Crate admin — Phase 1 scope: just enough to search Apple Music (via the
 * device service → Music Assistant) and add/remove albums on the shelf.
 * The full admin (sources, curation, players, appearance, system) is Phase 4.
 */

import { CrateClient, type OverrideRequest, type SearchAlbum, type ShelfItem } from '@crate/shared';
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

function renderShelf(): void {
  shelfCountEl.textContent = String(shelf.length);
  if (shelf.length === 0) {
    shelfListEl.innerHTML = `<div class="empty">Nothing on the shelf yet.</div>`;
    return;
  }
  shelfListEl.innerHTML = '';
  shelf.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      ${artThumb(it.artworkUrl)}
      <div class="meta">
        <div class="t">${esc(it.title)}</div>
        <div class="a">${esc(it.artist)}</div>
      </div>
      <div class="card-actions">
        <button class="ghost edit-btn">Edit</button>
        <button class="ghost">Remove</button>
      </div>`;
    card.querySelector('.edit-btn')!.addEventListener('click', () => void openEditor(it));
    card.querySelectorAll('button')[1]!.addEventListener('click', () => void removeFromShelf(it.albumId));
    shelfListEl.appendChild(card);
  });
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

renderResults();
void loadShelf();
