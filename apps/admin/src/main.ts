/**
 * Crate admin — a small web app (phone or desktop) with a bottom tab bar:
 * Search (add albums), Shelves (curate collections; "All" is the default shelf),
 * and Settings (mirrors the wall). Per-album spine overrides live in a modal.
 */

import { CrateClient, EXTRA_MEDIA, isSpeaker, type AutoUpdateConfig, type CrateBackup, type ExtraMediaKind, type GithubBackupConfig, type GroupPreset, type LibraryAlbum, type LibraryPlaylist, type MaConfigEntry, type MaConfigValue, type MaProviderManifest, type MaSource, type MaStatus, type MediaBrowseItem, type MusicSourceInfo, type OverrideRequest, type Player, type SearchAlbum, type ServiceHealth, type Settings, type Shelf, type ShelfItem, type SourceKinds, type UpdateProgress, type UpdateStatus, type UpdateTarget } from '@crate/shared';
import crateMark from './crate-mark.svg';
import crateLogo from './crate-logo.svg';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource-variable/newsreader/standard.css';
import './styles.css';

const client = new CrateClient('');

const toast = document.getElementById('toast') as HTMLElement;

type ShelfView = 'list' | 'tile';
type ShelfSort = 'custom' | 'added' | 'artist' | 'title' | 'year';
type AddType = 'album' | 'playlist' | ExtraMediaKind;
const emptyMediaMap = <T>(v: () => T): Record<ExtraMediaKind, T> => ({ radio: v(), podcast: v(), audiobook: v() });
const isExtraKind = (t: AddType): t is ExtraMediaKind => EXTRA_MEDIA.some((m) => m.kind === t);

// Add tab: one search over your library + the catalog, per content type. Source-aware.
let addType: AddType = 'album';
let sources: MusicSourceInfo[] = [];
let curSource = 'all';
let addQuery = '';
let libAlbums: LibraryAlbum[] = [];
let catAlbums: SearchAlbum[] = [];
let libPlaylists: LibraryPlaylist[] = [];
let catPlaylists: LibraryPlaylist[] = [];
// Saved + catalog-search results per extra media kind (radio/podcast/audiobook).
const libMedia: Record<ExtraMediaKind, MediaBrowseItem[]> = emptyMediaMap(() => []);
const catMedia: Record<ExtraMediaKind, MediaBrowseItem[]> = emptyMediaMap(() => []);
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
const mediaCounts: Record<ExtraMediaKind, number> = emptyMediaMap(() => 0); // size of each extra-media shelf
let sourceKinds: SourceKinds = { radio: false, podcast: false, audiobook: false }; // which extra kinds a source serves

/** Show each extra-media segment (Radio/Podcasts/Audiobooks) only when a capable source is
    connected AND the user hasn't hidden it; fall back to Albums if the active one vanishes. */
function updateMediaSegments(): void {
  for (const m of EXTRA_MEDIA) {
    const show = sourceKinds[m.kind] && (settings?.mediaTabs?.[m.kind] ?? true);
    document.querySelectorAll<HTMLElement>(`.seg-btn[data-type="${m.kind}"]`).forEach((b) => (b.style.display = show ? '' : 'none'));
    if (!show && addType === m.kind) setContentType('album');
  }
}
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

// Monochrome line icons for the shelf-editor action buttons.
const ICO_SHELVES = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="4" height="16" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="16" y="6" width="5" height="14" rx="1" transform="rotate(-10 18.5 13)"/></svg>';
const ICO_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICO_GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
const ICO_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

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
function artHtml(url: string | null, source?: string): string {
  // No loading="lazy": on mobile (esp. iOS Safari) lazy thumbnails re-load/re-decode as they
  // scroll into view, which reads as perpetual flashing. These are small cached covers, so
  // load them once up front and let them stay decoded. decoding="async" keeps it off the main thread.
  const img = url ? `<img src="${esc(url)}" alt="" decoding="async" onerror="this.remove()">` : '';
  return `<div class="art">${img}${srcArtIcon(source)}</div>`;
}

/** The source's icon, overlaid on a search result's artwork corner (only in search views). */
function srcArtIcon(source?: string): string {
  if (!source) return '';
  const icon = sources.find((s) => s.name === source)?.iconSvg;
  return icon ? `<span class="src-ico" title="${esc(source)}">${icon}</span>` : '';
}

/* ================= Tab navigation ================= */
function switchTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.tab-pane').forEach((p) => p.classList.toggle('on', p.dataset['tab'] === name));
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((b) => b.classList.toggle('on', b.dataset['tab'] === name));
}
document.querySelectorAll<HTMLElement>('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => {
    // Tapping a tab always drops you on that tab's top-level screen (out of any detail).
    resetToTabTop();
    switchTab(b.dataset['tab']!);
  });
});

/* ---- Screen navigation: tab tap returns to the top; the phone back button (and the
   in-app back buttons) step out of detail screens one level at a time (History API). ---- */
