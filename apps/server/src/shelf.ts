import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AlbumOverride, MediaKind, Palette, ShelfItem, Track } from '@crate/shared';
import { darken, pickInk } from './color.js';
import type { ShelfRow } from './db.js';

function hashOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic muted hex color from a seed (for playlist song spines, which
    have no artwork/palette). Fixed S/L, hue from the hash. */
function colorForSeed(seed: string): string {
  const hue = hashOf(seed) % 360;
  const s = 0.32;
  const l = 0.4;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = (
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  ) as [number, number, number];
  const hex = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Synthesize a shelf spine for one playlist track (single-playlist song view).
    Not backed by an ingested album: `albumUri`/`trackIndex` drive song→album. */
export function songShelfItem(track: Track, i: number, playlistId: string): ShelfItem {
  const primary = colorForSeed(`${track.artist}|${track.title}`);
  const dark = darken(primary, 0.5);
  return {
    albumId: `${playlistId}::t${i}`,
    kind: 'playlist',
    title: track.title,
    artist: track.artist,
    year: null,
    order: i,
    stackId: null,
    addedAt: '',
    playCount: 0,
    primaryColor: primary,
    darkColor: dark,
    inkColor: pickInk(primary),
    spineWidth: 56,
    durationSec: null,
    spineStripUrl: null,
    spineScanUrl: null,
    customSpineUrl: null,
    artworkUrl: null,
    labelFont: null,
    labelTracking: null,
    artistColor: null,
    titleColor: null,
    overrideSpineMode: null,
    overrideLayout: null,
    overrideYearDisplay: null,
    albumUri: track.albumUri ?? null,
    trackIndex: track.index ?? i + 1,
  };
}

/** Cache-bust cached art with its mtime so a regenerated strip gets a fresh URL. */
function artUrl(artBase: string, artDir: string, file: string): string {
  try {
    return `${artBase}/${file}?v=${Math.round(statSync(join(artDir, file)).mtimeMs)}`;
  } catch {
    return `${artBase}/${file}`;
  }
}

/** Stable Crate album id derived from the provider uri (e.g. apple-music-album-594061854). */
export function albumIdFromUri(uri: string): string {
  return uri
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Deterministic spine width (px) for visual variety, mirroring the prototype's per-album widths. */
export function spineWidthFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 44 + (h % 36); // 44..79
}

function parseOverride(json: string | null): AlbumOverride {
  if (!json) return {};
  try {
    return JSON.parse(json) as AlbumOverride;
  } catch {
    return {};
  }
}

export function buildShelfItem(row: ShelfRow, artBase: string, artDir: string): ShelfItem {
  const palette = row.palette ? (JSON.parse(row.palette) as Palette) : null;
  const primary = palette?.dominant ?? '#6a6a72';
  const dark = palette?.dark ?? darken(primary, 0.5);
  const ov = parseOverride(row.overrides);
  const cover = ov.coverPath
    ? artUrl(artBase, artDir, ov.coverPath)
    : row.artwork_path
      ? artUrl(artBase, artDir, row.artwork_path)
      : row.artwork_url;
  return {
    albumId: row.id,
    kind: row.kind as MediaKind,
    title: row.title,
    artist: row.artist,
    year: row.year,
    order: row.sort_order,
    stackId: row.stack_id,
    addedAt: row.added_at,
    playCount: row.play_count,
    primaryColor: primary,
    darkColor: dark,
    inkColor: palette?.ink ?? pickInk(primary),
    spineWidth: row.spine_width,
    durationSec: row.total_duration,
    spineStripUrl: row.spine_strip_path ? artUrl(artBase, artDir, row.spine_strip_path) : null,
    spineScanUrl: row.spine_scan_path ? artUrl(artBase, artDir, row.spine_scan_path) : null,
    customSpineUrl: ov.spinePath ? artUrl(artBase, artDir, ov.spinePath) : null,
    artworkUrl: cover,
    labelFont: ov.font ?? null,
    labelTracking: ov.tracking ?? null,
    artistColor: ov.artistColor ?? null,
    titleColor: ov.titleColor ?? null,
    overrideSpineMode: ov.spineMode ?? null,
    overrideLayout: ov.layout ?? null,
    overrideYearDisplay: ov.yearDisplay ?? null,
  };
}
