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
  /** MusicBrainz requires a descriptive User-Agent with contact info. */
  mbUserAgent: string;
  /** Directory of the built shelf app to serve, if present. */
  shelfDist: string;
  adminDist: string;
  /** True on the kiosk appliance — enables restart/reboot and real display power. */
  appliance: boolean;
  /** True when Crate co-hosts/manages this Music Assistant (e.g. installed on the same Pi),
      so a host-level MA restart is meaningful. False for an external MA (e.g. a separate NAS),
      where Crate can configure sources over the API but can't restart the process. */
  managesMa: boolean;
  /** App version string, surfaced in the control-center system row. */
  version: string;
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
    mbUserAgent: process.env.CRATE_MB_UA ?? 'Crate/0.1 ( https://github.com/crate-shelf )',
    shelfDist: resolve('../shelf/dist'),
    adminDist: resolve('../admin/dist'),
    appliance: process.env.CRATE_APPLIANCE === '1',
    managesMa: process.env.CRATE_MANAGES_MA === '1',
    version: process.env.CRATE_VERSION ?? '0.1.0',
  };
}