function resetToTabTop(): void {
  if (typeof backToIndex === 'function') backToIndex();
  settingsDetailEl.hidden = true;
  settingsIndexEl.hidden = false;
  currentSettingsCat = null;
}
/** True if any detail sub-screen is currently showing. */
function aDetailIsOpen(): boolean {
  return !playlistSongsEl.hidden || !shelfDetailEl.hidden || !settingsDetailEl.hidden;
}
/** Close the deepest-open detail screen (returns to its parent). */
function goBackOneLevel(): void {
  if (!playlistSongsEl.hidden) {
    playlistSongsEl.hidden = true;
    if (songsBackTo === 'detail') shelfDetailEl.hidden = false;
    else shelvesIndexEl.hidden = false;
  } else if (!shelfDetailEl.hidden) {
    backToIndex();
  } else if (!settingsDetailEl.hidden) {
    settingsDetailEl.hidden = true;
    settingsIndexEl.hidden = false;
    currentSettingsCat = null;
  }
}
/** Push a history entry when opening a detail screen, so the back button steps out. */
function pushDetailHistory(): void {
  history.pushState({ crateDetail: true }, '');
}
window.addEventListener('popstate', () => {
  if (aDetailIsOpen()) goBackOneLevel();
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
  const extra = EXTRA_MEDIA.find((m) => m.kind === addType);
  addSearchInput.placeholder = extra
    ? `Search ${extra.name.toLowerCase()} — by name…`
    : `Search your library & Apple Music — ${addType === 'album' ? 'album or artist' : 'playlist'}…`;
  // "Add all" for every type — albums import your library, playlists add all your library
  // playlists, and an extra kind adds every item of it saved in Music Assistant.
  importBtn.hidden = false;
  importBtn.textContent = 'Add all';
  syncSourceSel(); // hide the album-source dropdown for the extra media kinds
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
  const picks = albumSources();
  if (isExtraKind(addType) || picks.length <= 1) {
    // The extra media kinds search all their providers; the album-source dropdown doesn't apply.
    // And with a single album source there's nothing to switch between.
    sourceSel.hidden = true;
    return;
  }
  if (sourceSel.options.length !== picks.length + 1) {
    sourceSel.innerHTML = '';
    sourceSel.add(new Option('All sources', 'all'));
    // Only album/playlist-capable sources belong in this picker — a radio-only source (TuneIn) has
    // no albums/playlists, so filtering to it would always show nothing.
    for (const s of albumSources()) sourceSel.add(new Option(s.name, s.instanceId));
  }
  sourceSel.value = curSource;
  sourceSel.hidden = false;
}
/** Sources that actually serve albums/playlists (not radio-only), for the search source picker. */
function albumSources(): MusicSourceInfo[] {
  return sources.filter((s) => !s.features || s.features.some((f) => f === 'library_albums' || f === 'library_playlists'));
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
  const pl = albumSources();
  return pl.length === 1 ? `From ${pl[0]!.name}` : 'From your sources';
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
    } else if (addType === 'playlist') {
      let pls = await client.listLibraryPlaylists();
      if (token !== addToken) return;
      if (q) {
        const ql = q.toLowerCase();
        pls = pls.filter((p) => p.name.toLowerCase().includes(ql) || (p.owner ?? '').toLowerCase().includes(ql));
      }
      libPlaylists = pls;
      catPlaylists = q ? await client.searchPlaylists(q) : [];
      if (token !== addToken) return;
    } else {
      // An extra media kind (radio/podcast/audiobook): saved items on top, catalog search below.
      const kind = addType as ExtraMediaKind;
      let lib = await client.listLibraryMedia(kind);
      if (token !== addToken) return;
      if (q) {
        const ql = q.toLowerCase();
        lib = lib.filter((r) => r.name.toLowerCase().includes(ql) || (r.description ?? '').toLowerCase().includes(ql));
      }
      libMedia[kind] = lib;
      catMedia[kind] = q ? (await client.searchMedia(kind, q)).items : [];
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
  const kind = addType === 'album' ? 'albums' : addType === 'playlist' ? 'playlists' : (EXTRA_MEDIA.find((m) => m.kind === addType)?.name.toLowerCase() ?? 'items');
  // Source filter (the dropdown) applied client-side so playlists filter by source just like
  // albums. curSource is a provider instance id; results carry the source display name.
  const curSrcName = curSource === 'all' ? null : (sources.find((s) => s.instanceId === curSource)?.name ?? null);
  const bySrc = <T extends { source?: string }>(list: T[]): T[] => (curSrcName ? list.filter((x) => x.source === curSrcName) : list);

  // Browsing (no query): just your library, one flat grid.
  if (!searching) {
    const cards =
      addType === 'album' ? bySrc(libAlbums).map(albumCard) : addType === 'playlist' ? bySrc(libPlaylists).map(playlistCard) : libMedia[addType].map(mediaCard);
    if (!cards.length) {
      const hint = isExtraKind(addType) ? `No saved ${kind} yet — search above, or Add all.` : `No ${kind} in your library yet.`;
      addListEl.innerHTML = `<div class="empty">${hint}</div>`;
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
    const la = bySrc(libAlbums);
    const ca = bySrc(catAlbums);
    const libKeys = new Set(la.map((a) => taKey(a.title, a.artist)));
    // One row per shelved album — many catalog editions can resolve to the same one.
    const seenId = new Set<string>();
    const onShelf = [
      ...la.filter((a) => a.onShelf),
      ...ca.filter((a) => a.onShelf && !libKeys.has(taKey(a.title, a.artist))),
    ].filter((a) => {
      const id = 'albumId' in a ? a.albumId : null;
      if (id && seenId.has(id)) return false;
      if (id) seenId.add(id);
      return true;
    });
    const owned = la.filter((a) => !a.onShelf);
    const catalog = ca.filter((a) => !a.onShelf && !libKeys.has(taKey(a.title, a.artist)));
    if (!onShelf.length && !owned.length && !catalog.length) {
      addListEl.innerHTML = `<div class="empty">No matches.</div>`;
      return;
    }
    if (onShelf.length) addSection('On your shelf', onShelf.map(albumCard));
    if (owned.length) addSection('In your library', owned.map(albumCard));
    if (catalog.length) addSection(catalogLabel(), catalog.map(albumCard));
  } else if (addType === 'playlist') {
    const lp = bySrc(libPlaylists);
    const cp = bySrc(catPlaylists);
    const uris = new Set(lp.map((p) => p.providerUri));
    const names = new Set(lp.map((p) => p.name.toLowerCase()));
    const dup = (p: LibraryPlaylist): boolean => uris.has(p.providerUri) || names.has(p.name.toLowerCase());
    const seenName = new Set<string>();
    const onShelf = [...lp.filter((p) => p.onShelf), ...cp.filter((p) => p.onShelf && !dup(p))].filter((p) => {
      const k = p.name.toLowerCase();
      if (seenName.has(k)) return false;
      seenName.add(k);
      return true;
    });
    const owned = lp.filter((p) => !p.onShelf);
    const catalog = cp.filter((p) => !p.onShelf && !dup(p));
    if (!onShelf.length && !owned.length && !catalog.length) {
      addListEl.innerHTML = `<div class="empty">No matches.</div>`;
      return;
    }
    if (onShelf.length) addSection('On your shelf', onShelf.map(playlistCard));
    if (owned.length) addSection('In your library', owned.map(playlistCard));
    if (catalog.length) addSection(catalogLabel(), catalog.map(playlistCard));
  } else {
    // An extra media kind: On your shelf → Saved → From search.
    const k = addType as ExtraMediaKind;
    const lib = libMedia[k];
    const cat = catMedia[k];
    const seen = new Set<string>();
    const dedupe = (r: MediaBrowseItem): boolean => {
      if (seen.has(r.providerUri)) return false;
      seen.add(r.providerUri);
      return true;
    };
    const libUris = new Set(lib.map((r) => r.providerUri));
    const onShelf = [...lib.filter((r) => r.onShelf), ...cat.filter((r) => r.onShelf && !libUris.has(r.providerUri))].filter(dedupe);
    const owned = lib.filter((r) => !r.onShelf);
    const catalog = cat.filter((r) => !r.onShelf && !libUris.has(r.providerUri));
    if (!onShelf.length && !owned.length && !catalog.length) {
      addListEl.innerHTML = `<div class="empty">No ${kind} found.</div>`;
      return;
    }
    if (onShelf.length) addSection('On your shelf', onShelf.map(mediaCard));
    if (owned.length) addSection(`Your saved ${kind}`, owned.map(mediaCard));
    if (catalog.length) addSection('From search', catalog.map(mediaCard));
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
    ${artHtml(it.artworkUrl, it.source)}
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
    ${artHtml(p.artworkUrl, p.source)}
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

function mediaCard(r: MediaBrowseItem): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  const fallback = r.kind === 'podcast' ? 'Podcast' : r.kind === 'audiobook' ? 'Audiobook' : 'Radio';
  const sub = r.description && r.description !== r.name ? r.description : (r.source ?? fallback);
  card.innerHTML = `
    ${artHtml(r.artworkUrl, r.source)}
    <div class="body">
      <div class="meta">
        <div class="t">${esc(r.name)}</div>
        <div class="a">${esc(sub)}</div>
      </div>
      <div class="card-actions"></div>
    </div>`;
  const actions = card.querySelector('.card-actions') as HTMLElement;
  if (r.onShelf) {
    const b = mkBtn('Added', 'ghost');
    b.disabled = true;
    actions.append(b);
  } else {
    const b = mkBtn('Add', '');
    b.addEventListener('click', () => void addMediaToShelf(r, card, b));
    actions.append(b);
  }
  return card;
}

async function addMediaToShelf(r: MediaBrowseItem, card: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Adding…';
  card.classList.add('busy');
  try {
    await client.addMedia(r.kind ?? (addType as ExtraMediaKind), r.providerUri);
    r.onShelf = true;
    showToast(`Added ${r.name}`);
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

/** "Add all" (playlists) — add every playlist in your provider library to the All Playlists
    shelf. Skips ones already added. */
async function addAllPlaylists(): Promise<void> {
  const all = await client.listLibraryPlaylists().catch((): LibraryPlaylist[] => []);
  const pending = all.filter((p) => !p.onShelf);
  if (!pending.length) {
    showToast('Your playlists are already added');
    return;
  }
  if (!confirm(`Add all ${pending.length} of your library playlists to Crate?`)) return;
  const orig = importBtn.textContent;
  importBtn.disabled = true;
  importBtn.textContent = 'Adding…';
  try {
    let added = 0;
    for (const p of pending) {
      await client
        .addPlaylist(p.providerUri)
        .then(() => added++)
        .catch(() => {});
    }
    showToast(`Added ${added} playlist${added === 1 ? '' : 's'}`);
    await reloadAdd(true);
    void loadShelvesIndex();
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = orig;
  }
}

/** "Add all" for an extra kind — pull every saved item of it from Music Assistant onto its shelf. */
async function syncSavedMedia(kind: ExtraMediaKind): Promise<void> {
  const label = EXTRA_MEDIA.find((m) => m.kind === kind)?.name.toLowerCase() ?? 'items';
  const orig = importBtn.textContent;
  importBtn.disabled = true;
  importBtn.textContent = 'Syncing…';
  try {
    const r = await client.syncMedia(kind);
    showToast(r.added ? `Added ${r.added} ${label}` : `Saved ${label} already added`);
    await reloadAdd(true);
    void loadShelvesIndex();
  } catch (e) {
    showToast(`Sync failed: ${(e as Error).message}`);
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = orig;
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
importBtn.addEventListener('click', () => void (isExtraKind(addType) ? syncSavedMedia(addType) : addType === 'playlist' ? addAllPlaylists() : importAll()));
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
    const pl = await client.getShelf('playlists').catch(() => ({ items: [] }));
    shelves = res.shelves;
    sourceKinds = res.sourceKinds;
    updateMediaSegments();
    libraryCount = res.items.length;
    playlistCount = pl.items.length;
    if (openShelfId === 'all') detailItems = res.items; // keep the open All detail fresh
    if (openShelfId === 'playlists') detailItems = pl.items;
    // Each extra-media shelf's count (+ refresh its open detail).
    for (const m of EXTRA_MEDIA) {
      const r = await client.getShelf(m.shelfId).catch(() => ({ items: [] }));
      mediaCounts[m.kind] = r.items.length;
      if (openShelfId === m.shelfId) detailItems = r.items;
    }
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
  const extra = EXTRA_MEDIA.find((m) => m.kind === addType);
  if (extra) {
    crateForm.hidden = true; // each extra kind has one virtual shelf; nothing named here
    const noun = extra.kind === 'radio' ? 'station' : extra.kind === 'podcast' ? 'podcast' : 'audiobook';
    shelvesListEl.appendChild(shelfRow(extra.shelfId, extra.name, mediaCounts[extra.kind], true, noun));
    return;
  }
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

function shelfRow(id: string, name: string, count: number, isDefault: boolean, unit: 'album' | 'playlist' | 'station' | 'podcast' | 'audiobook'): HTMLElement {
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
(document.getElementById('shelf-back') as HTMLElement).addEventListener('click', () => history.back());

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
songsBackEl.addEventListener('click', () => history.back());

let openSongShelfId: string | null = null;

function showSongsView(name: string, from: 'index' | 'detail'): void {
  songsBackTo = from;
  songsBackEl.textContent = from === 'detail' ? '‹ All Playlists' : '‹ Playlists';
  shelfDetailEl.hidden = true;
  if (from !== 'detail') shelvesIndexEl.hidden = true;
  playlistSongsEl.hidden = false;
  pushDetailHistory();
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
  pushDetailHistory();
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
  const extra = EXTRA_MEDIA.find((m) => m.shelfId === openShelfId);
  const unit = playlists ? 'playlist' : extra ? (extra.kind === 'radio' ? 'station' : extra.kind) : 'album';
  const view = viewByShelf.get(openShelfId) ?? 'tile';
  const sort = sortByShelf.get(openShelfId) ?? 'custom';
  shelfDetailCount.textContent = `${detailItems.length} ${unit}${detailItems.length === 1 ? '' : 's'}`;
  shelfListEl.className = view === 'list' ? 'list' : 'grid';
  if (detailItems.length === 0) {
    const msg = playlists
      ? 'No playlists yet — add them from Add › Playlists.'
      : extra
        ? `No ${extra.name.toLowerCase()} yet — add them from Add › ${extra.name}.`
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
    if (playlists) {
      card.innerHTML = `
        ${artHtml(it.artworkUrl)}
        <div class="body">
          <div class="meta">
            <div class="t">${esc(it.title)}</div>
            <div class="a">${esc(it.artist)}</div>
          </div>
          <div class="card-actions">
            <button class="ghost ico-btn edit-btn" aria-label="Edit spine" title="Edit spine">${ICO_EDIT}</button>
            <button class="ghost ico-btn rm-btn" aria-label="Remove" title="Remove">${ICO_TRASH}</button>
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
    } else if (extra) {
      card.innerHTML = `
        ${artHtml(it.artworkUrl)}
        <div class="body">
          <div class="meta">
            <div class="t">${esc(it.title)}</div>
            <div class="a">${esc(it.artist)}</div>
          </div>
          <div class="card-actions">
            <button class="ghost ico-btn edit-btn" aria-label="Edit spine" title="Edit spine">${ICO_EDIT}</button>
            <button class="ghost ico-btn rm-btn" aria-label="Remove" title="Remove">${ICO_TRASH}</button>
          </div>
        </div>`;
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
            <button class="ghost ico-btn crate-btn" aria-label="Shelves" title="Shelves">${ICO_SHELVES}</button>
            <button class="ghost ico-btn edit-btn" aria-label="Edit spine" title="Edit spine">${ICO_EDIT}</button>
            <button class="ghost ico-btn rm-btn" aria-label="${openShelfId === 'all' ? 'Remove' : 'Take out'}" title="${openShelfId === 'all' ? 'Remove' : 'Take out'}">${ICO_TRASH}</button>
          </div>
        </div>`;
      card.querySelector('.crate-btn')!.addEventListener('click', (e) => openCratePicker(e.currentTarget as HTMLElement, it.albumId));
      card.querySelector('.edit-btn')!.addEventListener('click', () => void openEditor(it));
      card.querySelector('.rm-btn')!.addEventListener('click', () => void removeFromDetail(it.albumId));
    }
    if (draggable) {
      const handle = document.createElement('button');
      handle.className = 'drag-handle';
      handle.setAttribute('aria-label', 'Drag to reorder');
      handle.innerHTML = ICO_GRIP;
      card.insertBefore(handle, card.firstChild); // left of the row
      wirePointerDrag(card, handle, shelfListEl, saveShelfOrder);
    }
    shelfListEl.appendChild(card);
  }
}

/** Pointer-based drag reorder (works on touch AND mouse, unlike HTML5 dnd). Dragging
    starts from the handle; the row follows a reorder within its container by pointer Y. */
function wirePointerDrag(row: HTMLElement, handle: HTMLElement, container: HTMLElement, onDrop: () => void): void {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.add('dragging');
    let curY = e.clientY;
    // Auto-scroll the page while the finger sits near the top/bottom edge, so you can drag a row
    // past what's currently on screen. preventDefault on the moves stops the browser scrolling on
    // its own, so this rAF loop is the only thing that scrolls during a drag.
    const EDGE = 90; // px zone from each edge
    const MAX_SPEED = 22; // px per frame at the very edge
    let scrollRaf: number | null = null;
    const reorder = (): void => {
      const after = dragAfter(container, curY);
      if (after == null) container.appendChild(row);
      else container.insertBefore(row, after);
    };
    const autoScroll = (): void => {
      const h = window.innerHeight;
      let dy = 0;
      if (curY < EDGE) dy = -Math.ceil(((EDGE - curY) / EDGE) * MAX_SPEED);
      else if (curY > h - EDGE) dy = Math.ceil(((curY - (h - EDGE)) / EDGE) * MAX_SPEED);
      if (dy !== 0) {
        window.scrollBy(0, dy);
        reorder(); // the shelf slid under the finger — re-place the row for the new positions
      }
      scrollRaf = requestAnimationFrame(autoScroll);
    };
    // Listen on `window`, NOT the handle. Reordering moves `row` (and its child handle) in the
    // DOM via insertBefore, which on touch (iOS Safari) drops the handle's pointer capture — so
    // handle-bound pointermove stops firing and the drag "sticks" after the first step. Window
    // listeners keep receiving the moves regardless.
    const move = (ev: PointerEvent): void => {
      if (ev.cancelable) ev.preventDefault();
      curY = ev.clientY;
      reorder();
    };
    const up = (): void => {
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      row.classList.remove('dragging');
      onDrop();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    scrollRaf = requestAnimationFrame(autoScroll);
  });
}

async function removeFromDetail(albumId: string): Promise<void> {
  const extra = EXTRA_MEDIA.find((m) => m.shelfId === openShelfId);
  // 'all'/'playlists'/the extra-media shelves are library-wide removals; named shelves detach.
  const fromLibrary = openShelfId === 'all' || openShelfId === 'playlists' || !!extra;
  try {
    if (fromLibrary) await client.removeFromShelf(albumId);
    else if (openShelfId) await client.removeAlbumFromShelf(openShelfId, albumId);
    detailItems = detailItems.filter((it) => it.albumId !== albumId);
    renderShelfDetail();
    showToast(
      openShelfId === 'playlists' ? 'Removed playlist' : extra ? `Removed ${extra.kind === 'radio' ? 'station' : extra.kind}` : fromLibrary ? 'Removed from library' : 'Taken out of shelf',
    );
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

/* ================= Settings (iOS-style categories; mirrors the wall) ================= */
let settingsPlayers: Player[] = [];
/** Whether a player is exposed to the wall: an explicit exposure list wins, else the
    default (real speakers only). Used by the exposure chips and the group presets. */
function isExposed(p: Player): boolean {
  const ex = settings?.exposedPlayers;
  return ex && ex.length ? ex.includes(p.id) : isSpeaker(p.type);
}
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
  ['pinchZoom', 'Pinch to zoom', [['spines', 'Resize spines'], ['loupe', 'Magnifier loupe'], ['off', 'Off']]],
  ['afterPlay', 'After playing', [['close', 'Close'], ['linger', 'Linger'], ['stay', 'Stay open']]],
  ['afterAlbum', 'When an album ends', [['next', 'Play next on shelf'], ['repeat', 'Repeat album'], ['stop', 'Stop']]],
  ['idleContent', 'When idle, show', [['nothing', 'Nothing'], ['nowPlaying', 'Now playing'], ['currentShelf', 'Current shelf'], ['shelf', 'A shelf'], ['slideshow', 'Slideshow']]],
  ['autoOpenPool', 'Slideshow from', [['all', 'All albums'], ['current', 'Current shelf'], ['shelf', 'A specific shelf']]],
];
const SETTING_NUMBERS: Array<[keyof Settings, string, number, number]> = [
  ['afterPlayLingerSec', 'Linger seconds', 1, 60],
  ['idleAfterMin', 'Go idle after (min, 0=never)', 0, 240],
  ['idleDimPercent', 'Idle dim brightness (%)', 1, 100],
  ['screenOffAfterMin', 'Screen off after (min, 0=never)', 0, 240],
  ['autoOpenEverySec', 'Slideshow every (sec)', 5, 300],
];
const SETTING_TOGGLES: Array<[keyof Settings, string]> = [
  ['openOnExternalPlay', 'Open album on outside playback'],
  ['idleDim', 'Dim while idle'],
  ['autoOpenRandom', 'Slideshow in random order'],
  ['idleUseSensor', 'Idle from proximity sensor (needs sensor)'],
  ['wakeOnSensor', 'Wake from proximity sensor (needs sensor)'],
  ['autoBrightness', 'Auto-brightness from ambient light (needs sensor)'],
];
// Settings persisted as booleans but edited via a two-option select.
const BOOL_SELECTS = new Set<keyof Settings>(['glowEnabled']);

/* One-line explainer for every setting — what it does and what its options mean.
   Rendered as a footnote under the control and mirrored to a title= hover tooltip. */
const SETTING_DESC: Partial<Record<keyof Settings, string>> = {
  // Spines
  spineMode: 'How each spine looks: “Real when available” uses the album’s own cover art; “Generated” always draws a typographic spine.',
  spineThickness: 'How chunky each jewel case appears — Thin, Medium, or Thick.',
  spineWidthMode: 'Spine widths: “Uniform” makes them equal; “By length” draws a double-wide spine for albums over 80 minutes (a 2-disc set), like a fatter case on the shelf.',
  spineTextDir: 'Direction the vertical spine text reads — top-to-bottom or bottom-to-top.',
  inkMode: 'Spine text color: “Contrast” picks light or dark for legibility; “Match accent” tints it with the album’s dominant color.',
  inkSize: 'Size of the spine text — Small, Medium, or Large.',
  inkWeight: 'Thickness of the spine text — Light, Regular, or Bold.',
  labelLayout: 'Where artist and title sit on the spine: “Split” separates them; Centered / Top / Bottom group them; “Varied” mixes placements across the shelf.',
  labelVary: '“Uniform” gives every spine the same type treatment; “Varied” randomizes fonts and sizes for a hand-made crate look.',
  yearDisplay: 'Show the release year on the spine: Off, Vertical (along the spine), or Horizontal.',
  yearPos: 'Which end of the spine shows the year — Top or Bottom.',
  yearEmphasis: 'How prominent the year looks — Thin or Bold.',
  // Albums
  openMode: 'What tapping a spine reveals: “Cover only” flips to the artwork; “Full card” also opens the track list and playback controls.',
  pinchZoom: 'What a two-finger pinch on the shelf does: “Resize spines” scales the shelf, “Magnifier loupe” shows a zoom lens, “Off” disables it.',
  afterPlay: 'What the open album card does once playback starts: Close it, Linger a few seconds, or Stay open.',
  afterPlayLingerSec: 'How long the card stays open after playback starts before closing — used when “After playing” is set to Linger. 1–60 seconds.',
  afterAlbum: 'What happens when an album’s last track ends: play the next album on the shelf, repeat the album, or stop.',
  glowEnabled: 'Whether an opened album casts a soft colored glow behind it.',
  glowRadius: 'How far the opened-album glow spreads — Small, Medium, or Large. (Only when Album glow is on.)',
  glowIntensity: 'How strong the opened-album glow is — Soft, Medium, or Bold. (Only when Album glow is on.)',
  // Display
  autoBrightness: 'Adjust screen brightness automatically from the ambient-light sensor. Requires sensor hardware.',
  // Idle (a timeline: go idle → show something → optionally screen off)
  idleAfterMin: 'Minutes with no interaction before the wall goes idle. 0 = never go idle.',
  idleUseSensor: 'Go idle when the proximity sensor stops detecting anyone nearby. Requires sensor hardware.',
  wakeOnSensor: 'Wake from idle when the proximity sensor detects someone approaching. Requires sensor hardware.',
  idleDim: 'Dim the screen while idle, to the brightness set below.',
  idleDimPercent: 'Backlight level while idle when “Dim while idle” is on. 1–100%.',
  screenOffAfterMin: 'Second idle stage: turn the screen off after this many minutes idle — so the wall can show idle content for a while, then sleep. 0 = never.',
  idleContent: 'What the wall shows when idle: nothing, the now-playing album, the current shelf, a specific shelf, or a slideshow that flips through albums.',
  idleShelf: 'The shelf shown for “A shelf”, or the slideshow’s source when it’s set to a specific shelf.',
  autoOpenEverySec: 'How often the slideshow advances to the next album. 5–300 seconds.',
  autoOpenPool: 'Which albums the slideshow draws from: all albums, the current shelf, or a specific shelf.',
  autoOpenRandom: 'Slideshow visits albums in random order instead of shelf order.',
  openOnExternalPlay: 'When music starts from another app (Sonos, a voice assistant, etc.), the idle wall flips that album open so it matches what’s playing.',
};
function appendDesc(field: HTMLElement, key: keyof Settings): void {
  const d = SETTING_DESC[key];
  if (!d) return;
  const p = document.createElement('p');
  p.className = 'field-desc';
  p.textContent = d;
  field.appendChild(p);
  field.title = d; // desktop hover tooltip; the footnote covers touch
}

async function loadSettingsPanel(): Promise<void> {
  try {
    const [players, s] = [await client.getPlayers(), await client.getSettings()];
    settings = s;
    settingsPlayers = players.players;
    // Start search filtered to the configured default source (map its name → the connected instance).
    if (s.defaultSource && s.defaultSource !== 'all') {
      const inst = sources.find((x) => x.name === s.defaultSource)?.instanceId;
      if (inst && curSource === 'all') {
        curSource = inst;
        syncSourceSel();
      }
    }
  } catch {
    /* keep whatever we had */
  }
  renderSettingsCats();
}

/* ---- One setting → a .field element ---- */
function selectField(key: keyof Settings, label: string, opts: Array<[string, string]>): HTMLElement {
  const field = document.createElement('div');
  field.className = 'field';
  const sel = document.createElement('select');
  for (const [v, l] of opts) {
    const o = new Option(l, v);
    if (String(settings![key]) === v) o.selected = true;
    sel.add(o);
  }
  sel.addEventListener('change', () => {
    const val = BOOL_SELECTS.has(key) ? sel.value === 'true' : sel.value;
    void saveSetting(key, val as Settings[typeof key]);
  });
  field.innerHTML = `<label>${label}</label>`;
  field.appendChild(sel);
  appendDesc(field, key);
  return field;
}
function numberField(key: keyof Settings, label: string, min: number, max: number): HTMLElement {
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
  appendDesc(field, key);
  return field;
}
function toggleField(key: keyof Settings, label: string): HTMLElement {
  const tf = document.createElement('div');
  tf.className = 'field field-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!settings![key];
  cb.addEventListener('change', () => void saveSetting(key, cb.checked as Settings[typeof key]));
  // iOS-style row: label on the left, switch on the right.
  const row = document.createElement('label');
  row.className = 'switch-row';
  const span = document.createElement('span');
  span.className = 'switch-label';
  span.textContent = label;
  row.appendChild(span);
  row.appendChild(cb);
  tf.appendChild(row);
  appendDesc(tf, key);
  return tf;
}
function idleShelfField(): HTMLElement {
  const f = document.createElement('div');
  f.className = 'field';
  const sel = document.createElement('select');
  const all = new Option('All', '');
  if (!settings!.idleShelf) all.selected = true;
  sel.add(all);
  for (const sh of shelves.filter((s) => s.id !== 'all')) {
    const o = new Option(sh.name, sh.id);
    if (settings!.idleShelf === sh.id) o.selected = true;
    sel.add(o);
  }
  sel.addEventListener('change', () => void saveSetting('idleShelf', sel.value || null));
  f.innerHTML = '<label>Idle / auto-open shelf</label>';
  f.appendChild(sel);
  appendDesc(f, 'idleShelf');
  return f;
}
function settingField(key: keyof Settings): HTMLElement | null {
  let f: HTMLElement | null = null;
  const s = SETTING_SELECTS.find((x) => x[0] === key);
  if (s) f = selectField(s[0], s[1], s[2]);
  const n = SETTING_NUMBERS.find((x) => x[0] === key);
  if (!f && n) f = numberField(n[0], n[1], n[2], n[3]);
  const t = SETTING_TOGGLES.find((x) => x[0] === key);
  if (!f && t) f = toggleField(t[0], t[1]);
  if (f) f.dataset['key'] = String(key);
  return f;
}
function fieldGrid(keys: Array<keyof Settings>): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  for (const k of keys) {
    const f = settingField(k);
    if (f) grid.appendChild(f);
  }
  return grid;
}

/* ---- Categories (iOS-style: index → detail) ---- */
const CAT_ICON: Record<string, string> = {
  players: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14" r="3.2"/><circle cx="12" cy="7.5" r="1"/></svg>',
  spines: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="3.2" height="14" rx="1"/><rect x="10.4" y="5" width="3.2" height="14" rx="1"/><rect x="16.8" y="5" width="3.2" height="14" rx="1"/></svg>',
  albums: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.2"/></svg>',
  display: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M16.9 16.9l2.1 2.1M19.1 4.9l-2.1 2.1M6.9 16.9l-2.1 2.1"/></svg>',
  idle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  sleep: '<svg viewBox="0 0 24 24"><path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5Z"/></svg>',
  system: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2"/></svg>',
  ma: '<svg viewBox="0 0 24 24"><path d="M9 17V5l11-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="17" cy="15" r="3"/></svg>',
  backup: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  security: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};
interface SettingsCat {
  id: string;
  name: string;
  render: (body: HTMLElement) => void;
}
const SETTINGS_CATS: SettingsCat[] = [
  { id: 'players', name: 'Players', render: renderPlayersCat },
  { id: 'ma', name: 'Audio Sources', render: renderMaCat },
  {
    id: 'spines',
    name: 'Spines',
    render: (b) =>
      renderKeyGroups(b, [
        { header: 'Spine', keys: ['spineMode', 'spineThickness', 'spineWidthMode', 'spineTextDir'] },
        { header: 'Label', keys: ['inkMode', 'inkSize', 'inkWeight', 'labelLayout', 'labelVary'] },
        { header: 'Year', keys: ['yearDisplay', 'yearPos', 'yearEmphasis'] },
      ]),
  },
  {
    id: 'albums',
    name: 'Albums',
    render: (b) => renderKeyGroups(b, [{ keys: ['openMode', 'pinchZoom', 'afterPlay', 'afterPlayLingerSec', 'afterAlbum', 'glowEnabled', 'glowRadius', 'glowIntensity'] }]),
  },
  { id: 'display', name: 'Display & Brightness', render: renderDisplayCat },
  { id: 'idle', name: 'Idle', render: renderIdleCat },
  { id: 'sleep', name: 'Sleep Schedule', render: (b) => renderSchedule(b) },
  { id: 'backup', name: 'Backup', render: renderBackupCat },
  { id: 'security', name: 'Security', render: renderSecurityCat },
  { id: 'system', name: 'System', render: renderSystemCat },
];

function renderKeyGroups(body: HTMLElement, groups: Array<{ header?: string; keys: Array<keyof Settings> }>): void {
  for (const g of groups) {
    if (g.header) {
      const h = document.createElement('div');
      h.className = 'set-subhead';
      h.textContent = g.header;
      body.appendChild(h);
    }
    body.appendChild(fieldGrid(g.keys));
  }
}
function renderPlayersCat(body: HTMLElement): void {
  const f = document.createElement('div');
  f.className = 'field';
  f.innerHTML = '<label>Default speaker <span class="hint">(where albums play when none is picked)</span></label>';
  const sel = document.createElement('select');
  sel.add(new Option('(auto — first available)', ''));
  for (const p of settingsPlayers) {
    const o = new Option(p.available ? p.name : `${p.name} (offline)`, p.id);
    if (settings!.defaultPlayerId === p.id) o.selected = true;
    sel.add(o);
  }
  sel.addEventListener('change', () => {
    void client.putSettings({ defaultPlayerId: sel.value || null }).catch(() => {});
    showToast('Saved');
  });
  f.appendChild(sel);
  body.appendChild(f);

  renderExposureSection(body);
  renderPresetsSection(body);
}

/** Which players the wall may show/target. null = the default (real speakers only —
    matching the wall); an explicit list = exactly those players (any type). */
function renderExposureSection(body: HTMLElement): void {
  const h = document.createElement('div');
  h.className = 'set-subhead';
  h.textContent = 'Shown on the wall';
  body.appendChild(h);
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Speakers are shown by default; other devices (web / computer) are hidden — check one to add it.';
  body.appendChild(hint);
  // Speakers first, then other devices; each marked so the wall and admin agree.
  const ordered = [...settingsPlayers].sort((a, b) => Number(isSpeaker(b.type)) - Number(isSpeaker(a.type)));
  // The default (null) exposes real speakers only — reflect that in the chip state.
  const effectiveOn = (p: Player): boolean => {
    const ex = settings!.exposedPlayers;
    return ex && ex.length ? ex.includes(p.id) : isSpeaker(p.type);
  };
  const speakerDefault = new Set(settingsPlayers.filter((p) => isSpeaker(p.type)).map((p) => p.id));
  const sameAsDefault = (s: Set<string>): boolean => s.size === speakerDefault.size && [...s].every((id) => speakerDefault.has(id));
  const grid = document.createElement('div');
  grid.className = 'chip-grid';
  for (const p of ordered) {
    const chip = document.createElement('button');
    chip.className = 'pick-chip' + (isSpeaker(p.type) ? '' : ' other') + (p.available ? '' : ' offline') + (effectiveOn(p) ? ' on' : '');
    chip.textContent = p.available ? p.name : `${p.name} (offline)`;
    if (!isSpeaker(p.type)) chip.title = 'Not a speaker (web / computer)';
    chip.addEventListener('click', () => {
      const cur = new Set(settingsPlayers.filter(effectiveOn).map((x) => x.id));
      if (cur.has(p.id)) cur.delete(p.id);
      else cur.add(p.id);
      // Back to the plain speaker default → store null; else an explicit list.
      const next = cur.size === 0 || sameAsDefault(cur) ? null : [...cur];
      void saveSetting('exposedPlayers', next);
      chip.classList.toggle('on', next === null ? isSpeaker(p.type) : next.includes(p.id));
    });
    grid.appendChild(chip);
  }
  body.appendChild(grid);
}

/** Named one-tap groups the wall offers in its picker. */
function renderPresetsSection(body: HTMLElement): void {
  const h = document.createElement('div');
  h.className = 'set-subhead';
  h.textContent = 'Group presets';
  body.appendChild(h);
  const phint = document.createElement('p');
  phint.className = 'hint';
  phint.textContent = 'Named sets of speakers the wall offers as one-tap options in its play-to picker — e.g. “Downstairs” = Kitchen + Living Room.';
  body.appendChild(phint);
  const list = document.createElement('div');
  list.className = 'preset-list';
  body.appendChild(list);

  if (!settings!.groupPresets) settings!.groupPresets = [];
  const save = (): void => void saveSetting('groupPresets', settings!.groupPresets);
  const draw = (): void => {
    list.innerHTML = '';
    settings!.groupPresets.forEach((preset, i) => list.appendChild(presetEditor(preset, i, save, draw)));
    if (settings!.groupPresets.length === 0) {
      const e = document.createElement('p');
      e.className = 'hint';
      e.textContent = 'No presets yet.';
      list.appendChild(e);
    }
  };
  draw();

  const add = document.createElement('button');
  add.className = 'ghost';
  add.textContent = '+ New preset';
  add.addEventListener('click', () => {
    settings!.groupPresets = [...settings!.groupPresets, { id: presetId(), name: 'New group', playerIds: [] }];
    save();
    draw();
  });
  body.appendChild(add);
}

function presetId(): string {
  return 'gp-' + Math.random().toString(36).slice(2, 9);
}

function presetEditor(preset: GroupPreset, index: number, save: () => void, redraw: () => void): HTMLElement {
  const card = document.createElement('div');
  card.className = 'preset-card';
  const top = document.createElement('div');
  top.className = 'preset-top';
  const name = document.createElement('input');
  name.type = 'text';
  name.value = preset.name;
  name.placeholder = 'Preset name';
  name.addEventListener('change', () => {
    preset.name = name.value.trim() || 'Group';
    save();
  });
  const del = document.createElement('button');
  del.className = 'sh-del';
  del.textContent = '✕';
  del.title = 'Delete preset';
  del.addEventListener('click', () => {
    settings!.groupPresets = settings!.groupPresets.filter((_, i) => i !== index);
    save();
    redraw();
  });
  top.append(name, del);
  card.appendChild(top);

  const grid = document.createElement('div');
  grid.className = 'chip-grid';
  // Only players exposed to the wall are groupable — plus any already saved in this preset
  // (so a player later un-exposed still shows here and can be removed).
  for (const p of settingsPlayers.filter((p) => isExposed(p) || preset.playerIds.includes(p.id))) {
    const chip = document.createElement('button');
    const on = preset.playerIds.includes(p.id);
    chip.className = 'pick-chip' + (on ? ' on' : '');
    chip.textContent = p.name;
    chip.addEventListener('click', () => {
      preset.playerIds = preset.playerIds.includes(p.id) ? preset.playerIds.filter((x) => x !== p.id) : [...preset.playerIds, p.id];
      chip.classList.toggle('on', preset.playerIds.includes(p.id));
      save();
    });
    grid.appendChild(chip);
  }
  card.appendChild(grid);
  return card;
}

function renderDisplayCat(body: HTMLElement): void {
  const f = document.createElement('div');
  f.className = 'field';
  f.innerHTML = '<label>Brightness</label>';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '8';
  range.max = '100';
  range.value = '100';
  range.addEventListener('change', () => void client.setBrightness(Number(range.value)).catch(() => {}));
  f.appendChild(range);
  const bhint = document.createElement('p');
  bhint.className = 'field-desc';
  bhint.textContent = 'Screen backlight level right now, 8–100%. (Idle dimming is set under Idle.)';
  f.appendChild(bhint);
  body.appendChild(f);
  void client.getSystemStatus().then((st) => (range.value = String(st.brightness ?? 100))).catch(() => {});
  const auto = settingField('autoBrightness');
  if (auto) body.appendChild(auto);
}
function renderIdleCat(body: HTMLElement): void {
  const s = settings!;
  const redraw = (): void => {
    body.innerHTML = '';
    renderIdleCat(body);
    cardifySettings(body, 'idle');
  };
  // A field whose value gates others: re-render the category when it changes so the
  // dependent rows appear/disappear right away (the value is saved first, synchronously).
  const gate = (grid: HTMLElement, key: string): HTMLElement => {
    grid.querySelector(`[data-key="${key}"] select, [data-key="${key}"] input`)?.addEventListener('change', redraw);
    return grid;
  };
  const sub = (label: string): void => {
    const h = document.createElement('div');
    h.className = 'set-subhead';
    h.textContent = label;
    body.appendChild(h);
  };

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Idle is a short timeline: after a while the wall goes idle and shows something (a shelf, now-playing, or a slideshow), then optionally turns the screen off after longer.';
  body.appendChild(hint);

  // Stage 1 — when to go idle.
  sub('Go idle');
  body.appendChild(fieldGrid(['idleAfterMin', 'idleUseSensor', 'wakeOnSensor']));

  // While idle — dim (brightness only when dimming on) + the screen-off stage.
  sub('While idle');
  body.appendChild(gate(fieldGrid(s.idleDim ? ['idleDim', 'idleDimPercent'] : ['idleDim']), 'idleDim'));
  body.appendChild(fieldGrid(['screenOffAfterMin']));

  // What to show, incl. the slideshow sub-options + the single shelf picker.
  sub('When idle, show');
  body.appendChild(gate(fieldGrid(['idleContent']), 'idleContent'));
  if (s.idleContent === 'slideshow') {
    body.appendChild(gate(fieldGrid(['autoOpenEverySec', 'autoOpenPool', 'autoOpenRandom']), 'autoOpenPool'));
  }
  if (s.idleContent === 'shelf' || (s.idleContent === 'slideshow' && s.autoOpenPool === 'shelf')) {
    body.appendChild(idleShelfField());
  }

  // Reactive reveal when audio starts from outside Crate.
  sub('Outside playback');
  body.appendChild(fieldGrid(['openOnExternalPlay']));
}
/** A ↻ button that restarts one service (reloads a front-end / reconnects MA / restarts
    the server process). Restarting the app you're using reloads you; another app is remote. */
function svcRestartBtn(s: ServiceHealth): HTMLButtonElement {
  const reconnect = s.id === 'musicAssistant';
  const btn = document.createElement('button');
  btn.className = 'svc-restart';
  btn.textContent = '↻';
  btn.title = reconnect ? 'Reconnect Music Assistant' : `Restart ${s.name}`;
  btn.setAttribute('aria-label', btn.title);
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void client
      .restartService(s.id)
      .then((r) => showToast(r.ok ? (reconnect ? 'Reconnecting…' : `Restarting ${s.name}…`) : 'Not available'))
      .catch(() => showToast('Failed'))
      .finally(() => setTimeout(() => (btn.disabled = false), 1500));
  });
  return btn;
}

function renderSystemCat(body: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'sys-actions';
  const mk = (label: string, fn: () => Promise<unknown>, danger = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'ghost' + (danger ? ' danger' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if (danger && !confirm(`${label}?`)) return;
      void fn().then(() => showToast(`${label}…`)).catch(() => showToast('Failed'));
    });
    return b;
  };
  wrap.append(
    mk('Refresh art', () => client.refreshArtwork()),
    mk('Restart app', () => client.restartApp(), true),
    mk('Reboot', () => client.reboot(), true),
  );
  body.appendChild(wrap);

  // Service status — the three apps (Server / Shelf / Admin) + Music Assistant.
  const svcHead = document.createElement('div');
  svcHead.className = 'set-subhead';
  svcHead.textContent = 'Services';
  body.appendChild(svcHead);
  const svc = document.createElement('div');
  svc.className = 'svc-list';
  body.appendChild(svc);
  const renderSvc = (list: ServiceHealth[]): void => {
    svc.innerHTML = '';
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'svc-row';
      row.innerHTML =
        `<span class="svc-dot ${s.online ? 'up' : 'down'}"></span>` +
        `<span class="svc-name">${esc(s.name)}</span>` +
        `<span class="svc-detail">${esc(s.detail ?? '')}</span>`;
      if (s.restartable) row.appendChild(svcRestartBtn(s));
      svc.appendChild(row);
    }
  };
  const loadSvc = (): void =>
    void client
      .getServices()
      .then((r) => renderSvc(r.services))
      .catch(() => (svc.innerHTML = '<p class="hint">Status unavailable</p>'));
  loadSvc();
  // Poll while this category is on screen; self-clears once the node is detached (nav away).
  const svcTimer = setInterval(() => {
    if (!svc.isConnected) return clearInterval(svcTimer);
    loadSvc();
  }, 5000);

  // Device status — LAN IP address and running app version.
  const status = document.createElement('div');
  status.className = 'sys-status';
  const ipEl = document.createElement('div');
  ipEl.className = 'sys-line';
  ipEl.innerHTML = '<span class="sys-key">IP address</span><span class="sys-val" id="sys-ip">…</span>';
  const verEl = document.createElement('div');
  verEl.className = 'sys-line';
  verEl.innerHTML = '<span class="sys-key">Version</span><span class="sys-val" id="sys-ver">…</span>';
  status.append(ipEl, verEl);
  body.appendChild(status);
  void client
    .getSystemStatus()
    .then((st) => {
      (status.querySelector('#sys-ip') as HTMLElement).textContent = st.ip ?? 'Unavailable';
      (status.querySelector('#sys-ver') as HTMLElement).textContent = st.version || '—';
    })
    .catch(() => {
      (status.querySelector('#sys-ip') as HTMLElement).textContent = 'Unavailable';
      (status.querySelector('#sys-ver') as HTMLElement).textContent = '—';
    });

  // Software update — check git for a newer Crate; update Crate and/or the co-hosted
  // Music Assistant. The updater runs on the appliance and never touches MA's data.
  const upHead = document.createElement('div');
  upHead.className = 'set-subhead';
  upHead.textContent = 'Software update';
  body.appendChild(upHead);
  const up = document.createElement('div');
  up.className = 'sw-update';
  const swStatus = document.createElement('div');
  swStatus.className = 'sw-versions';
  swStatus.innerHTML = '<span class="hint">Checking…</span>';
  const swActions = document.createElement('div');
  swActions.className = 'sys-actions';
  up.append(swStatus, swActions);
  body.appendChild(up);

  const startUpdate = (target: UpdateTarget, label: string, note: string): void => {
    if (!confirm(`${label}?`)) return;
    void client
      .runUpdate(target)
      .then((r) => {
        if (!r.started) return showToast('Updates run on the appliance');
        showUpdateProgress(target, note);
      })
      .catch(() => showToast('Failed to start update'));
  };

  // Live progress for a running update: poll the crate-update journal, show the log tail, and
  // detect completion — including the server restart a Crate update triggers (we lose contact,
  // then it returns on the new build → reload the wall).
  const showUpdateProgress = (target: UpdateTarget, note: string): void => {
    up.querySelector('.sw-note')?.remove();
    swActions.innerHTML = '';
    swStatus.innerHTML = '<div class="sw-prog"><div class="sw-prog-status"></div><pre class="sw-log" aria-live="polite"></pre></div>';
    const statusEl = swStatus.querySelector('.sw-prog-status') as HTMLElement;
    const logEl = swStatus.querySelector('.sw-log') as HTMLElement;
    statusEl.textContent = note;
    const isCrate = target !== 'ma';
    let restarting = false;
    let tries = 0;
    const done = (msg: string, ok: boolean, reload: boolean): void => {
      statusEl.textContent = msg;
      statusEl.classList.toggle('sw-fail', !ok);
      if (reload) return void setTimeout(() => location.reload(), 1800);
      const back = document.createElement('button');
      back.className = 'ghost';
      back.textContent = 'Done';
      back.addEventListener('click', doCheck);
      swActions.appendChild(back);
    };
    const poll = async (): Promise<void> => {
      if (++tries > 180) return done('Still running — check `journalctl -u crate-update -f` on the Pi.', false, false);
      let prog: UpdateProgress;
      try {
        prog = await client.updateProgress();
      } catch {
        // Server unreachable → almost certainly the Crate restart. Note it and keep waiting.
        if (isCrate) {
          restarting = true;
          statusEl.textContent = 'Restarting Crate…';
        }
        setTimeout(() => void poll(), 2000);
        return;
      }
      if (restarting) return done('Updated — reloading the wall…', true, true);
      if (prog.log.length) logEl.textContent = prog.log.slice(-16).join('\n');
      if (prog.active) {
        statusEl.textContent = 'Updating…';
        setTimeout(() => void poll(), 2000);
        return;
      }
      // Finished without a restart: a no-op ("already up to date"), an MA-only update, or a failure.
      if (/failed|fatal:|EACCES|error:/i.test(prog.log.slice(-6).join('\n'))) {
        return done('Update failed — the previous version is still running. See the log.', false, false);
      }
      done(target === 'ma' ? 'Music Assistant updated.' : 'Already up to date — nothing to do.', true, false);
    };
    void poll();
  };

  // One "App — current / latest-on-GitHub" block. `cur`/`latest` are pre-built HTML.
  const verRow = (app: string, cur: string, latest: string, isUpd: boolean): string =>
    `<div class="sw-row"><div class="sw-head"><span class="sw-app">${esc(app)}</span> <span class="sw-cur">${cur}</span></div>` +
    (latest ? `<div class="sw-latest${isUpd ? ' has-update' : ''}">${latest}</div>` : '') +
    '</div>';

  const doCheck = (): void => {
    swStatus.innerHTML = '<span class="hint">Checking…</span>';
    swActions.innerHTML = '';
    up.querySelector('.sw-note')?.remove();
    void client
      .checkUpdate()
      .then((u: UpdateStatus) => {
        // Crate: declared version + running SHA; latest = the tracked GitHub tip.
        const crateCur = `${esc(u.crateVersion)}${u.current && u.current !== u.crateVersion ? ` · <code>${esc(u.current)}</code>` : ''}`;
        let crateLatest: string;
        let crateUpd = false;
        if (u.error === 'not-a-git-checkout') {
          crateLatest = 'container deploy — pull a new image (see INSTALL.md)';
        } else if (u.error) {
          crateLatest = `couldn’t check: ${esc(u.error.replace(/\s+/g, ' ').trim().slice(0, 90))}`;
        } else if (u.updateAvailable) {
          crateLatest = `GitHub <code>${esc(u.latest ?? '?')}</code> · ${u.behind} commit${u.behind === 1 ? '' : 's'} behind`;
          crateUpd = true;
        } else {
          crateLatest = `up to date${u.latest ? ` (GitHub <code>${esc(u.latest)}</code>)` : ''}`;
        }
        const rows = [verRow('Crate', crateCur, crateLatest, crateUpd)];
        // Music Assistant: running version vs latest GitHub release (when connected/co-hosted).
        if (u.maVersion || u.managesMa) {
          const maCur = u.maVersion ? esc(u.maVersion) : 'not connected';
          let maLatest = '';
          let maUpd = false;
          if (u.maVersion) {
            if (u.maLatest == null) maLatest = 'couldn’t reach GitHub';
            else if (u.maUpdateAvailable) {
              maLatest = `GitHub ${esc(u.maLatest)} · update available`;
              maUpd = true;
            } else maLatest = `up to date (GitHub ${esc(u.maLatest)})`;
          }
          rows.push(verRow('Music Assistant', maCur, maLatest, maUpd));
        }
        swStatus.innerHTML = rows.join('');

        // Actions.
        const crateBtn = document.createElement('button');
        crateBtn.className = 'ghost';
        crateBtn.textContent = 'Update Crate';
        // Enable when there's a known update, or when the check itself failed (don't let a
        // flaky root-side check block the updater, which runs git as the repo owner). A
        // confirmed up-to-date checkout, or a container (non-git) deploy, leaves it disabled.
        crateBtn.disabled = !(u.appliance && u.error !== 'not-a-git-checkout' && (u.updateAvailable || !!u.error));
        crateBtn.addEventListener('click', () =>
          startUpdate('crate', 'Update Crate now', 'Updating Crate — the wall restarts when it finishes (a few minutes).'),
        );
        swActions.appendChild(crateBtn);
        if (u.managesMa) {
          const maBtn = document.createElement('button');
          maBtn.className = 'ghost';
          maBtn.textContent = 'Update Music Assistant';
          // Enabled when a newer release exists, or the release couldn't be checked (allow forcing).
          maBtn.disabled = !(u.appliance && (u.maUpdateAvailable || u.maLatest == null));
          maBtn.title = 'Pulls the latest Music Assistant image and restarts it — your library is preserved.';
          maBtn.addEventListener('click', () =>
            startUpdate('ma', 'Update Music Assistant now', 'Updating Music Assistant — your library is preserved.'),
          );
          swActions.appendChild(maBtn);
        }
        const again = document.createElement('button');
        again.className = 'ghost';
        again.textContent = 'Check again';
        again.addEventListener('click', doCheck);
        swActions.appendChild(again);
        if (!u.appliance && u.error !== 'not-a-git-checkout') {
          const n = document.createElement('p');
          n.className = 'hint sw-note';
          n.textContent = 'Updates run on the wall appliance — or run deploy/pi/update.sh over SSH.';
          up.appendChild(n);
        }
      })
      .catch(() => {
        swStatus.innerHTML = '<span class="hint">Check failed.</span>';
      });
  };
  // Auto-check on open so the current version and how it compares to GitHub are
  // always visible — no click needed to see whether an update is waiting. doCheck
  // renders its own "Check again" button and the Update buttons when a check lands.
  doCheck();

  // Automatic updates — scheduled check + optional hands-off install (appliance only; Crate).
  const auHead = document.createElement('div');
  auHead.className = 'set-subhead';
  auHead.textContent = 'Automatic updates';
  body.appendChild(auHead);
  const auHint = document.createElement('p');
  auHint.className = 'hint';
  auHint.textContent = 'Check for new Crate versions on a schedule, at a quiet hour (an install restarts the wall). Runs on the wall appliance.';
  body.appendChild(auHint);
  const au = document.createElement('div');
  au.className = 'sw-update';
  body.appendChild(au);
  const hourLabel = (h: number): string =>
    h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`;
  const auSelect = (opts: Array<[string, string]>, val: string, onChange: (v: string) => void): HTMLSelectElement => {
    const s = document.createElement('select');
    for (const [v, l] of opts) s.add(new Option(l, v));
    s.value = val;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const renderAuto = (c: AutoUpdateConfig): void => {
    au.innerHTML = '';
    const save = (patch: Partial<Pick<AutoUpdateConfig, 'mode' | 'frequency' | 'hour'>>): void =>
      void client.setAutoUpdate(patch).then(renderAuto).catch(() => showToast('Failed'));
    const field = (label: string, control: HTMLElement): HTMLElement => {
      const f = document.createElement('div');
      f.className = 'field';
      f.innerHTML = `<label>${label}</label>`;
      f.appendChild(control);
      return f;
    };
    au.appendChild(
      field(
        'When an update is available',
        auSelect([['off', 'Off'], ['notify', 'Notify me only'], ['install', 'Install automatically']], c.mode, (v) =>
          save({ mode: v as AutoUpdateConfig['mode'] }),
        ),
      ),
    );
    if (c.mode !== 'off') {
      au.appendChild(
        field('Check', auSelect([['daily', 'Daily'], ['weekly', 'Weekly']], c.frequency, (v) => save({ frequency: v as AutoUpdateConfig['frequency'] }))),
      );
      const hours = Array.from({ length: 24 }, (_, h) => [String(h), hourLabel(h)] as [string, string]);
      au.appendChild(field('At', auSelect(hours, String(c.hour), (v) => save({ hour: Number(v) }))));
      const st = document.createElement('p');
      st.className = 'field-desc';
      st.textContent = `Last checked ${relTime(c.lastCheckAt)} · next ${relTime(c.nextRunAt)}${c.lastStatus ? ` · ${c.lastStatus}` : ''}`;
      au.appendChild(st);
      if (c.pending) {
        const pend = document.createElement('p');
        pend.className = 'sw-latest has-update';
        pend.textContent = 'An update is waiting — use “Update Crate” above to install it now.';
        au.appendChild(pend);
      }
    }
  };
  void client.getAutoUpdate().then(renderAuto).catch(() => (au.innerHTML = '<p class="hint">Unavailable.</p>'));
}

/* ---- Backup: config export / restore (Phase 5) ---- */
/** "18h ago" / "in 5h" style relative time. */
function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.abs(diff) / 1000;
  const v = s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return diff >= 0 ? `${v} ago` : `in ${v}`;
}
function renderBackupCat(body: HTMLElement): void {
  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = 'Save or restore your Crate configuration — settings, your library and its order, shelves, stacks, and playlist curation. Album artwork re-downloads after a restore.';
  body.appendChild(intro);

  const head = document.createElement('div');
  head.className = 'set-subhead';
  head.textContent = 'Backup file';
  body.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'sys-actions';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'ghost';
  exportBtn.textContent = 'Export backup';
  exportBtn.addEventListener('click', () => {
    exportBtn.disabled = true;
    void client
      .exportBackup()
      .then((data) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `crate-backup-${(data.exportedAt || '').slice(0, 10) || 'export'}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('Backup downloaded');
      })
      .catch(maErr)
      .finally(() => (exportBtn.disabled = false));
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'ghost danger';
  restoreBtn.textContent = 'Restore from file';
  restoreBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void file.text().then((text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        showToast('That file isn’t valid JSON');
        return;
      }
      if (!parsed || (parsed as { crate?: string }).crate !== 'crate-backup') {
        showToast('Not a Crate backup file');
        return;
      }
      const when = ((parsed as CrateBackup).exportedAt || '').slice(0, 10);
      if (!confirm(`Restore this backup${when ? ` from ${when}` : ''}?\n\nThis replaces your current library, shelves, and settings.`)) return;
      void client
        .importBackup(parsed as CrateBackup)
        .then((res) => showToast(`Restored ${res.counts.albums} albums · ${res.counts.shelves} shelves`))
        .catch(maErr);
    });
  });

  actions.append(exportBtn, restoreBtn);
  body.append(actions, fileInput);

  // --- GitHub auto-backup (its own re-renderable block) ---
  const ghHost = document.createElement('div');
  body.appendChild(ghHost);
  void renderGithubSection(ghHost);
}

