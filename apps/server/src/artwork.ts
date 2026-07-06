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

async function fetchBuffer(url: string, ua?: string): Promise<Buffer> {
  const res = await fetch(url, ua ? { headers: { 'User-Agent': ua } } : undefined);
  if (!res.ok) throw new Error(`artwork fetch ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Turn a Cover Art Archive spine image into a clean vertical spine strip, or
 * return null if it isn't genuinely spine-shaped (SPINE_RENDERING §2). CAA
 * "Spine" images are a mix of clean strips and junk; we only accept long/thin
 * ones (≥3:1) and rotate horizontal scans to vertical.
 */
export async function buildSpineScan(
  id: string,
  candidateUrls: string[],
  opts: { artDir: string; userAgent: string },
): Promise<string | null> {
  for (const url of candidateUrls) {
    let buf: Buffer;
    try {
      buf = await fetchBuffer(url, opts.userAgent);
    } catch {
      continue;
    }
    const meta = await sharp(buf).metadata().catch(() => null);
    const w = meta?.width ?? 0;
    const h = meta?.height ?? 0;
    if (!w || !h) continue;
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    // Quality gate: a genuine spine strip is long & thin at a usable resolution.
    // Aspect ratio is the discriminator (a hi-res spine can be short-side large).
    if (long / short < 4.5 || long < 800 || short < 30) continue;

    const name = `${id}-scan.jpg`;
    let pipeline = sharp(buf);
    if (w > h) pipeline = pipeline.rotate(90); // horizontal scan → vertical spine
    await pipeline.resize({ height: 1800, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(join(opts.artDir, name));
    return name;
  }
  return null;
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

/** Process a user-uploaded custom cover or spine image (per-album override). */
export async function processUploadedArt(
  id: string,
  kind: 'spine' | 'cover',
  buf: Buffer,
  opts: { artDir: string; coverHeightPx: number },
): Promise<string> {
  if (kind === 'cover') {
    const name = `${id}-ov-cover.jpg`;
    await sharp(buf).resize({ height: opts.coverHeightPx }).jpeg({ quality: 85 }).toFile(join(opts.artDir, name));
    return name;
  }
  const name = `${id}-ov-spine.png`;
  const meta = await sharp(buf).metadata();
  let pipeline = sharp(buf);
  if ((meta.width ?? 0) > (meta.height ?? 0)) pipeline = pipeline.rotate(90); // normalize to vertical
  await pipeline.resize({ height: 1800, withoutEnlargement: true }).png().toFile(join(opts.artDir, name));
  return name;
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

  // Spine strip: the left-edge slice of the front art — the strip that wraps
  // onto the spine on a real jewel case — lightly processed so the cover's real
  // colors and texture carry onto the spine (how Spine's generated spines read),
  // rather than a flat gradient. Slightly darkened to sit recessed under the
  // plastic materials layer.
  const sliceW = Math.max(1, Math.round(srcW * 0.07));
  await sharp(buf)
    .extract({ left: 0, top: 0, width: sliceW, height: srcH })
    .resize(140, h, { fit: 'fill' })
    .blur(2)
    .modulate({ brightness: 0.92 })
    .png()
    .toFile(join(opts.artDir, spineName));

  const palette = await extractPalette(buf);

  // Spine label ink from the edge-slice's own brightness (the label sits on the
  // slice, not the whole cover) so contrast holds when the edge differs from the
  // dominant color. Mirror the strip's slight darken (×0.92).
  try {
    const stats = await sharp(buf).extract({ left: 0, top: 0, width: sliceW, height: srcH }).removeAlpha().stats();
    const [r, g, b] = stats.channels;
    if (r && g && b) {
      const lum = (0.299 * r.mean + 0.587 * g.mean + 0.114 * b.mean) * 0.92;
      palette.ink = lum > 150 ? 'dark' : 'light';
    }
  } catch {
    /* keep palette-derived ink */
  }

  return { artworkPath: coverName, spineStripPath: spineName, palette };
}
