/**
 * Appliance/display control for the control center's system rows (§6, §7).
 *
 * Everything here is best-effort and degrades gracefully: on the Raspberry Pi
 * kiosk the real methods drive the panel; on a dev box none apply and we fall
 * back to 'software' brightness (a client-side dim overlay) and no-op display
 * power, so the UI is fully exercisable without hardware.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BrightnessMethod } from '@crate/shared';

const pexec = promisify(execFile);

// This file is apps/server/src/system.ts, so the repo root is three levels up.
// Resolving from the module (not process.cwd) keeps it correct under systemd.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const UPDATE_SCRIPT = resolve(REPO_ROOT, 'deploy', 'pi', 'update.sh');

let cachedMethod: BrightnessMethod | null = null;
let cachedBacklight: string | null = null;

/** Detect how to drive the backlight, in the plan's fallback order (§7):
    sysfs backlight (Pi DSI/HDMI) → ddcutil (DDC/CI) → software dim overlay. */
export function detectBrightnessMethod(): BrightnessMethod {
  if (cachedMethod) return cachedMethod;
  try {
    const base = '/sys/class/backlight';
    if (existsSync(base)) {
      const devs = readdirSync(base);
      if (devs.length && devs[0]) {
        cachedBacklight = `${base}/${devs[0]}`;
        cachedMethod = 'sysfs';
        return cachedMethod;
      }
    }
  } catch {
    /* fall through */
  }
  if (existsSync('/usr/bin/ddcutil') || existsSync('/usr/local/bin/ddcutil')) {
    cachedMethod = 'ddcutil';
    return cachedMethod;
  }
  cachedMethod = 'software';
  return cachedMethod;
}

/** Apply a 0–100 brightness via the detected method. 'software' is a no-op
    server-side — the client renders the dim overlay from the stored level. */
export async function applyBrightness(level: number): Promise<void> {
  const method = detectBrightnessMethod();
  const pct = Math.max(0, Math.min(100, Math.round(level)));
  try {
    if (method === 'sysfs' && cachedBacklight) {
      const max = Number.parseInt(readFileSync(`${cachedBacklight}/max_brightness`, 'utf8').trim(), 10) || 255;
      writeFileSync(`${cachedBacklight}/brightness`, String(Math.round((pct / 100) * max)));
    } else if (method === 'ddcutil') {
      await pexec('ddcutil', ['setvcp', '10', String(pct)]);
    }
  } catch {
    /* non-fatal: the panel may not support the method — the level is still stored */
  }
}

/** Power the display on/off. Tries the common kiosk stacks; failures are
    non-fatal (the client overlay still blanks the screen). No-op on dev. */
export async function setDisplayPower(on: boolean): Promise<void> {
  const cmds: Array<[string, string[]]> = on
    ? [
        ['wlopm', ['--on', '*']],
        ['vcgencmd', ['display_power', '1']],
      ]
    : [
        ['wlopm', ['--off', '*']],
        ['vcgencmd', ['display_power', '0']],
      ];
  for (const [bin, args] of cmds) {
    try {
      await pexec(bin, args);
      return;
    } catch {
      /* try the next method */
    }
  }
}

export async function rebootSystem(): Promise<void> {
  await pexec('systemctl', ['reboot']);
}

interface GitUpdateInfo {
  /** Short SHA of the running checkout, or null if git is unavailable. */
  current: string | null;
  /** Short SHA of the upstream tip after a fetch, or null if none tracked. */
  latest: string | null;
  /** How many commits HEAD is behind upstream. */
  behind: number;
  updateAvailable: boolean;
  error?: string;
}

/** Fetch the tracked remote and report whether the checkout is behind upstream.
    Read-only and best-effort: any git/network failure returns updateAvailable:false
    with the error, so "check for updates" degrades to a clear message. */
