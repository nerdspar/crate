/**
 * Appliance/display control for the control center's system rows (§6, §7).
 *
 * Everything here is best-effort and degrades gracefully: on the Raspberry Pi
 * kiosk the real methods drive the panel; on a dev box none apply and we fall
 * back to 'software' brightness (a client-side dim overlay) and no-op display
 * power, so the UI is fully exercisable without hardware.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import type { BrightnessMethod } from '@crate/shared';

const pexec = promisify(execFile);

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
