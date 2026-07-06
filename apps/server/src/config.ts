import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  maUrl: string;
  maToken: string;
  dataDir: string;
  artDir: string;
  dbPath: string;
  host: string;
  port: number;
  /** Target cover rendition height in px (display height ×2 per §4). */
  coverHeightPx: number;
  /** Directory of the built shelf app to serve, if present. */
  shelfDist: string;
  adminDist: string;
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.CRATE_DATA_DIR ?? './data');
  const artDir = resolve(dataDir, 'art');
  mkdirSync(artDir, { recursive: true });

  const maToken = process.env.MA_TOKEN ?? '';
  if (!maToken) {
    process.stderr.write(
      '[crate] WARNING: MA_TOKEN is not set — Music Assistant calls will fail auth.\n' +
        '        Create a long-lived token in the MA web UI and set MA_TOKEN.\n',
    );
  }

  return {
    maUrl: (process.env.MA_URL ?? 'http://homeassistant.local:8095').replace(/\/+$/, ''),
    maToken,
    dataDir,
    artDir,
    dbPath: resolve(dataDir, 'crate.db'),
    host: process.env.CRATE_HOST ?? '0.0.0.0',
    port: Number.parseInt(process.env.CRATE_PORT ?? '8080', 10),
    coverHeightPx: Number.parseInt(process.env.CRATE_COVER_HEIGHT ?? '1440', 10),
    shelfDist: resolve('../shelf/dist'),
    adminDist: resolve('../admin/dist'),
  };
}