export async function checkForUpdate(): Promise<GitUpdateInfo> {
  // Container deployments (Docker/TrueNAS) ship a built image, not a checkout —
  // there's nothing to git-pull, so say so instead of a misleading "offline".
  if (!existsSync(resolve(REPO_ROOT, '.git'))) {
    return { current: null, latest: null, behind: 0, updateAvailable: false, error: 'not-a-git-checkout' };
  }
  const git = (args: string[]): Promise<string> =>
    // `-c safe.directory=*` disarms git's dubious-ownership guard: crate.service runs
    // as root, but the checkout is owned by the install user, which git would otherwise
    // refuse to touch. (update.sh runs git as that owner via sudo, so it's unaffected.)
    pexec('git', ['-c', 'safe.directory=*', '-C', REPO_ROOT, ...args], { timeout: 20000 }).then((r) => r.stdout.trim());
  try {
    await git(['fetch', '--quiet']);
    const current = await git(['rev-parse', '--short', 'HEAD']);
    try {
      const latest = await git(['rev-parse', '--short', '@{u}']);
      const behind = Number.parseInt(await git(['rev-list', '--count', 'HEAD..@{u}']), 10) || 0;
      return { current, latest, behind, updateAvailable: behind > 0 };
    } catch {
      return { current, latest: current, behind: 0, updateAvailable: false }; // no upstream tracked
    }
  } catch (e) {
    return { current: null, latest: null, behind: 0, updateAvailable: false, error: (e as Error).message };
  }
}

/** Latest Music Assistant server version published on GitHub (releases/latest
    tag_name, e.g. "2.9.6"), or null if it can't be reached. Read-only, best-effort. */
export async function latestMaRelease(): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch('https://api.github.com/repos/music-assistant/server/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'crate-appliance' },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return (data.tag_name ?? '').trim().replace(/^v/i, '') || null;
  } catch {
    return null;
  }
}

/** Launch deploy/pi/update.sh detached, OUTSIDE crate.service's cgroup, so it
    survives the `systemctl restart crate` it runs at the end. Prefers a transient
    systemd unit (the appliance always has systemd); falls back to a detached child.
    Returns whether launch succeeded. Caller must gate this on appliance mode. */
export function spawnUpdate(target: 'crate' | 'ma' | 'both'): boolean {
  const flags = target === 'crate' ? ['--no-ma'] : target === 'ma' ? ['--ma-only'] : [];
  const launch = (cmd: string, args: string[]): boolean => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {}); // ENOENT etc. surface async; swallow so we can fall back
      child.unref();
      return true;
    } catch {
      return false;
    }
  };
  if (existsSync('/usr/bin/systemd-run') || existsSync('/bin/systemd-run')) {
    // --collect reaps the transient unit even if the script exits non-zero.
    if (launch('systemd-run', ['--collect', '--quiet', '--unit', 'crate-update', 'bash', UPDATE_SCRIPT, ...flags])) return true;
  }
  return launch('bash', [UPDATE_SCRIPT, ...flags]);
}

/** Progress of an in-flight update: whether the crate-update unit is still running, plus the tail
    of its journal (git pull → build → restart). Best-effort — {active:false,log:[]} if systemctl/
    journalctl aren't available or the unit was already collected. */
export async function updateProgress(): Promise<{ active: boolean; log: string[] }> {
  let active = false;
  try {
    const state = (await pexec('systemctl', ['show', 'crate-update.service', '--property=ActiveState', '--value', '--no-pager'], { timeout: 4000 })).stdout.trim();
    active = state === 'activating' || state === 'active' || state === 'reloading';
  } catch {
    /* unit collected/absent → treat as not running */
  }
  let log: string[] = [];
  try {
    log = (await pexec('journalctl', ['-u', 'crate-update.service', '-n', '60', '--no-pager', '-o', 'cat'], { timeout: 5000 })).stdout
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter(Boolean);
  } catch {
    /* journal unavailable */
  }
  return { active, log };
}

/** First non-internal IPv4 address, for the system row. */
export function getLocalIp(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}
