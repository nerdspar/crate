/**
 * Crate admin — Phase 1 scope: just enough to search Apple Music (via the
 * device service → Music Assistant) and add/remove albums on the shelf.
 * The full admin (sources, curation, players, appearance, system) is Phase 4.
 */

import { CrateClient, type SearchAlbum, type ShelfItem } from '@crate/shared';
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
      <button class="ghost">Remove</button>`;
    card.querySelector('button')!.addEventListener('click', () => void removeFromShelf(it.albumId));
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

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (q) void search(q);
});

renderResults();
void loadShelf();
