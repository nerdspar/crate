import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AlbumOverride, MediaKind, Palette, ShelfItem } from '@crate/shared';
import { darken, pickInk } from './color.js';
import type { ShelfRow } from './db.js';

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
    primaryColor: primary,
    darkColor: dark,
    inkColor: palette?.ink ?? pickInk(primary),
    spineWidth: row.spine_width,
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
