import Database from 'better-sqlite3';
import { DEFAULT_SETTINGS, EXTRA_MEDIA, type Album, type AlbumOverride, type CrateBackupTables, type Palette, type Player, type Settings, type Shelf, type ShelfKind } from '@crate/shared';

export interface AlbumRow {
  id: string;
  provider_uri: string;
  provider: string;
  title: string;
  artist: string;
  year: number | null;
  artwork_url: string | null;
  artwork_path: string | null;
  palette: string | null;
  spine_strip_path: string | null;
  spine_scan_path: string | null;
  spine_width: number;
  total_duration: number | null;
  added_at: string;
  play_count: number;
  overrides: string | null;
}

export interface ShelfRow extends AlbumRow {
  kind: string;
  sort_order: number;
}

export interface SongCacheRow {
  track_uri: string;
  artist: string | null;
  album_uri: string | null;
  artwork_url: string | null;
  album_index: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  provider_uri TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  year INTEGER,
  artwork_url TEXT,
  artwork_path TEXT,
  palette TEXT,
  spine_strip_path TEXT,
  spine_scan_path TEXT,
  spine_width INTEGER NOT NULL DEFAULT 60,
  total_duration INTEGER,
  added_at TEXT NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  overrides TEXT
);
CREATE TABLE IF NOT EXISTS shelf_items (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'album',
  sort_order INTEGER NOT NULL
);
-- Named curated shelves (kind 'album'|'playlist'). "All"/"Radio" are virtual.
CREATE TABLE IF NOT EXISTS shelves (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'album',
  sort_order INTEGER NOT NULL
);
-- Album↔shelf membership (an album can live on several shelves).
CREATE TABLE IF NOT EXISTS shelf_members (
  shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (shelf_id, album_id)
);
-- Enriched playlist-track metadata (artist/album/art), keyed by track uri, so a
-- single-playlist song shelf only resolves each track once (get_track is per-track).
CREATE TABLE IF NOT EXISTS song_cache (
  track_uri TEXT PRIMARY KEY,
  artist TEXT,
  album_uri TEXT,
  artwork_url TEXT,
  album_index INTEGER
);
-- Crate-local per-playlist-shelf song curation: a custom order and/or hidden flag
-- per track, layered over the live provider playlist (never edits the source playlist).
CREATE TABLE IF NOT EXISTS playlist_song_state (
  shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  track_uri TEXT NOT NULL,
  sort_order INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shelf_id, track_uri)
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- shelf_members' PK is (shelf_id, album_id), so lookups/CASCADE by album_id alone would
-- table-scan; index it. shelf_items is filtered by kind and ordered by sort_order constantly.
CREATE INDEX IF NOT EXISTS idx_shelf_members_album ON shelf_members(album_id);
CREATE INDEX IF NOT EXISTS idx_shelf_items_kind ON shelf_items(kind, sort_order);
`;

export function rowToAlbum(r: AlbumRow): Album {
  return {
    id: r.id,
    providerUri: r.provider_uri,
    provider: r.provider,
    title: r.title,
    artist: r.artist,
    year: r.year,
    artworkUrl: r.artwork_url,
    artworkPath: r.artwork_path,
    palette: r.palette ? (JSON.parse(r.palette) as Palette) : null,
    addedAt: r.added_at,
    playCount: r.play_count,
  };
}

/** Normalized "title␀artist" key for title/artist dedupe. The NUL separator (written as the
    \x00 escape) means a title/artist boundary can't be forged by spacing, matching the dedupe
    in findLibraryAlbumByTitleArtist. */
export function titleArtistKey(title: string, artist: string): string {
  return `${title}\x00${artist}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL'); // WAL-safe durability without an fsync per write (kind to the Pi's SD card)
    this.db.pragma('busy_timeout = 5000'); // wait out a concurrent writer (e.g. the auto-backup) instead of throwing SQLITE_BUSY
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Close the database (checkpoints the WAL). Call on graceful shutdown / restart. */
  close(): void {
    this.db.close();
  }

  /** Cheap liveness probe for the systemd watchdog. Throws if SQLite is wedged (a writer holds
      the lock past busy_timeout), so a stuck DB stops the heartbeat and systemd relaunches. */
  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  /** Additive migrations for DBs created before a column existed. */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(albums)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'spine_scan_path')) {
      this.db.exec('ALTER TABLE albums ADD COLUMN spine_scan_path TEXT');
    }
    if (!cols.some((c) => c.name === 'overrides')) {
      this.db.exec('ALTER TABLE albums ADD COLUMN overrides TEXT');
    }
    if (!cols.some((c) => c.name === 'total_duration')) {
      this.db.exec('ALTER TABLE albums ADD COLUMN total_duration INTEGER');
    }
  }

  getOverride(id: string): AlbumOverride {
    const row = this.db.prepare('SELECT overrides FROM albums WHERE id = ?').get(id) as
      | { overrides: string | null }
      | undefined;
    if (!row?.overrides) return {};
    try {
      return JSON.parse(row.overrides) as AlbumOverride;
    } catch {
      return {};
    }
  }

  setOverride(id: string, patch: Partial<AlbumOverride>): AlbumOverride {
    const next: AlbumOverride = { ...this.getOverride(id), ...patch };
    this.db.prepare('UPDATE albums SET overrides = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  }

  // --- Albums -------------------------------------------------------------

  upsertAlbum(row: AlbumRow): void {
    this.db
      .prepare(
        `INSERT INTO albums (id, provider_uri, provider, title, artist, year, artwork_url, artwork_path,
           palette, spine_strip_path, spine_width, total_duration, added_at, play_count)
         VALUES (@id, @provider_uri, @provider, @title, @artist, @year, @artwork_url, @artwork_path,
           @palette, @spine_strip_path, @spine_width, @total_duration, @added_at, @play_count)
         ON CONFLICT(id) DO UPDATE SET
           title=@title, artist=@artist, year=@year, artwork_url=@artwork_url, artwork_path=@artwork_path,
           palette=@palette, spine_strip_path=@spine_strip_path, spine_width=@spine_width,
           total_duration=@total_duration`,
      )
      .run(row);
  }

  getAlbum(id: string): AlbumRow | undefined {
    return this.db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as AlbumRow | undefined;
  }

  incrementPlayCount(id: string): void {
    this.db.prepare('UPDATE albums SET play_count = play_count + 1 WHERE id = ?').run(id);
  }

  updateArtwork(id: string, artworkPath: string | null, spineStripPath: string | null, palette: Palette | null): void {
    this.db
      .prepare('UPDATE albums SET artwork_path = ?, spine_strip_path = ?, palette = ? WHERE id = ?')
      .run(artworkPath, spineStripPath, palette ? JSON.stringify(palette) : null, id);
  }

  setSpineScan(id: string, spineScanPath: string | null): void {
    this.db.prepare('UPDATE albums SET spine_scan_path = ? WHERE id = ?').run(spineScanPath, id);
  }

  setDuration(id: string, totalDuration: number | null): void {
    this.db.prepare('UPDATE albums SET total_duration = ? WHERE id = ?').run(totalDuration, id);
  }

  // --- Shelf --------------------------------------------------------------

  listShelf(kind: ShelfKind = 'album'): ShelfRow[] {
    return this.db
      .prepare(
        `SELECT a.*, s.kind, s.sort_order
         FROM shelf_items s JOIN albums a ON a.id = s.album_id
         WHERE s.kind = ?
         ORDER BY s.sort_order ASC`,
      )
      .all(kind) as ShelfRow[];
  }

  isOnShelf(albumId: string): boolean {
    return this.db.prepare('SELECT 1 FROM shelf_items WHERE album_id = ?').get(albumId) !== undefined;
  }

  shelfedUris(): Set<string> {
    const rows = this.db
      .prepare('SELECT a.provider_uri AS uri FROM shelf_items s JOIN albums a ON a.id = s.album_id')
      .all() as Array<{ uri: string }>;
    return new Set(rows.map((r) => r.uri));
  }

  /** Normalized title␀artist keys of every shelved album, for O(1) library-import dedupe. */
  shelfedTitleArtistKeys(): Set<string> {
    const rows = this.db
      .prepare("SELECT a.title AS t, a.artist AS ar FROM shelf_items s JOIN albums a ON a.id = s.album_id")
      .all() as Array<{ t: string; ar: string }>;
    return new Set(rows.map((r) => titleArtistKey(r.t, r.ar)));
  }

  /** A library album with the same title + artist (any release), for dedupe. */
  findLibraryAlbumByTitleArtist(title: string, artist: string): AlbumRow | null {
    const key = (t: string, a: string): string => `${t} ${a}`.toLowerCase().replace(/\s+/g, ' ').trim();
    const want = key(title, artist);
    const rows = this.db
      .prepare("SELECT a.* FROM shelf_items s JOIN albums a ON a.id = s.album_id WHERE s.kind = 'album'")
      .all() as AlbumRow[];
    return rows.find((r) => key(r.title, r.artist) === want) ?? null;
  }

  addToShelf(albumId: string, kind: ShelfKind = 'album'): void {
    const max = (this.db.prepare('SELECT MAX(sort_order) AS m FROM shelf_items').get() as { m: number | null }).m ?? 0;
    this.db
      .prepare('INSERT OR IGNORE INTO shelf_items (album_id, kind, sort_order) VALUES (?, ?, ?)')
      .run(albumId, kind, max + 1);
  }

  removeFromShelf(albumId: string): void {
    this.db.prepare('DELETE FROM shelf_items WHERE album_id = ?').run(albumId);
  }

  /** Set the manual order of library albums to match the given id sequence. */
  reorderShelfItems(orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE shelf_items SET sort_order = ? WHERE album_id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      ids.forEach((id, i) => stmt.run(i, id));
    });
    tx(orderedIds);
  }

  /** Set the manual order of a crate's members to match the given id sequence. */
  reorderShelfMembers(shelfId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE shelf_members SET sort_order = ? WHERE shelf_id = ? AND album_id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      ids.forEach((id, i) => stmt.run(i, shelfId, id));
    });
    tx(orderedIds);
  }

  // --- Shelves (named curated collections) --------------------------------

  listShelves(): Shelf[] {
    const rows = this.db.prepare('SELECT id, name, kind, sort_order FROM shelves ORDER BY sort_order, name').all() as Array<{
      id: string;
      name: string;
      kind: string;
      sort_order: number;
    }>;
    const user = rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind as ShelfKind, order: r.sort_order }));
    return [
      { id: 'all', name: 'All', kind: 'album' as ShelfKind, order: -1 },
      { id: 'playlists', name: 'All Playlists', kind: 'playlist' as ShelfKind, order: -1 },
      // The extra-media virtual shelves (Radio / Podcasts / Audiobooks), table-driven.
      ...EXTRA_MEDIA.map((m) => ({ id: m.shelfId, name: m.name, kind: m.kind as ShelfKind, order: -1 })),
      ...user,
    ];
  }

  createShelf(id: string, name: string, kind: ShelfKind): Shelf {
    const max = (this.db.prepare('SELECT MAX(sort_order) AS m FROM shelves').get() as { m: number | null }).m ?? 0;
    this.db.prepare('INSERT INTO shelves (id, name, kind, sort_order) VALUES (?, ?, ?, ?)').run(id, name, kind, max + 1);
    return { id, name, kind, order: max + 1 };
  }

  renameShelf(id: string, name: string): void {
    this.db.prepare('UPDATE shelves SET name = ? WHERE id = ?').run(name, id);
  }

  deleteShelf(id: string): void {
    this.db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
  }

  addAlbumToShelf(shelfId: string, albumId: string): void {
    const max = (
      this.db.prepare('SELECT MAX(sort_order) AS m FROM shelf_members WHERE shelf_id = ?').get(shelfId) as { m: number | null }
    ).m ?? 0;
    this.db
      .prepare('INSERT OR IGNORE INTO shelf_members (shelf_id, album_id, sort_order) VALUES (?, ?, ?)')
      .run(shelfId, albumId, max + 1);
  }

  removeAlbumFromShelf(shelfId: string, albumId: string): void {
    this.db.prepare('DELETE FROM shelf_members WHERE shelf_id = ? AND album_id = ?').run(shelfId, albumId);
  }

  listShelfMembers(shelfId: string): ShelfRow[] {
    return this.db
      .prepare(
        `SELECT a.*, 'album' AS kind, m.sort_order AS sort_order
         FROM shelf_members m JOIN albums a ON a.id = m.album_id
         WHERE m.shelf_id = ? ORDER BY m.sort_order ASC`,
      )
      .all(shelfId) as ShelfRow[];
  }

  // --- Song cache (enriched playlist tracks) -----------------------------

  getSongCache(trackUri: string): SongCacheRow | undefined {
    return this.db.prepare('SELECT * FROM song_cache WHERE track_uri = ?').get(trackUri) as SongCacheRow | undefined;
  }

  upsertSongCache(row: SongCacheRow): void {
    this.db
      .prepare(
        `INSERT INTO song_cache (track_uri, artist, album_uri, artwork_url, album_index)
         VALUES (@track_uri, @artist, @album_uri, @artwork_url, @album_index)
         ON CONFLICT(track_uri) DO UPDATE SET
           artist=@artist, album_uri=@album_uri, artwork_url=@artwork_url, album_index=@album_index`,
      )
      .run(row);
  }

  /** Crate-local order + hidden state for a playlist shelf's songs, keyed by track uri. */
  playlistSongState(shelfId: string): Map<string, { order: number | null; hidden: boolean }> {
    const rows = this.db
      .prepare('SELECT track_uri, sort_order, hidden FROM playlist_song_state WHERE shelf_id = ?')
      .all(shelfId) as Array<{ track_uri: string; sort_order: number | null; hidden: number }>;
    return new Map(rows.map((r) => [r.track_uri, { order: r.sort_order, hidden: !!r.hidden }]));
  }

  /** Persist a custom song order for a playlist shelf (preserving any hidden flags). */
  setPlaylistSongOrder(shelfId: string, orderedUris: string[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO playlist_song_state (shelf_id, track_uri, sort_order, hidden) VALUES (?, ?, ?, 0)
       ON CONFLICT(shelf_id, track_uri) DO UPDATE SET sort_order = excluded.sort_order`,
    );
    const tx = this.db.transaction((uris: string[]) => uris.forEach((u, i) => stmt.run(shelfId, u, i)));
    tx(orderedUris);
  }

  /** Hide (Crate-local) or restore a single song within a playlist shelf. */
  setPlaylistSongHidden(shelfId: string, trackUri: string, hidden: boolean): void {
    this.db
      .prepare(
        `INSERT INTO playlist_song_state (shelf_id, track_uri, sort_order, hidden) VALUES (?, ?, NULL, ?)
         ON CONFLICT(shelf_id, track_uri) DO UPDATE SET hidden = excluded.hidden`,
      )
      .run(shelfId, trackUri, hidden ? 1 : 0);
  }

  // --- Players ------------------------------------------------------------

  upsertPlayers(players: Array<Omit<Player, 'isDefault' | 'displayOrder'>>): void {
    const insert = this.db.prepare(
      `INSERT INTO players (id, name, type, available) VALUES (@id, @name, @type, @available)
       ON CONFLICT(id) DO UPDATE SET name=@name, type=@type, available=@available`,
    );
    const tx = this.db.transaction((list: typeof players) => {
      for (const p of list) insert.run({ id: p.id, name: p.name, type: p.type, available: p.available ? 1 : 0 });
    });
    tx(players);
  }

  listPlayers(): Player[] {
    const rows = this.db.prepare('SELECT * FROM players ORDER BY display_order, name').all() as Array<{
      id: string;
      name: string;
      type: string;
      is_default: number;
      display_order: number;
      available: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type as Player['type'],
      isDefault: r.is_default === 1,
      displayOrder: r.display_order,
      available: r.available === 1,
    }));
  }

  getDefaultPlayerId(): string | null {
    const row = this.db.prepare('SELECT id FROM players WHERE is_default = 1 LIMIT 1').get() as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  setDefaultPlayer(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE players SET is_default = 0').run();
      this.db.prepare('UPDATE players SET is_default = 1 WHERE id = ?').run(id);
    });
    tx();
  }

  // --- Settings -----------------------------------------------------------

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const stored: Record<string, unknown> = {};
    for (const r of rows) {
      if (r.key.includes('.')) continue; // dotted keys are namespaced runtime state (e.g. system.*)
      try {
        stored[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore bad row */
      }
    }
    const merged = { ...DEFAULT_SETTINGS, ...stored } as Settings;
    if (merged.defaultPlayerId === null) merged.defaultPlayerId = this.getDefaultPlayerId();
    migrateIdleSettings(merged, stored);
    return merged;
  }

  putSettings(partial: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const tx = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
    });
    tx(Object.entries(partial));
    if (partial.defaultPlayerId) this.setDefaultPlayer(partial.defaultPlayerId);
    return this.getSettings();
  }

  /** Namespaced runtime state (dotted keys, e.g. `system.brightness`), kept out
      of the typed Settings object. */
  getRaw<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setRaw(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // --- Backup / restore ---------------------------------------------------

  /** Snapshot the user-authored config (no art cache, song cache, players, or dotted
      device/secret settings) for export. */
  exportConfig(): CrateBackupTables {
    const all = <T>(sql: string): T[] => this.db.prepare(sql).all() as T[];
    return {
      settings: all("SELECT key, value FROM settings WHERE key NOT LIKE '%.%'"),
      albums: all(
        `SELECT id, provider_uri, provider, title, artist, year, artwork_url,
                spine_width, total_duration, added_at, play_count, overrides
         FROM albums`,
      ),
      shelfItems: all('SELECT album_id, kind, sort_order FROM shelf_items'),
      shelves: all('SELECT id, name, kind, sort_order FROM shelves'),
      shelfMembers: all('SELECT shelf_id, album_id, sort_order FROM shelf_members'),
      playlistSongState: all('SELECT shelf_id, track_uri, sort_order, hidden FROM playlist_song_state'),
    };
  }

  /** Replace all user-authored config with a backup snapshot, in one transaction.
      Device/secret settings (dotted keys) and regenerable caches are left untouched. */
  importConfig(t: CrateBackupTables): void {
    const ins = <T>(sql: string, rows: T[] | undefined): void => {
      const stmt = this.db.prepare(sql);
      for (const r of rows ?? []) stmt.run(r as Record<string, unknown>);
    };
    const run = this.db.transaction(() => {
      this.db.exec(
        'DELETE FROM playlist_song_state; DELETE FROM shelf_members; DELETE FROM shelf_items;' +
          ' DELETE FROM shelves; DELETE FROM albums;',
      );
      this.db.prepare("DELETE FROM settings WHERE key NOT LIKE '%.%'").run();
      ins(
        `INSERT INTO albums (id, provider_uri, provider, title, artist, year, artwork_url,
           spine_width, total_duration, added_at, play_count, overrides)
         VALUES (@id, @provider_uri, @provider, @title, @artist, @year, @artwork_url,
           @spine_width, @total_duration, @added_at, @play_count, @overrides)`,
        t.albums,
      );
      ins('INSERT INTO shelf_items (album_id, kind, sort_order) VALUES (@album_id, @kind, @sort_order)', t.shelfItems);
      ins('INSERT INTO shelves (id, name, kind, sort_order) VALUES (@id, @name, @kind, @sort_order)', t.shelves);
      ins('INSERT INTO shelf_members (shelf_id, album_id, sort_order) VALUES (@shelf_id, @album_id, @sort_order)', t.shelfMembers);
      ins('INSERT INTO playlist_song_state (shelf_id, track_uri, sort_order, hidden) VALUES (@shelf_id, @track_uri, @sort_order, @hidden)', t.playlistSongState);
      ins('INSERT INTO settings (key, value) VALUES (@key, @value)', t.settings);
    });
    run();
  }
}

/** Forward-migrate the pre-redesign idle settings to the new fields, in memory only
    (persisted on the next putSettings). Old `idleScreen` (on/dim/off) → `idleDim` +
    `screenOffAfterMin`; the auto-open slideshow (`autoOpenEnabled` / legacy
    idleContent='autoOpen') → idleContent='slideshow'. */
function migrateIdleSettings(merged: Settings, stored: Record<string, unknown>): void {
  if (stored['idleDim'] === undefined && stored['idleScreen'] !== undefined) {
    const scr = stored['idleScreen'];
    merged.idleDim = scr === 'dim';
    // 'off' turned the screen off at idle time — replicate with the new second-stage timer.
    if (scr === 'off' && stored['screenOffAfterMin'] === undefined) merged.screenOffAfterMin = merged.idleAfterMin;
  }
  if (stored['idleContent'] === 'autoOpen' || stored['autoOpenEnabled'] === true) {
    merged.idleContent = 'slideshow';
  }
}