/** Renders (and re-renders) the GitHub backup block: a repo dropdown once a token is saved,
    else a text field; branch / path / token; and back-up / restore actions. */
async function renderGithubSection(host: HTMLElement): Promise<void> {
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'set-subhead';
  head.textContent = 'GitHub';
  host.appendChild(head);
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Commit backups to a private GitHub repo — Crate can push a backup and restore from it. Needs a token with Contents: read & write (a classic “repo” token, or a fine-grained token scoped to the repo).';
  host.appendChild(hint);

  let cfg: GithubBackupConfig;
  try {
    cfg = await client.getGithubBackup();
  } catch {
    cfg = { repo: '', branch: 'main', path: 'crate-backup.json', hasToken: false, interval: 'off', lastBackupAt: null, lastStatus: null, nextBackupAt: null, history: [] };
  }

  const form = document.createElement('div');
  form.className = 'ma-form';
  host.appendChild(form);
  const field = (label: string): HTMLElement => {
    const f = document.createElement('div');
    f.className = 'field';
    const l = document.createElement('label');
    l.textContent = label;
    f.appendChild(l);
    return f;
  };

  // Repository: a dropdown of the token's repos once a token is saved, else a text box.
  const repoField = field('Repository');
  let repoControl: HTMLInputElement | HTMLSelectElement;
  if (cfg.hasToken) {
    const sel = document.createElement('select');
    sel.add(new Option('Loading your repositories…', cfg.repo));
    sel.disabled = true;
    repoControl = sel;
    repoField.appendChild(sel);
    void client
      .listGithubRepos()
      .then((repos) => {
        sel.innerHTML = '';
        sel.disabled = false;
        sel.add(new Option('— choose a repository —', ''));
        const names = new Set(repos.map((r) => r.fullName));
        if (cfg.repo && !names.has(cfg.repo)) sel.add(new Option(cfg.repo, cfg.repo));
        for (const r of repos) sel.add(new Option(r.private ? `${r.fullName} (private)` : r.fullName, r.fullName));
        sel.value = cfg.repo;
      })
      .catch((e) => {
        sel.innerHTML = '';
        sel.disabled = false;
        if (cfg.repo) sel.add(new Option(cfg.repo, cfg.repo));
        sel.add(new Option('Couldn’t load repos — check the token', ''));
        maErr(e);
      });
  } else {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'owner/repo';
    inp.value = cfg.repo;
    repoControl = inp;
    repoField.appendChild(inp);
    const note = document.createElement('p');
    note.className = 'field-desc';
    note.textContent = 'Apply a token above to pick from your repositories (or type owner/repo).';
    repoField.appendChild(note);
  }
  form.appendChild(repoField);

  const branchField = field('Branch');
  const branch = document.createElement('input');
  branch.type = 'text';
  branch.placeholder = 'main';
  branch.value = cfg.branch;
  branchField.appendChild(branch);

  const pathField = field('File path');
  const path = document.createElement('input');
  path.type = 'text';
  path.placeholder = 'crate-backup.json';
  path.value = cfg.path;
  pathField.appendChild(path);
  const pathNote = document.createElement('p');
  pathNote.className = 'field-desc';
  pathNote.textContent = 'Where the backup file lives in the repo. The default is fine — change it only to keep several Crate installs in one repo, or to use a subfolder.';
  pathField.appendChild(pathNote);
  // Branch + file path are rarely changed; they're tucked into an Advanced disclosure below.

  // Access token — put it FIRST (before the repo picker), since listing your repos needs it.
  // "Apply token" saves just the token and re-renders, which loads the repo list (and surfaces
  // a bad token there), so you apply the token, then choose the repo, then Save the rest.
  const tokenField = field('Access token');
  const token = document.createElement('input');
  token.type = 'password';
  token.placeholder = cfg.hasToken ? 'saved — leave blank to keep it' : 'github_pat_… or ghp_…';
  tokenField.appendChild(token);
  const tokenNote = document.createElement('p');
  tokenNote.className = 'field-desc';
  tokenNote.textContent = 'Stored on the server, never shown again. A fine-grained token needs Contents: Read and write on the repo (or a classic “repo” token).';
  tokenField.appendChild(tokenNote);
  const tokenActions = document.createElement('div');
  tokenActions.className = 'sys-actions';
  const applyToken = document.createElement('button');
  applyToken.className = 'ghost';
  applyToken.textContent = cfg.hasToken ? 'Update token' : 'Apply token';
  applyToken.addEventListener('click', () => {
    const t = token.value.trim();
    if (!t) return showToast(cfg.hasToken ? 'A token is already saved' : 'Enter a token first');
    applyToken.disabled = true;
    void client
      .setGithubBackup({ token: t })
      .then(() => {
        showToast('Token applied');
        void renderGithubSection(host); // re-render populates the repo list from the token
      })
      .catch((e) => {
        applyToken.disabled = false;
        maErr(e);
      });
  });
  tokenActions.appendChild(applyToken);
  tokenField.appendChild(tokenActions);
  form.insertBefore(tokenField, form.firstChild);

  // Automatic backup cadence.
  const autoField = field('Automatic backup');
  const autoSel = document.createElement('select');
  for (const [v, l] of [['off', 'Off — manual only'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly']] as const) {
    const o = new Option(l, v);
    if (cfg.interval === v) o.selected = true;
    autoSel.add(o);
  }
  autoSel.addEventListener('change', () => {
    void client
      .setGithubBackup({ interval: autoSel.value as GithubBackupConfig['interval'] })
      .then(() => { showToast('Saved'); void renderGithubSection(host); })
      .catch(maErr);
  });
  autoField.appendChild(autoSel);
  form.appendChild(autoField);

  // Advanced: branch + file path — sensible defaults; only matters for shared repos / subfolders.
  const advanced = document.createElement('details');
  advanced.className = 'ma-advanced';
  const advSummary = document.createElement('summary');
  advSummary.textContent = 'Advanced';
  advanced.append(advSummary, branchField, pathField);
  form.appendChild(advanced);

  // Status line: last attempt (+ status) and next scheduled run.
  const status = document.createElement('p');
  status.className = 'hint';
  const bits = [cfg.lastBackupAt ? `Last backup: ${relTime(cfg.lastBackupAt)}${cfg.lastStatus ? ` · ${cfg.lastStatus}` : ''}` : 'No GitHub backup yet.'];
  if (cfg.interval !== 'off' && cfg.nextBackupAt) bits.push(`Next: ${relTime(cfg.nextBackupAt)}`);
  status.textContent = bits.join(' · ');
  host.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'sys-actions';
  const saveCfg = document.createElement('button');
  saveCfg.className = 'ghost';
  saveCfg.textContent = 'Save GitHub settings';
  const pushBtn = document.createElement('button');
  pushBtn.className = 'ghost';
  pushBtn.textContent = 'Back up now';
  const testBtn = document.createElement('button');
  testBtn.className = 'ghost';
  testBtn.textContent = 'Test';
  const restore = document.createElement('button');
  restore.className = 'ghost danger';
  restore.textContent = 'Restore from GitHub';
  actions.append(saveCfg, pushBtn, testBtn, restore);
  host.appendChild(actions);

  // History log.
  if (cfg.history.length) {
    const histHead = document.createElement('div');
    histHead.className = 'set-subhead ma-hist-head';
    const label = document.createElement('span');
    label.textContent = 'History';
    const clear = document.createElement('button');
    clear.className = 'ma-hist-clear';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => void client.clearGithubHistory().then(() => renderGithubSection(host)).catch(maErr));
    histHead.append(label, clear);
    host.appendChild(histHead);
    const table = document.createElement('div');
    table.className = 'ma-hist';
    for (const e of cfg.history) {
      const row = document.createElement('div');
      row.className = 'ma-hist-row';
      const date = document.createElement('span');
      date.className = 'ma-hist-date';
      date.textContent = new Date(e.at).toLocaleString();
      const st = document.createElement('span');
      st.className = `ma-hist-status ${e.status}`;
      st.textContent = e.status;
      const commit = document.createElement('span');
      commit.className = 'ma-hist-commit';
      if (e.commit && e.url) {
        const a = document.createElement('a');
        a.href = e.url;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.textContent = e.commit;
        commit.appendChild(a);
      } else {
        commit.textContent = e.status === 'error' ? (e.message ?? 'error') : '—';
      }
      row.append(date, st, commit);
      table.appendChild(row);
    }
    host.appendChild(table);
  }

  saveCfg.addEventListener('click', () => {
    const addedToken = !!token.value.trim();
    saveCfg.disabled = true;
    void client
      .setGithubBackup({ repo: repoControl.value, branch: branch.value, path: path.value, ...(addedToken ? { token: token.value } : {}) })
      .then(() => { showToast('Saved'); void renderGithubSection(host); })
      .catch(maErr)
      .finally(() => (saveCfg.disabled = false));
  });
  pushBtn.addEventListener('click', () => {
    pushBtn.disabled = true;
    void client
      .pushGithubBackup()
      .then((r) => { showToast(r.status === 'skipped' ? 'No changes to back up' : 'Backed up to GitHub'); void renderGithubSection(host); })
      .catch(maErr)
      .finally(() => (pushBtn.disabled = false));
  });
  testBtn.addEventListener('click', () => {
    testBtn.disabled = true;
    void client
      .testGithubBackup()
      .then((r) => showToast(`Connected to ${r.repo}`))
      .catch(maErr)
      .finally(() => (testBtn.disabled = false));
  });
  restore.addEventListener('click', () => {
    if (!confirm('Restore from the backup in GitHub?\n\nThis replaces your current library, shelves, and settings.')) return;
    restore.disabled = true;
    void client
      .restoreGithubBackup()
      .then((res) => showToast(`Restored ${res.counts.albums} albums · ${res.counts.shelves} shelves`))
      .catch(maErr)
      .finally(() => (restore.disabled = false));
  });
}

/* ---- Music Assistant: status + source management (Phase 5) ---- */
let maProvidersCache: MaProviderManifest[] | null = null;

function maBackLink(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.className = 'ma-back';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function maErr(e: unknown): void {
  // MA failures come back as "… → 502 … {"error":"<message>"}" — surface just the message,
  // dropping MA's leading numeric error code (e.g. "999: ").
  const raw = e instanceof Error ? e.message : String(e);
  const m = /\{"error":"(.*?)"\}/.exec(raw);
  showToast((m ? m[1]! : 'Failed').replace(/^\d+:\s*/, ''));
}
function maDesc(field: HTMLElement, text: string): void {
  const d = document.createElement('p');
  d.className = 'field-desc';
  d.textContent = text;
  field.appendChild(d);
}

function drawMaStatus(el: HTMLElement, st: MaStatus): void {
  el.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'svc-row';
  const detail = st.connected
    ? `${st.host}${st.serverVersion ? ` · v${st.serverVersion}` : ''}${st.schemaVersion ? ` · schema ${st.schemaVersion}` : ''}`
    : st.host;
  row.innerHTML =
    `<span class="svc-dot ${st.connected ? 'up' : 'down'}"></span>` +
    `<span class="svc-name">${st.connected ? 'Connected' : 'Disconnected'}</span>` +
    `<span class="svc-detail">${esc(detail)}</span>`;
  el.appendChild(row);
  const actions = document.createElement('div');
  actions.className = 'sys-actions ma-status-actions';
  const reconnect = document.createElement('button');
  reconnect.className = 'ghost';
  reconnect.textContent = 'Reconnect';
  reconnect.addEventListener('click', () =>
    void client.restartService('musicAssistant').then(() => showToast('Reconnecting…')).catch(maErr),
  );
  actions.appendChild(reconnect);
  el.appendChild(actions);
  if (!st.managesMa) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Music Assistant runs on another host, so Crate configures it over the network but can’t restart it — restart it where it’s hosted if needed.';
    el.appendChild(note);
  }
}

function drawMaSources(list: HTMLElement, sources: MaSource[], reload: () => void): void {
  list.innerHTML = '';
  if (!sources.length) {
    list.innerHTML = '<p class="hint">No music sources configured.</p>';
    return;
  }
  for (const s of sources) {
    const row = document.createElement('div');
    row.className = 'svc-row ma-src-row';
    const ok = s.enabled && !s.lastError;
    const label = settings?.sourceLabels?.[s.instanceId];
    row.innerHTML =
      `<span class="svc-dot ${ok ? 'up' : 'down'}"></span>` +
      `<span class="svc-name">${esc(label || s.name)}${s.domain === 'builtin' ? '<span class="ma-tag">default</span>' : ''}</span>` +
      `<span class="svc-detail">${esc(s.lastError ?? s.domain)}</span>`;
    const acts = document.createElement('span');
    acts.className = 'ma-row-actions';
    // Rename = set a custom label (stored in Crate), so two accounts of the same service are
    // distinguishable in results + the filter. Not offered for the built-in aggregate provider.
    if (!s.builtin) {
      const editBtn = document.createElement('button');
      editBtn.className = 'ma-iconbtn';
      editBtn.title = 'Label this source';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', () => {
        const cur = settings?.sourceLabels?.[s.instanceId] ?? '';
        const next = prompt(`Label for this source (blank to reset).\nTell two accounts apart, e.g. “${s.name} — Alex”.`, cur);
        if (next === null) return;
        const labels: Record<string, string> = { ...(settings?.sourceLabels ?? {}) };
        const trimmed = next.trim();
        if (trimmed) labels[s.instanceId] = trimmed;
        else delete labels[s.instanceId];
        void client
          .putSettings({ sourceLabels: labels })
          .then(() => { if (settings) settings.sourceLabels = labels; showToast('Saved'); reload(); })
          .catch(maErr);
      });
      acts.appendChild(editBtn);
    }
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'ma-iconbtn';
    reloadBtn.title = 'Reload';
    reloadBtn.textContent = '⟳';
    reloadBtn.addEventListener('click', () =>
      void client.reloadMaSource(s.instanceId).then(() => showToast('Reloaded')).catch(maErr),
    );
    acts.appendChild(reloadBtn);
    if (s.builtin) {
      // MA's built-in provider can't be removed — show a lock instead of a remove button.
      const lock = document.createElement('span');
      lock.className = 'ma-iconbtn ma-lock';
      lock.title = 'Built-in Music Assistant provider — can’t be removed';
      lock.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      acts.appendChild(lock);
    } else {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ma-iconbtn danger';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        if (!confirm(`Remove “${s.name}” from Music Assistant?`)) return;
        void client.removeMaSource(s.instanceId).then(() => { showToast('Removed'); reload(); }).catch(maErr);
      });
      acts.appendChild(removeBtn);
    }
    row.appendChild(acts);
    list.appendChild(row);
  }
}

