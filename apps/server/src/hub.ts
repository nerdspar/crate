import type { WsMessage } from '@crate/shared';
import type { WebSocket } from 'ws';

/** Which Crate app a `/ws` client is (from the `?app=` query); 'other' if unspecified. */
export type ClientApp = 'shelf' | 'admin' | 'other';

/** Fans server-side events out to all connected shelf/admin clients over `/ws`, and
    tracks how many of each app are connected (for the System service-status view). */
export class Hub {
  private readonly sockets = new Set<WebSocket>();
  private readonly meta = new Map<WebSocket, { app: ClientApp; at: number }>();

  add(ws: WebSocket, app: ClientApp = 'other'): void {
    this.sockets.add(ws);
    this.meta.set(ws, { app, at: Date.now() });
    const drop = (): void => {
      this.sockets.delete(ws);
      this.meta.delete(ws);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  /** Live count of connected clients of a given app. */
  count(app: ClientApp): number {
    let n = 0;
    for (const m of this.meta.values()) if (m.app === app) n++;
    return n;
  }

  /** When the longest-connected client of an app first connected (ms epoch), or
      undefined if none — i.e. how long that app has had continuous presence. */
  oldestSince(app: ClientApp): number | undefined {
    let oldest: number | undefined;
    for (const m of this.meta.values()) {
      if (m.app === app && (oldest === undefined || m.at < oldest)) oldest = m.at;
    }
    return oldest;
  }

  /** Total connected `/ws` clients across all apps. */
  get total(): number {
    return this.sockets.size;
  }

  broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          this.sockets.delete(ws);
          this.meta.delete(ws);
        }
      }
    }
  }
}
