import type { InkColor } from '@crate/shared';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function clamp8(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => clamp8(n).toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Rec.601 luminance, matching the prototype's pickInk math. */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Label ink color from dominant luminance (prototype `pickInk`). */
export function pickInk(hex: string): InkColor {
  return luminance(hex) > 150 ? 'dark' : 'light';
}

export function darken(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: r * (1 - amount), g: g * (1 - amount), b: b * (1 - amount) });
}

export function lighten(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: r + (255 - r) * amount, g: g + (255 - g) * amount, b: b + (255 - b) * amount });
}

export function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex({ r: ra.r + (rb.r - ra.r) * t, g: ra.g + (rb.g - ra.g) * t, b: ra.b + (rb.b - ra.b) * t });
}