/** One config-flow entry → a field. Static (label/alert) types return a note; an entry with
    an `action` (e.g. OAuth) returns a button that advances the flow. Inputs write into `values`. */
function maField(en: MaConfigEntry, values: Record<string, MaConfigValue>, onChange: () => void, onAction: () => void): HTMLElement | null {
  if (en.type === 'label' || en.type === 'alert') {
    const p = document.createElement('p');
    p.className = en.type === 'alert' ? 'ma-alert' : 'hint';
    p.textContent = en.label;
    return p;
  }
  if (en.action) {
    const field = document.createElement('div');
    field.className = 'field';
    if (en.label) {
      const lab = document.createElement('label');
      lab.textContent = en.label;
      field.appendChild(lab);
    }
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = en.actionLabel ?? en.label ?? 'Continue';
    btn.addEventListener('click', onAction);
    field.appendChild(btn);
    if (en.description) maDesc(field, en.description);
    return field;
  }
  if (en.type === 'boolean') {
    const tf = document.createElement('div');
    tf.className = 'field field-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = values[en.key] === true;
    cb.addEventListener('change', () => { values[en.key] = cb.checked; onChange(); });
    const lab = document.createElement('label');
    lab.appendChild(cb);
    lab.append(' ' + en.label);
    tf.appendChild(lab);
    if (en.description) maDesc(tf, en.description);
    return tf;
  }
  const field = document.createElement('div');
  field.className = 'field';
  const lab = document.createElement('label');
  lab.textContent = en.label;
  field.appendChild(lab);
  if (en.options.length) {
    const sel = document.createElement('select');
    for (const o of en.options) {
      const opt = new Option(o.title, String(o.value));
      if (String(values[en.key]) === String(o.value)) opt.selected = true;
      sel.add(opt);
    }
    sel.addEventListener('change', () => {
      const chosen = en.options.find((o) => String(o.value) === sel.value);
      values[en.key] = chosen ? chosen.value : sel.value;
      onChange();
    });
    field.appendChild(sel);
  } else if (en.type === 'integer') {
    const inp = document.createElement('input');
    inp.type = 'number';
    if (en.range) { inp.min = String(en.range[0]); inp.max = String(en.range[1]); }
    inp.value = values[en.key] != null ? String(values[en.key]) : '';
    inp.addEventListener('change', () => { values[en.key] = inp.value === '' ? null : Number(inp.value); });
    field.appendChild(inp);
  } else {
    const inp = document.createElement('input');
    inp.type = en.type.includes('password') || en.type.includes('secure') ? 'password' : 'text';
    inp.value = values[en.key] != null ? String(values[en.key]) : '';
    inp.addEventListener('input', () => { values[en.key] = inp.value; });
    field.appendChild(inp);
  }
  if (en.description) maDesc(field, en.description);
  return field;
}

