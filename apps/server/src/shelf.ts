import type { MediaKind, Palette, ShelfItem } from '@crate/shared';
import { darken, pickInk } from './color.js';
import type { ShelfRow } from './db.js';

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

export function buildShelfItem(row: ShelfRow, artBase: string): ShelfItem {
  const palette = row.palette ? (JSON.parse(row.palette) as Palette) : null;
  const primary = palette?.dominant ?? '#6a6a72';
  const dark = palette?.dark ?? darken(primary, 0.5);
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
    spineStripUrl: row.spine_strip_path ? `${artBase}/${row.spine_strip_path}` : null,
    spineScanUrl: row.spine_scan_path ? `${artBase}/${row.spine_scan_path}` : null,
    artworkUrl: row.artwork_path ? `${artBase}/${row.artwork_path}` : row.artwork_url,
  };
}
