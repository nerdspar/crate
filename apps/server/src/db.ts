import Database from 'better-sqlite3';
import { DEFAULT_SETTINGS, type Album, type Palette, type Player, type Settings, type Stack } from '@crate/shared';

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
  added_at: string;
  play_count: number;
}

export interface ShelfRow extends AlbumRow {
  kind: string;
  sort_order: number;
  stack_id: string | null;
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
  added_at TEXT NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shelf_items (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'album',
  sort_order INTEGER NOT NULL,
  stack_id TEXT
);
CREATE TABLE IF NOT EXISTS stacks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
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

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for DBs created before a column existed. */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(albums)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'spine_scan_path')) {
      this.db.exec('ALTER TABLE albums ADD COLUMN spine_scan_path TEXT');
    }
  }

  // --- Albums -------------------------------------------------------------

  upsertAlbum(row: AlbumRow): void {
    this.db
      .prepare(
        `INSERT INTO albums (id, provider_uri, provider, title, artist, year, artwork_url, artwork_path,
           palette, spine_strip_path, spine_width, added_at, play_count)
         VALUES (@id, @provider_uri, @provider, @title, @artist, @year, @artwork_url, @artwork_path,
           @palette, @spine_strip_path, @spine_width, @added_at, @play_count)
         ON CONFLICT(id) DO UPDATE SET
           title=@title, artist=@artist, year=@year, artwork_url=@artwork_url, artwork_path=@artwork_path,
           palette=@palette, spine_strip_path=@spine_strip_path, spine_width=@spine_width`,
      )
      .run(row);
  }

  getAlbum(id: string): AlbumRow | undefined {
    return this.db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as AlbumRow | undefined;
  }

  getAlbumByUri(uri: string): AlbumRow | undefined {
    return this.db.prepare('SELECT * FROM albums WHERE provider_uri = ?').get(uri) as AlbumRow | undefined;
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

  // --- Shelf --------------------------------------------------------------

  listShelf(): ShelfRow[] {
    return this.db
      .prepare(
        `SELECT a.*, s.kind, s.sort_order, s.stack_id
         FROM shelf_items s JOIN albums a ON a.id = s.album_id
         ORDER BY s.sort_order ASC`,
      )
      .all() as ShelfRow[];
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

  addToShelf(albumId: string, stackId: string | null = null): void {
    const max = (this.db.prepare('SELECT MAX(sort_order) AS m FROM shelf_items').get() as { m: number | null }).m ?? 0;
    this.db
      .prepare('INSERT OR IGNORE INTO shelf_items (album_id, kind, sort_order, stack_id) VALUES (?, ?, ?, ?)')
      .run(albumId, 'album', max + 1, stackId);
  }

  removeFromShelf(albumId: string): void {
    this.db.prepare('DELETE FROM shelf_items WHERE album_id = ?').run(albumId);
  }

  listStacks(): Stack[] {
    const rows = this.db.prepare('SELECT id, name, sort_order FROM stacks ORDER BY sort_order').all() as Array<{
      id: string;
      name: string;
      sort_order: number;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, order: r.sort_order }));
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
      try {
        stored[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore bad row */
      }
    }
    const merged = { ...DEFAULT_SETTINGS, ...stored } as Settings;
    if (merged.defaultPlayerId === null) merged.defaultPlayerId = this.getDefaultPlayerId();
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
}