function renderMaCat(body: HTMLElement, opts?: { onboarding?: boolean }): void {
  const showList = (): void => {
    body.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'ma-status';
    card.innerHTML = '<p class="hint">Checking Music Assistant…</p>';
    body.appendChild(card);
    void client.getMaStatus().then((st) => drawMaStatus(card, st)).catch(() => (card.innerHTML = '<p class="hint">Status unavailable.</p>'));

    const head = document.createElement('div');
    head.className = 'set-subhead';
    head.textContent = 'Sources';
    body.appendChild(head);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'The streaming services and libraries Music Assistant plays from. Adding or removing one takes effect immediately. The built-in Music Assistant provider can’t be removed.';
    body.appendChild(hint);
    const list = document.createElement('div');
    list.className = 'svc-list ma-sources';
    list.innerHTML = '<p class="hint">Loading…</p>';
    body.appendChild(list);
    void client.getMaSources().then((all) => drawMaSources(list, all.filter((s) => s.type === 'music'), showList)).catch(() => (list.innerHTML = '<p class="hint">Couldn’t reach Music Assistant.</p>'));

    const add = document.createElement('button');
    add.className = 'ghost ma-add';
    add.textContent = '+ Add source';
    add.addEventListener('click', () => void showPicker());
    body.appendChild(add);

    // Built-in smart playlists — MA auto-generates these; off by default so they don't clutter search.
    // Hidden during onboarding (we hide them automatically there — no decision to make); the toggle
    // lives only in Settings for anyone who wants them back later.
    if (opts?.onboarding) return;
    const plField = document.createElement('div');
    plField.className = 'field field-toggle ma-builtin-pl';
    const plCb = document.createElement('input');
    plCb.type = 'checkbox';
    plCb.disabled = true;
    const plLab = document.createElement('label');
    plLab.appendChild(plCb);
    plLab.append(' Show built-in smart playlists');
    plField.appendChild(plLab);
    const plHint = document.createElement('p');
    plHint.className = 'field-desc';
    plHint.textContent = 'Music Assistant auto-generates playlists (Random Album, Infinite Mix, Recently played…). Turn this off to keep them out of Crate search.';
    plField.appendChild(plHint);
    body.appendChild(plField);
    void client.getMaBuiltinPlaylists().then((r) => { plCb.checked = r.enabled; plCb.disabled = false; }).catch(() => (plCb.disabled = false));
    plCb.addEventListener('change', () => {
      plCb.disabled = true;
      void client
        .setMaBuiltinPlaylists(plCb.checked)
        .then((r) => showToast(r.enabled ? 'Built-in playlists shown' : 'Built-in playlists hidden'))
        .catch((e) => { plCb.checked = !plCb.checked; maErr(e); })
        .finally(() => (plCb.disabled = false));
    });

    // Default search source — what search filters to by default (wall + admin); 'all' shows every source.
    const dsField = document.createElement('div');
    dsField.className = 'field';
    dsField.innerHTML = '<label>Default search source <span class="hint">(what search starts filtered to, on the wall and here)</span></label>';
    const dsSel = document.createElement('select');
    dsSel.add(new Option('All sources', 'all'));
    dsField.appendChild(dsSel);
    body.appendChild(dsField);
    void Promise.all([client.getSettings(), client.getSources()])
      .then(([st, srcs]) => {
        const seen = new Set<string>();
        for (const s of srcs) if (s.name && !seen.has(s.name)) { seen.add(s.name); dsSel.add(new Option(s.name, s.name)); }
        dsSel.value = st.defaultSource || 'all';
      })
      .catch(() => {});
    dsSel.addEventListener('change', () => { void client.putSettings({ defaultSource: dsSel.value }).catch(maErr); showToast('Saved'); });
  };

  const showPicker = async (): Promise<void> => {
    body.innerHTML = '';
    body.appendChild(maBackLink('‹ Sources', showList));
    const head = document.createElement('div');
    head.className = 'set-subhead';
    head.textContent = 'Add a source';
    body.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'ma-prov-grid';
    grid.innerHTML = '<p class="hint">Loading providers…</p>';
    body.appendChild(grid);
    try {
      const provs = maProvidersCache ?? (maProvidersCache = await client.getMaProviders());
      grid.innerHTML = '';
      for (const p of [...provs].sort((a, b) => a.name.localeCompare(b.name))) {
        const card = document.createElement('button');
        card.className = 'ma-prov';
        card.innerHTML = `<span class="ma-prov-ico">${p.iconSvg ?? ''}</span><span class="ma-prov-name">${esc(p.name)}</span>`;
        card.addEventListener('click', () => void showForm(p));
        grid.appendChild(card);
      }
    } catch {
      grid.innerHTML = '<p class="hint">Couldn’t load the provider list.</p>';
    }
  };

  const showForm = async (manifest: MaProviderManifest, state: { action?: string; values?: Record<string, MaConfigValue> } = {}): Promise<void> => {
    body.innerHTML = '';
    body.appendChild(maBackLink('‹ Add source', () => void showPicker()));
    const title = document.createElement('div');
    title.className = 'ma-form-title';
    title.innerHTML = `<span class="ma-prov-ico">${manifest.iconSvg ?? ''}</span><span>${esc(manifest.name)}</span>`;
    body.appendChild(title);
    if (manifest.documentation) {
      const doc = document.createElement('a');
      doc.className = 'ma-doclink';
      doc.href = manifest.documentation;
      doc.target = '_blank';
      doc.rel = 'noreferrer';
      doc.textContent = 'Setup guide ↗';
      body.appendChild(doc);
    }
    const formEl = document.createElement('div');
    formEl.className = 'ma-form';
    formEl.innerHTML = '<p class="hint">Loading…</p>';
    body.appendChild(formEl);

    let entries: MaConfigEntry[];
    try {
      entries = await client.getMaSourceEntries(manifest.domain, { action: state.action, values: state.values });
    } catch (e) {
      formEl.innerHTML = `<p class="hint">${esc(e instanceof Error ? e.message : 'Failed to load the form.')}</p>`;
      return;
    }

    const values: Record<string, MaConfigValue> = {};
    for (const en of entries) values[en.key] = en.value ?? en.default;
    Object.assign(values, state.values ?? {});

    const visible = (en: MaConfigEntry): boolean => {
      if (en.dependsOn == null) return true;
      const dv = values[en.dependsOn];
      if (en.dependsOnValue != null) return dv === en.dependsOnValue;
      if (en.dependsOnValueNot != null) return dv !== en.dependsOnValueNot;
      return dv != null && dv !== false && dv !== '';
    };

    // Interactive auth actions (Apple Music's MusicKit flow, Spotify/other OAuth): advance the action
    // with a fresh session id (its absence is what makes MA reject the flow with `999: 'session_id'`).
    // That call blocks server-side until sign-in finishes; meanwhile MA emits an `auth_session` event
    // with the REAL authorize URL (accounts.spotify.com/authorize, MA's MusicKit page, …), which Crate
    // captures — we poll for it, open the popup, then save the source once the flow returns credentials.
    // Non-auth actions (e.g. "Clear authentication") just re-fetch the form.
    const advanceAction = (en: MaConfigEntry): void => {
      const isAuth = !!en.action && /auth/i.test(en.action) && !/clear/i.test(en.action);
      if (!isAuth) {
        void showForm(manifest, { action: en.action ?? undefined, values });
        return;
      }
      // Open the popup window SYNCHRONOUSLY here in the click gesture (blank for now) so browsers
      // don't block it — we can't open it later from the async poll below without tripping popup
      // blockers. It gets pointed at the real authorize URL once MA emits it.
      const popup = window.open('', '_blank');
      void (async () => {
        const sessionId = `crate-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        formEl.innerHTML = `<p class="hint">Opening the ${esc(manifest.name)} sign-in…</p>`;
        const resultP = client.getMaSourceEntries(manifest.domain, { action: en.action ?? undefined, values: { ...values, session_id: sessionId } });
        resultP.catch(() => {}); // handled below — don't let it reject unhandled while we poll
        // Poll for the authorize URL MA emitted for this session, then point the popup at it.
        let opened = false;
        for (let i = 0; i < 40 && !opened; i++) {
          const { url } = await client.getMaAuthUrl(sessionId).catch((): { url: string | null } => ({ url: null }));
          if (url) {
            const open = url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)/, `$1${location.hostname}`); // co-hosted MA may say localhost
            if (popup && !popup.closed) popup.location.href = open;
            else window.open(open, '_blank', 'noopener');
            opened = true;
            formEl.innerHTML = `<p class="hint">Waiting for the ${esc(manifest.name)} sign-in in the new tab — finish it there, keep this tab open, and Crate adds the source automatically.</p>`;
          } else {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        if (!opened) {
          if (popup && !popup.closed) popup.close();
          formEl.innerHTML = `<p class="hint">Couldn’t get the ${esc(manifest.name)} sign-in link. Reopen the form to try again.</p>`;
        }
        let result: MaConfigEntry[];
        try {
          result = await resultP;
        } catch (e) {
          formEl.innerHTML = `<p class="hint">${esc(manifest.name)} sign-in didn’t complete (${esc(e instanceof Error ? e.message : 'error')}). Reopen the form to try again.</p>`;
          return;
        }
        const merged: Record<string, MaConfigValue> = { ...values };
        for (const e2 of result) merged[e2.key] = e2.value ?? e2.default;
        // Apple Music surfaces its MusicKit token here; its absence means the popup was cancelled.
        if (manifest.domain === 'apple_music' && !merged['music_user_token']) {
          showToast('Apple Music sign-in was cancelled');
          void showForm(manifest, { values: merged });
          return;
        }
        formEl.innerHTML = `<p class="hint">Signed in — adding ${esc(manifest.name)}…</p>`;
        try {
          await client.saveMaSource(manifest.domain, merged);
          showToast(`${manifest.name} added`);
          showList();
        } catch (e) {
          maErr(e);
          void showForm(manifest, { values: merged }); // fall back to the form so any required field can be filled
        }
      })();
    };

    const drawFields = (): void => {
      formEl.innerHTML = '';
      const advanced: HTMLElement[] = [];
      for (const en of entries) {
        if (en.hidden || !visible(en)) continue;
        const field = maField(en, values, drawFields, () => advanceAction(en));
        if (!field) continue;
        if (en.advanced) advanced.push(field);
        else formEl.appendChild(field);
      }
      if (advanced.length) {
        const det = document.createElement('details');
        det.className = 'ma-advanced';
        const sum = document.createElement('summary');
        sum.textContent = 'Advanced';
        det.appendChild(sum);
        advanced.forEach((f) => det.appendChild(f));
        formEl.appendChild(det);
      }
      const save = document.createElement('button');
      save.className = 'ghost ma-save';
      save.textContent = 'Add source';
      save.addEventListener('click', () => {
        save.disabled = true;
        void client
          .saveMaSource(manifest.domain, values)
          .then(() => { showToast(`${manifest.name} added`); showList(); })
          .catch((e) => { save.disabled = false; maErr(e); });
      });
      formEl.appendChild(save);
    };
    drawFields();
  };

  showList();
}

const settingsIndexEl = document.getElementById('settings-index') as HTMLElement;
const settingsDetailEl = document.getElementById('settings-detail') as HTMLElement;
const settingsCatBody = document.getElementById('settings-cat-body') as HTMLElement;
const settingsCatName = document.getElementById('settings-cat-name') as HTMLElement;
(document.getElementById('settings-back') as HTMLElement).addEventListener('click', () => history.back());
function renderSettingsCats(): void {
  const list = document.getElementById('settings-cats') as HTMLElement;
  list.innerHTML = '';
  for (const cat of SETTINGS_CATS) {
    const row = document.createElement('button');
    row.className = 'settings-cat';
    row.innerHTML = `<span class="cat-ico">${CAT_ICON[cat.id] ?? ''}</span><span class="cat-name">${esc(cat.name)}</span><span class="sh-chev">›</span>`;
    row.addEventListener('click', () => openSettingsCat(cat));
    list.appendChild(row);
  }
}
let currentSettingsCat: SettingsCat | null = null;
function openSettingsCat(cat: SettingsCat): void {
  if (!settings) return;
  currentSettingsCat = cat;
  settingsIndexEl.hidden = true;
  settingsDetailEl.hidden = false;
  pushDetailHistory();
  settingsCatName.textContent = cat.name;
  settingsCatBody.innerHTML = '';
  cat.render(settingsCatBody);
  cardifySettings(settingsCatBody, cat.id);
}
/** Re-render the open settings category in place (after a live players/settings update). */
function refreshOpenSettingsCat(): void {
  if (settingsDetailEl.hidden || !currentSettingsCat || !settings) return;
  settingsCatBody.innerHTML = '';
  currentSettingsCat.render(settingsCatBody);
  cardifySettings(settingsCatBody, currentSettingsCat.id);
}

/** Turn a freshly-rendered settings sub-page into FlightScnr-style collapsible cards:
    each `.set-subhead` section becomes a card with a tap-to-collapse header; any intro
    content before the first section stays above the cards, and single-section pages are
    left flat. Open/closed state is remembered per section. Always called on a raw body. */
function cardifySettings(body: HTMLElement, catId: string): void {
  const kids = Array.from(body.childNodes);
  const isSub = (n: Node): boolean => n instanceof HTMLElement && n.classList.contains('set-subhead');
  if (!kids.some(isSub)) return; // nothing to group — leave the page flat (just spacing)
  body.innerHTML = '';
  let i = 0;
  // Intro: anything before the first section header sits above the cards.
  while (i < kids.length && !isSub(kids[i]!)) body.appendChild(kids[i++]!);
  while (i < kids.length) {
    const head = kids[i++] as HTMLElement;
    const title = head.textContent ?? '';
    const card = document.createElement('div');
    card.className = 'set-card';
    const memKey = `crate.setcard.${catId}.${title}`;
    if (localStorage.getItem(memKey) !== '0') card.classList.add('open');
    const headBtn = document.createElement('button');
    headBtn.type = 'button';
    headBtn.className = 'set-card-head';
    headBtn.innerHTML = `<span class="set-card-title">${esc(title)}</span><span class="set-card-chev" aria-hidden="true">›</span>`;
    headBtn.addEventListener('click', () => {
      const open = card.classList.toggle('open');
      localStorage.setItem(memKey, open ? '1' : '0');
    });
    const wrap = document.createElement('div');
    wrap.className = 'set-card-wrap';
    const inner = document.createElement('div');
    inner.className = 'set-card-body'; // the collapsing box — must stay padding-free so 0fr fully closes
    const pad = document.createElement('div');
    pad.className = 'set-card-pad'; // padding lives here, inside the clip
    while (i < kids.length && !isSub(kids[i]!)) pad.appendChild(kids[i++]!);
    inner.appendChild(pad);
    wrap.appendChild(inner);
    card.appendChild(headBtn);
    card.appendChild(wrap);
    body.appendChild(card);
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function renderSchedule(el: HTMLElement): void {
  if (!settings) return;
  el.innerHTML = '<p class="sched-h hint">Screen off; touch wakes it briefly.</p>';
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

/* ================= Live updates (WebSocket) ================= */
// Keep the admin in sync with the device without a manual refresh: player roster/settings
// changes re-fetch and re-render the open settings screen; shelf changes reload the index.
function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?app=admin`);
  ws.onmessage = (ev) => {
    let msg: { type?: string; settings?: Settings; app?: string };
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (msg.type === 'reload' && msg.app === 'admin') {
      location.reload();
      return;
    }
    if (msg.type === 'players') {
      void client
        .getPlayers()
        .then((r) => {
          settingsPlayers = r.players;
          refreshOpenSettingsCat();
        })
        .catch(() => {});
    } else if (msg.type === 'settings' && msg.settings) {
      settings = msg.settings;
      refreshOpenSettingsCat();
    } else if (msg.type === 'shelf' || msg.type === 'shelves') {
      void loadShelvesIndex();
    }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}
connectWs();

/* ================= Admin auth (Phase 5) ================= */
async function maybeAuthGate(): Promise<void> {
  let st: { enabled: boolean; authed: boolean };
  try {
    st = await client.getAuthStatus();
  } catch {
    return; // if we can't tell, don't lock the UI out
  }
  if (st.enabled && !st.authed) buildLoginGate();
}

function buildLoginGate(): void {
  const ov = document.createElement('div');
  ov.id = 'authgate';
  ov.innerHTML =
    '<div class="ob-card ag-card">' +
    '<div class="ag-lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>' +
    '<h2 class="ob-title">Crate admin</h2>' +
    '<p class="ob-lead">Enter your passphrase to manage this Crate.</p>' +
    '<div class="ob-form"><div class="field"><input class="ag-pass" type="password" placeholder="Passphrase" autocomplete="current-password"></div></div>' +
    '<p class="ob-status ag-err" hidden></p>' +
    '<button class="ob-next ag-unlock">Unlock</button>' +
    '</div>';
  document.body.appendChild(ov);
  const pass = ov.querySelector('.ag-pass') as HTMLInputElement;
  const err = ov.querySelector('.ag-err') as HTMLElement;
  const unlock = ov.querySelector('.ag-unlock') as HTMLButtonElement;
  const submit = (): void => {
    unlock.disabled = true;
    err.hidden = true;
    void client
      .login(pass.value)
      .then(() => location.reload())
      .catch(() => {
        err.textContent = 'Wrong passphrase';
        err.hidden = false;
        unlock.disabled = false;
        pass.select();
      });
  };
  unlock.addEventListener('click', submit);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => pass.focus(), 50);
}

function renderSecurityCat(body: HTMLElement): void {
  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = 'Lock the admin app behind a passphrase. The wall keeps working without it — this only gates settings and configuration.';
  body.appendChild(intro);

  const c = document.createElement('div');
  c.className = 'ma-form';
  body.appendChild(c);

  const field = (label: string, input: HTMLInputElement): HTMLElement => {
    const f = document.createElement('div');
    f.className = 'field';
    const l = document.createElement('label');
    l.textContent = label;
    f.append(l, input);
    return f;
  };
  const pw = (ph: string): HTMLInputElement => {
    const i = document.createElement('input');
    i.type = 'password';
    i.placeholder = ph;
    i.autocomplete = 'new-password';
    return i;
  };

  const draw = (enabled: boolean): void => {
    c.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'set-subhead';
    head.textContent = enabled ? 'Admin lock is ON' : 'Admin lock is OFF';
    c.appendChild(head);
    const actions = document.createElement('div');
    actions.className = 'sys-actions';

    if (enabled) {
      const cur = pw('current passphrase');
      const next = pw('new passphrase');
      c.append(field('Current passphrase', cur), field('New passphrase', next));
      const change = document.createElement('button');
      change.className = 'ghost';
      change.textContent = 'Change passphrase';
      change.addEventListener('click', () => {
        if (!next.value.trim()) return showToast('Enter a new passphrase');
        change.disabled = true;
        void client.setPassphrase(next.value.trim(), cur.value).then(() => { showToast('Passphrase changed'); draw(true); }).catch(maErr).finally(() => (change.disabled = false));
      });
      const off = document.createElement('button');
      off.className = 'ghost danger';
      off.textContent = 'Turn off lock';
      off.addEventListener('click', () => {
        if (!confirm('Turn off the admin lock? Anyone on your network could then change settings.')) return;
        off.disabled = true;
        void client.setPassphrase('', cur.value).then(() => { showToast('Lock disabled'); draw(false); }).catch(maErr).finally(() => (off.disabled = false));
      });
      const out = document.createElement('button');
      out.className = 'ghost';
      out.textContent = 'Sign out';
      out.addEventListener('click', () => void client.logout().then(() => location.reload()).catch(() => {}));
      actions.append(change, off, out);
    } else {
      const next = pw('choose a passphrase');
      c.appendChild(field('Passphrase', next));
      const enable = document.createElement('button');
      enable.className = 'ghost';
      enable.textContent = 'Enable lock';
      enable.addEventListener('click', () => {
        if (next.value.trim().length < 4) return showToast('Use at least 4 characters');
        enable.disabled = true;
        void client.setPassphrase(next.value.trim()).then(() => { showToast('Admin lock enabled'); draw(true); }).catch(maErr).finally(() => (enable.disabled = false));
      });
      actions.append(enable);
    }
    c.appendChild(actions);
  };

  void client.getAuthStatus().then((s) => draw(s.enabled)).catch(() => draw(false));
}

/* ================= Onboarding wizard (first run) ================= */
type ObNext = (() => Promise<boolean>) | void;
interface ObCtx {
  setNext: (label: string, enabled?: boolean) => void;
}
function obErr(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /\{"error":"(.*?)"\}/.exec(raw);
  return (m ? m[1]! : 'Failed').replace(/^\d+:\s*/, '');
}
function obField(label: string, el: HTMLElement): HTMLElement {
  const d = document.createElement('div');
  d.className = 'field';
  const l = document.createElement('label');
  l.textContent = label;
  d.append(l, el);
  return d;
}
function obInput(type: string, ph: string, val = ''): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.placeholder = ph;
  i.value = val;
  return i;
}

async function maybeOnboard(): Promise<void> {
  const force = location.search.includes('onboarding');
  let done = true;
  try {
    done = (await client.getOnboarding()).done;
  } catch {
    done = true; // if we can't tell, don't nag
  }
  if (done && !force) return;
  if (!force) {
    // An existing install already talking to MA doesn't need the wizard — mark it done quietly.
    const conn = await client.getMaConnection().catch(() => null);
    if (conn?.connected && conn.hasToken) {
      void client.completeOnboarding();
      return;
    }
  }
  buildOnboarding();
}

function buildOnboarding(): void {
  const ov = document.createElement('div');
  ov.id = 'onboarding';
  ov.innerHTML =
    '<div class="ob-card">' +
    '<button class="ob-skip">Skip setup</button>' +
    '<img class="ob-logo" alt="Crate">' +
    '<div class="ob-body"></div>' +
    '<div class="ob-nav"><button class="ob-back ghost" hidden>Back</button><div class="ob-dots"></div><button class="ob-next">Continue</button></div>' +
    '</div>';
  document.body.appendChild(ov);
  (ov.querySelector('.ob-logo') as HTMLImageElement).src = crateLogo;
  const body = ov.querySelector('.ob-body') as HTMLElement;
  const backBtn = ov.querySelector('.ob-back') as HTMLButtonElement;
  const nextBtn = ov.querySelector('.ob-next') as HTMLButtonElement;
  const dots = ov.querySelector('.ob-dots') as HTMLElement;
  (ov.querySelector('.ob-skip') as HTMLButtonElement).addEventListener('click', () => {
    void client.completeOnboarding().catch(() => {});
    ov.remove();
  });

  const steps: Array<(b: HTMLElement, ctx: ObCtx) => Promise<ObNext>> = [obWelcome, obConnect, obSources, obSpeakers, obSecure, obDone];
  let i = 0;
  let onNext: ObNext;

  const render = async (): Promise<void> => {
    body.innerHTML = '';
    backBtn.hidden = i === 0;
    nextBtn.textContent = 'Continue';
    nextBtn.disabled = false;
    dots.innerHTML = steps.map((_, k) => `<span class="ob-dot${k === i ? ' on' : ''}"></span>`).join('');
    onNext = await steps[i]!(body, { setNext: (label, enabled = true) => { nextBtn.textContent = label; nextBtn.disabled = !enabled; } });
  };
  backBtn.addEventListener('click', () => { if (i > 0) { i--; void render(); } });
  nextBtn.addEventListener('click', async () => {
    nextBtn.disabled = true;
    let ok = true;
    if (onNext) { try { ok = await onNext(); } catch { ok = false; } }
    nextBtn.disabled = false;
    if (!ok) return;
    if (i < steps.length - 1) { i++; void render(); } else ov.remove();
  });
  void render();
}

async function obWelcome(body: HTMLElement): Promise<ObNext> {
  body.innerHTML =
    '<h2 class="ob-title">Welcome to Crate</h2>' +
    '<p class="ob-lead">Let’s connect your music and set up your wall. It only takes a minute.</p>';
  return undefined;
}

async function obConnect(body: HTMLElement, ctx: ObCtx): Promise<ObNext> {
  const [conn, status] = await Promise.all([
    client.getMaConnection().catch(() => ({ url: '', hasToken: false, connected: false, serverVersion: null })),
    client.getMaStatus().catch(() => null),
  ]);
  const coHosted = !!status?.managesMa;
  body.innerHTML = '<h2 class="ob-title">Connect to Music Assistant</h2><p class="ob-lead">Crate plays through Music Assistant.</p>';
  const lead = body.querySelector('.ob-lead') as HTMLElement;
  const url = obInput('text', 'http://homeassistant.local:8095', conn.url);
  const statusEl = document.createElement('p');
  statusEl.className = 'ob-status';

  if (coHosted) {
    // Co-hosted → Crate creates the account (if fresh) + mints a token. Wait for the MA container
    // to finish starting, then choose "Create account" vs "Sign in".
    const form = document.createElement('div');
    form.className = 'ob-form';
    const user = obInput('text', 'username');
    user.autocomplete = 'username';
    const pass = obInput('password', 'password');
    pass.autocomplete = 'new-password';
    form.append(obField('Server URL', url), obField('Username', user), obField('Password', pass));
    body.append(form, statusEl);
    user.disabled = pass.disabled = true;
    ctx.setNext('Connect', false);
    statusEl.textContent = 'Waiting for Music Assistant to start…';
    const poll = async (): Promise<void> => {
      if (!user.isConnected) return; // navigated away
      const st = await client.maSetupState(url.value).catch(() => ({ reachable: false, needsSetup: false }));
      if (!user.isConnected) return;
      if (!st.reachable) {
        setTimeout(() => void poll(), 2500); // keep refreshing until it comes up
        return;
      }
      user.disabled = pass.disabled = false;
      statusEl.textContent = '';
      if (st.needsSetup) {
        lead.textContent = 'This Music Assistant is brand new. Choose a username and password (8+ characters) — Crate creates the account and its own token.';
        pass.placeholder = 'password (8+ characters)';
        ctx.setNext('Create account', true);
      } else {
        lead.textContent = 'Sign in to Music Assistant and Crate creates its own access token — nothing to copy.';
        ctx.setNext('Connect', true);
      }
    };
    void poll();
    return async () => {
      statusEl.textContent = 'Setting up…';
      const r = await client
        .mintMaConnection({ url: url.value, username: user.value, password: pass.value })
        .catch((e) => { statusEl.textContent = '✕ ' + obErr(e); return null; });
      if (r?.connected) return true;
      if (statusEl.textContent === 'Setting up…') statusEl.textContent = '✕ Couldn’t connect.';
      return false;
    };
  }

  // External MA → sign in (Crate mints a token) OR paste a long-lived token.
  lead.textContent = 'Crate plays through your Music Assistant server.';
  let mode: 'signin' | 'token' = 'signin';
  const seg = document.createElement('div');
  seg.className = 'ob-seg';
  const signinBtn = document.createElement('button');
  signinBtn.type = 'button';
  signinBtn.textContent = 'Sign in';
  const tokenBtn = document.createElement('button');
  tokenBtn.type = 'button';
  tokenBtn.textContent = 'Access token';
  seg.append(signinBtn, tokenBtn);

  const form = document.createElement('div');
  form.className = 'ob-form';
  form.append(obField('Server URL', url));
  const user = obInput('text', 'username');
  user.autocomplete = 'username';
  const pass = obInput('password', 'password');
  pass.autocomplete = 'current-password';
  const creds = document.createElement('div');
  creds.className = 'ob-form';
  creds.append(obField('Username', user), obField('Password', pass));
  const token = obInput('password', conn.hasToken ? 'saved — leave blank to keep it' : 'long-lived token');
  const help = document.createElement('p');
  help.className = 'ob-help';
  help.innerHTML = 'Create one in Music Assistant → <b>your profile → Long-lived tokens</b>.';
  const link = document.createElement('a');
  link.className = 'ob-link';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Open Music Assistant ↗';
  const setLink = (): void => { link.href = (url.value || 'http://homeassistant.local:8095').replace(/\/+$/, ''); };
  setLink();
  url.addEventListener('input', setLink);
  const tokenWrap = document.createElement('div');
  tokenWrap.className = 'ob-form';
  tokenWrap.append(obField('Access token', token), help, link);

  body.append(seg, form, creds, tokenWrap, statusEl);
  const applyMode = (): void => {
    signinBtn.classList.toggle('on', mode === 'signin');
    tokenBtn.classList.toggle('on', mode === 'token');
    creds.hidden = mode !== 'signin';
    tokenWrap.hidden = mode !== 'token';
  };
  signinBtn.addEventListener('click', () => { mode = 'signin'; applyMode(); });
  tokenBtn.addEventListener('click', () => { mode = 'token'; applyMode(); });
  applyMode();
  ctx.setNext('Connect');
  return async () => {
    statusEl.textContent = mode === 'signin' ? 'Signing in…' : 'Connecting…';
    const r =
      mode === 'signin'
        ? await client.mintMaConnection({ url: url.value, username: user.value, password: pass.value }).catch((e) => { statusEl.textContent = '✕ ' + obErr(e); return null; })
        : await client.setMaConnection({ url: url.value, ...(token.value ? { token: token.value } : {}) }).catch(() => null);
    if (r?.connected) return true;
    if (statusEl.textContent === 'Signing in…' || statusEl.textContent === 'Connecting…') statusEl.textContent = '✕ Couldn’t connect — check the details.';
    return false;
  };
}

async function obSources(body: HTMLElement): Promise<ObNext> {
  body.innerHTML =
    '<h2 class="ob-title">Add your music</h2>' +
    '<p class="ob-lead">Connect the services you listen to — once they sync, your library fills the wall and Search.</p>';
  // Reuse the full Music Assistant sources UI (list + add-source picker + config/auth flow).
  const host = document.createElement('div');
  host.className = 'ob-sources';
  body.appendChild(host);
  renderMaCat(host, { onboarding: true });
  // Hide MA's auto-generated smart playlists automatically — no need to ask during setup
  // (the toggle is in Settings → Music Assistant for anyone who wants them later).
  return async () => {
    await client.setMaBuiltinPlaylists(false).catch(() => {});
    return true;
  };
}

async function obSpeakers(body: HTMLElement): Promise<ObNext> {
  body.innerHTML = '<h2 class="ob-title">Speakers</h2><p class="ob-lead">Pick which speakers show on the wall — you can change this any time in Settings.</p>';
  await loadSettingsPanel(); // populates the `settings` + `settingsPlayers` globals
  const host = document.createElement('div');
  renderExposureSection(host);
  host.querySelector('.set-subhead')?.remove(); // we have our own title
  body.append(host);
  return undefined;
}

async function obSecure(body: HTMLElement): Promise<ObNext> {
  const st = await client.getAuthStatus().catch(() => ({ enabled: false, authed: true }));
  body.innerHTML =
    '<h2 class="ob-title">Lock the admin</h2>' +
    '<p class="ob-lead">Optionally require a passphrase to open this admin. The wall keeps playing without it. You can change this any time in Settings → Security.</p>';
  if (st.enabled) {
    const p = document.createElement('p');
    p.className = 'ob-status';
    p.textContent = 'A passphrase is already set.';
    body.append(p);
    return undefined;
  }
  const pass = obInput('password', 'choose a passphrase (optional)');
  pass.autocomplete = 'new-password';
  const form = document.createElement('div');
  form.className = 'ob-form';
  form.append(obField('Passphrase', pass));
  const statusEl = document.createElement('p');
  statusEl.className = 'ob-status';
  body.append(form, statusEl);
  return async () => {
    const v = pass.value.trim();
    if (v && v.length < 4) {
      statusEl.textContent = 'Use at least 4 characters (or leave blank to skip).';
      return false;
    }
    if (v) await client.setPassphrase(v).catch(() => {});
    return true;
  };
}

async function obDone(body: HTMLElement, ctx: ObCtx): Promise<ObNext> {
  body.innerHTML =
    '<h2 class="ob-title">You’re all set</h2>' +
    '<p class="ob-lead">Add albums from the <b>Add</b> tab, arrange them under <b>Shelves</b>, and fine-tune the rest in <b>Settings</b> — including streaming sources and GitHub backups.</p>';
  ctx.setNext('Finish');
  return async () => {
    await client.completeOnboarding().catch(() => {});
    location.reload(); // fresh load so every tab picks up the now-connected MA
    return true;
  };
}

/* ================= Init ================= */
// Crate logo, top-right of each main tab header.
document.querySelectorAll<HTMLImageElement>('img[data-logo]').forEach((img) => (img.src = crateLogo));
void loadSources();
updateAddToolbar();
setContentType('album'); // seeds Add + Shelves for the shared Albums/Playlists choice
void loadShelvesIndex();
void loadSettingsPanel();
void maybeAuthGate();
void maybeOnboard();
