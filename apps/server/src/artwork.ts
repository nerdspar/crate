/**
 * Artwork pipeline (§4): download the largest artwork, store a cover rendition
 * and a pre-rendered blurred spine strip, and extract a palette.
 */

import { join } from 'node:path';
import sharp from 'sharp';
import type { Palette } from '@crate/shared';
import { darken, lighten, mix, pickInk, rgbToHex } from './color.js';

export interface ArtworkResult {
  artworkPath: string; // basename under artDir
  spineStripPath: string;
  palette: Palette;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`artwork fetch ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function paletteFrom(dominant: string, muted?: string, dark?: string, light?: string): Palette {
  return {
    dominant,
    muted: muted ?? mix(dominant, '#888888', 0.4),
    dark: dark ?? darken(dominant, 0.55),
    light: light ?? lighten(dominant, 0.45),
    ink: pickInk(dominant),
  };
}

async function extractPalette(buf: Buffer): Promise<Palette> {
  try {
    // node-vibrant v4 (sharp-backed). Kept behind try/catch so an API/version
    // mismatch degrades to sharp's dominant color rather than breaking sync.
    const { Vibrant } = (await import('node-vibrant/node')) as {
      Vibrant: { from(src: Buffer): { getPalette(): Promise<Record<string, { hex?: string } | null>> } };
    };
    const sw = await Vibrant.from(buf).getPalette();
    const hex = (k: string): string | undefined => sw[k]?.hex;
    const dominant = hex('Vibrant') ?? hex('LightVibrant') ?? hex('DarkVibrant') ?? hex('Muted');
    if (dominant) {
      return paletteFrom(
        dominant,
        hex('Muted'),
        hex('DarkVibrant') ?? hex('DarkMuted'),
        hex('LightVibrant') ?? hex('LightMuted'),
      );
    }
  } catch {
    /* fall through to sharp */
  }
  const stats = await sharp(buf).stats();
  return paletteFrom(rgbToHex(stats.dominant));
}

export async function buildArtwork(
  id: string,
  sourceUrl: string,
  opts: { artDir: string; coverHeightPx: number },
): Promise<ArtworkResult> {
  const buf = await fetchBuffer(sourceUrl);
  const coverName = `${id}-cover.jpg`;
  const spineName = `${id}-spine.png`;
  const h = opts.coverHeightPx;

  const meta = await sharp(buf).metadata();
  const srcW = meta.width ?? 600;
  const srcH = meta.height ?? 600;

  // Cover rendition at display height.
  await sharp(buf).resize({ height: h, withoutEnlargement: false }).jpeg({ quality: 82 }).toFile(join(opts.artDir, coverName));

  // Spine strip: 1px center column, stretched to spine size, heavily blurred.
  await sharp(buf)
    .extract({ left: Math.max(0, Math.floor(srcW / 2)), top: 0, width: 1, height: srcH })
    .resize(120, h, { fit: 'fill' })
    .blur(18)
    .png()
    .toFile(join(opts.artDir, spineName));

  const palette = await extractPalette(buf);
  return { artworkPath: coverName, spineStripPath: spineName, palette };
}
