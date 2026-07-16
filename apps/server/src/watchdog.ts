import { execFile } from 'node:child_process';

/**
 * systemd hardware-style watchdog. When the server runs under a unit with `WatchdogSec=` set,
 * systemd expects a `WATCHDOG=1` heartbeat at least every WatchdogSec seconds; if it stops
 * arriving, systemd kills the service and (with `Restart=always`) relaunches the wall.
 *
 * We beat every WATCHDOG_USEC/2 (systemd's recommended cadence), but only after a lightweight
 * health check passes. That catches two failure modes a bare `Restart=always` can't:
 *   - a wedged event loop (a sync infinite loop / native hang) — the timer stops firing, so no beat;
 *   - a wedged SQLite (locked past busy_timeout) — the health check throws, so we skip the beat.
 * Either way the heartbeats stop and systemd relaunches a clean process.
 *
 * Node has no native sd_notify (its dgram is UDP-only, so it can't write the AF_UNIX datagram
 * systemd listens on), so we shell out to `systemd-notify` — always present alongside systemd, and
 * accepted from this child because the unit sets `NotifyAccess=all`.
 *
 * A NO-OP anywhere but under a watchdog unit (dev, the preview server, a plain `node` run): with
 * no `NOTIFY_SOCKET`/`WATCHDOG_USEC` in the environment it simply returns, so it's safe to always call.
 */
export function startWatchdog(opts: { healthy?: () => boolean } = {}): void {
  const socket = process.env['NOTIFY_SOCKET'];
  const usec = Number(process.env['WATCHDOG_USEC']);
  if (!socket || !Number.isFinite(usec) || usec <= 0) return; // not running under a watchdog unit

  // WATCHDOG_PID, when set, names the single process systemd wants the heartbeat from — respect it
  // so a stray fork can't keep a hung main process alive.
  const wpid = process.env['WATCHDOG_PID'];
  if (wpid && wpid !== String(process.pid)) return;

  const intervalMs = Math.max(1000, Math.floor(usec / 1000 / 2)); // µs → ms, beat at half the timeout
  let warned = false;
  const beat = (): void => {
    // Unhealthy → skip the beat. systemd then restarts once WatchdogSec elapses with no heartbeat.
    if (opts.healthy && !safeTrue(opts.healthy)) return;
    execFile('systemd-notify', ['WATCHDOG=1'], (err) => {
      if (err && !warned) {
        warned = true; // log once — a persistent failure will show as repeated watchdog restarts anyway
        process.stderr.write(`[crate] watchdog: systemd-notify failed (${err.message})\n`);
      }
    });
  };

  beat(); // first heartbeat right away, so systemd sees liveness immediately
  setInterval(beat, intervalMs).unref();
  process.stdout.write(`[crate] watchdog armed: heartbeat every ${Math.round(intervalMs / 1000)}s\n`);
}

function safeTrue(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}
