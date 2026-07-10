/**
 * Real spine art via MusicBrainz + Cover Art Archive (SPINE_RENDERING §2).
 *
 * Coverage is partial (skews to classic albums with physical pressings) and the
 * "Spine" images are heterogeneous — some clean strips, some junk — so this is
 * strictly best-effort: return a candidate spine image URL or null, and let the
 * artwork pipeline apply the quality gate + fallback.
 *
 * MusicBrainz requires a descriptive User-Agent and rate-limits to ~1 req/sec;
 * calls are serialized through a throttle.
 */

import { fetchWithTimeout } from '@crate/shared';

const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Serialize MusicBrainz requests with ≥1.1s spacing (their limit is ~1/sec).
let mbChain: Promise<unknown> = Promise.resolve();
function mbThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const run = mbChain.then(fn, fn);
  mbChain = run.then(
    () => sleep(1100),
    () => sleep(1100),
  );
  return run as Promise<T>;
}

interface MbRelease {
  id: string;
  title: string;
  year: number | null;
  score: number;
}

async function searchReleases(artist: string, title: string, ua: string): Promise<MbRelease[]> {
  const q = `artist:"${artist}" AND release:"${title}"`;
  const url = `${MB}/release/?query=${encodeURIComponent(q)}&fmt=json&limit=10`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': ua, accept: 'application/json' } }, 15_000);
  if (!res.ok) return [];
  const body = (await res.json()) as { releases?: Array<Record<string, unknown>> };
  return (body.releases ?? []).map((r) => {
    const date = typeof r['date'] === 'string' ? r['date'] : '';
    return {
      id: String(r['id'] ?? ''),
      title: typeof r['title'] === 'string' ? r['title'] : '',
      year: date ? Number.parseInt(date.slice(0, 4), 10) || null : null,
      score: typeof r['score'] === 'number' ? r['score'] : 0,
    };
  });
}

/** Rank releases: confident title match, prefer year proximity, then MB score. */
function rankReleases(releases: MbRelease[], title: string, year: number | null): MbRelease[] {
  const nt = norm(title);
  return releases
    .filter((r) => {
      const rn = norm(r.title);
      return rn === nt || (rn.includes(nt) && r.score >= 90);
    })
    .sort((a, b) => {
      const ay = year && a.year ? Math.abs(a.year - year) : 99;
      const by = year && b.year ? Math.abs(b.year - year) : 99;
      if (ay !== by) return ay - by;
      return b.score - a.score;
    });
}

async function caaSpineUrl(releaseId: string, ua: string): Promise<string | null> {
  const res = await fetchWithTimeout(`${CAA}/release/${releaseId}`, {
    headers: { 'User-Agent': ua, accept: 'application/json' },
  }, 15_000);
  if (!res.ok) return null;
  const body = (await res.json()) as { images?: Array<Record<string, unknown>> };
  const spine = (body.images ?? []).find((im) => Array.isArray(im['types']) && (im['types'] as string[]).includes('Spine'));
  if (!spine) return null;
  return typeof spine['image'] === 'string' ? spine['image'] : null;
}

/**
 * Best-effort: candidate spine-image URLs for this album, ranked across matching
 * releases. Returns several so the artwork pipeline can quality-gate each and
 * keep the first genuinely spine-shaped one (many CAA "Spine" scans are junk).
 */
export async function findSpineScans(
  artist: string,
  title: string,
  year: number | null,
  ua: string,
): Promise<string[]> {
  try {
    const releases = await mbThrottle(() => searchReleases(artist, title, ua));
    const ranked = rankReleases(releases, title, year).slice(0, 8);
    const urls: string[] = [];
    for (const rel of ranked) {
      await sleep(300); // gentle to archive.org
      const url = await caaSpineUrl(rel.id, ua);
      if (url && !urls.includes(url)) urls.push(url);
      if (urls.length >= 5) break;
    }
    return urls;
  } catch {
    return [];
  }
}
