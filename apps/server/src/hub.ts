import type { WsMessage } from '@crate/shared';
import type { WebSocket } from 'ws';

/** Which Crate app a `/ws` client is (from the `?app=` query); 'other' if unspecified. */
export type ClientApp = 'shelf' | 'admin' | 'other';

/** Fans server-side events out to all connected shelf/admin clients over `/ws`, and
    tracks how many of each app are connected (for the System service-status view). */
export class Hub {
  private readonly sockets = new Set<WebSocket>();
  private readonly app = new Map<WebSocket, ClientApp>();

  add(ws: WebSocket, app: ClientApp = 'other'): void {
    this.sockets.add(ws);
    this.app.set(ws, app);
    const drop = (): void => {
      this.sockets.delete(ws);
      this.app.delete(ws);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  /** Live count of connected clients of a given app. */
  count(app: ClientApp): number {
    let n = 0;
    for (const a of this.app.values()) if (a === app) n++;
    return n;
  }

  broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          this.sockets.delete(ws);
          this.app.delete(ws);
        }
      }
    }
  }
}
