import type { WsMessage } from '@crate/shared';
import type { WebSocket } from 'ws';

/** Fans server-side events out to all connected shelf/admin clients over `/ws`. */
export class Hub {
  private readonly sockets = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => this.sockets.delete(ws));
  }

  broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          this.sockets.delete(ws);
        }
      }
    }
  }
}
