/**
 * Crate config backup format (Phase 5).
 *
 * A portable snapshot of the *user-authored* configuration — settings, the library
 * (albums + order + stacks), curated shelves and their members, and playlist song
 * curation. It deliberately omits the regenerable art cache (local artwork/spine
 * paths + palette), the song-metadata cache, and discovered players, plus any
 * device-local / secret runtime state (dotted settings keys like `system.*`).
 */

export const BACKUP_VERSION = 1;

export interface CrateBackupAlbum {
  id: string;
  provider_uri: string;
  provider: string;
  title: string;
  artist: string;
  year: number | null;
  /** Provider artwork URL (not a local cache file) — lets art show before a re-scan. */
  artwork_url: string | null;
  spine_width: number;
  total_duration: number | null;
  added_at: string;
  play_count: number;
  /** Per-album overrides (label font/color/spacing, custom-art flags) as a JSON string. */
  overrides: string | null;
}

export interface CrateBackupTables {
  /** Typed settings only (dotted/namespaced keys are excluded). */
  settings: Array<{ key: string; value: string }>;
  albums: CrateBackupAlbum[];
  shelfItems: Array<{ album_id: string; kind: string; sort_order: number; stack_id: string | null }>;
  stacks: Array<{ id: string; name: string; sort_order: number }>;
  shelves: Array<{ id: string; name: string; kind: string; sort_order: number }>;
  shelfMembers: Array<{ shelf_id: string; album_id: string; sort_order: number }>;
  playlistSongState: Array<{ shelf_id: string; track_uri: string; sort_order: number | null; hidden: number }>;
}

export interface CrateBackup {
  /** Format marker so an arbitrary uploaded file can be rejected. */
  crate: 'crate-backup';
  version: number;
  /** ISO timestamp the backup was produced. */
  exportedAt: string;
  /** Crate version that produced it (informational). */
  crateVersion: string;
  tables: CrateBackupTables;
}

/** Summary returned after a restore. */
export interface BackupImportResult {
  ok: boolean;
  counts: { albums: number; shelves: number; shelfItems: number };
}

/** GitHub auto-backup config as surfaced to the admin (PAT is never returned — only whether one is set). */
export interface GithubBackupConfig {
  /** "owner/repo". */
  repo: string;
  branch: string;
  /** Path within the repo, e.g. "crate-backup.json". */
  path: string;
  /** True when a token is stored (the token value itself is never sent to the client). */
  hasToken: boolean;
  /** ISO time of the last successful push, or null. */
  lastBackupAt: string | null;
}
