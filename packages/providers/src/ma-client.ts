/**
 * Music Assistant WebSocket client (device-service grade).
 *
 * Productionized from scripts/phase0-ma.ts: same JSON-RPC-over-WS protocol and
 * token auth, plus auto-reconnect with backoff and a connect-listener hook so
 * the server can resync players/state after MA restarts or network blips.
 *
 * Protocol (see docs/playback.md):
 *   - connect → server sends a ServerInfoMessage
 *   - first command must be `auth` with { token }
 *   - commands: { message_id, command, args } → { message_id, result | error_code }
 *   - events: { event, object_id, data } pushed on the same socket
 */

import { WebSocket } from 'ws';

export interface MaServerInfo {
  server_id?: string;
  server_version?: string;
  schema_version?: number;
  base_url?: string;
}

export interface MaEvent {
  event: string;
  object_id?: string;
  data?: unknown;
}

export interface MaClientOptions {
  /** MA base URL, e.g. http://10.0.1.96:8095 */
  url: string;
  /** MA long-lived token (schema >= 28). */
  token: string;
  /** Optional logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Reconnect backoff bounds (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class MaClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(e: MaEvent) => void>();
  private readonly connectListeners = new Set<(info: MaServerInfo) => void>();
  private closed = false;
  private backoff: number;
  serverInfo: MaServerInfo | undefined;

  constructor(private readonly opts: MaClientOptions) {
    this.backoff = opts.minBackoffMs ?? 1000;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.opts.log?.(level, msg);
  }

  /** Connect + authenticate. Rejects if the first attempt fails; thereafter reconnects on its own. */
  async start(): Promise<MaServerInfo> {
    const info = await this.connectOnce();
    return info;
  }

  private wsUrl(): string {
    return `${this.opts.url.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
  }

  private connectOnce(): Promise<MaServerInfo> {
    return new Promise<MaServerInfo>((resolve, reject) => {
      const url = this.wsUrl();
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      const finish = (err?: Error, info?: MaServerInfo): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(info!);
      };

      ws.on('open', () => this.log('info', `MA websocket open (${url})`));

      ws.on('message', (raw: Buffer) => {
        this.handleMessage(raw, async (info) => {
          // ServerInfo received → authenticate, then declare the connection ready.
          this.serverInfo = info;
          try {
            await this.command('auth', { token: this.opts.token });
            this.backoff = this.opts.minBackoffMs ?? 1000;
            this.log('info', `MA authenticated (v${info.server_version ?? '?'})`);
            for (const cb of this.connectListeners) {
              try {
                cb(info);
              } catch {
                /* listener errors are their own problem */
              }
            }
            finish(undefined, info);
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
            ws.close();
          }
        });
      });

      ws.on('error', (err: Error) => {
        this.log('warn', `MA websocket error: ${err.message}`);
        finish(new Error(`MA websocket error connecting to ${url}: ${err.message}`));
      });

      ws.on('close', () => {
        this.ws = undefined;
        this.rejectAllPending(new Error('MA websocket closed'));
        finish(new Error('MA websocket closed before ready'));
        if (!this.closed) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    this.log('info', `MA reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (this.closed) return;
      this.connectOnce().catch((err: unknown) => {
        this.log('warn', `MA reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, delay);
  }

  private handleMessage(raw: Buffer, onServerInfo: (info: MaServerInfo) => void): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    // Event push.
    if (typeof msg['event'] === 'string') {
      const event: MaEvent = {
        event: msg['event'],
        object_id: typeof msg['object_id'] === 'string' ? msg['object_id'] : undefined,
        data: msg['data'],
      };
      for (const cb of this.eventListeners) {
        try {
          cb(event);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    // Command result / error.
    if (typeof msg['message_id'] === 'string') {
      const entry = this.pending.get(msg['message_id']);
      if (!entry) return;
      this.pending.delete(msg['message_id']);
      if ('error_code' in msg) {
        entry.reject(new Error(`${String(msg['error_code'])}: ${String(msg['details'] ?? '')}`));
      } else {
        entry.resolve(msg['result']);
      }
      return;
    }
    // ServerInfoMessage (once, on connect).
    if (typeof msg['server_version'] === 'string') {
      onServerInfo(msg as MaServerInfo);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  command<T = unknown>(command: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`MA not connected (command ${command})`));
    }
    const message_id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message_id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ message_id, command, args }));
      setTimeout(() => {
        if (this.pending.delete(message_id)) reject(new Error(`MA command ${command} timed out`));
      }, timeoutMs);
    });
  }

  /** Subscribe to all MA events. Returns an unsubscribe fn. */
  onEvent(cb: (e: MaEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** Called after every successful (re)connect + auth — use to resync. */
  onConnect(cb: (info: MaServerInfo) => void): () => void {
    this.connectListeners.add(cb);
    return () => this.connectListeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
