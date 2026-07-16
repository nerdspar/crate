/**
 * Music Assistant WebSocket client (device-service grade).
 *
 * Productionized from scripts/phase0-ma.ts: same JSON-RPC-over-WS protocol and
 * token auth, plus auto-reconnect with backoff and a connect-listener hook so
 * the server can resync players/state after MA restarts or network blips.
 *
 * Protocol:
 *   - connect → server sends a ServerInfoMessage
 *   - first command must be `auth` with { token }
 *   - commands: { message_id, command, args } → { message_id, result | error_code }
 *   - events: { event, object_id, data } pushed on the same socket
 */

import { fetchWithTimeout } from '@crate/shared';
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
  /** MA base URL, e.g. http://192.168.1.50:8095 */
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
  /** Epoch ms when the current connection authenticated, or undefined if disconnected. */
  connectedAt: number | undefined;

  constructor(private readonly opts: MaClientOptions) {
    this.backoff = opts.minBackoffMs ?? 1000;
  }

  /** True while the MA websocket is open AND authenticated (connectedAt is set after the auth
      handshake and cleared on close) — not merely socket-open, during which MA rejects commands. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.connectedAt !== undefined;
  }

  /** Drop the live socket so the auto-reconnect immediately re-establishes it (the
      "reconnect Music Assistant" action). No-op while already disconnected — the
      backoff loop is handling that. */
  reconnect(): void {
    if (!this.ws) return;
    this.backoff = this.opts.minBackoffMs ?? 1000; // reconnect fast, not on a grown backoff
    try {
      this.ws.close(); // the 'close' handler schedules the reconnect
    } catch {
      /* ignore */
    }
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
            this.connectedAt = Date.now();
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
        this.connectedAt = undefined;
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
      // Clear the timeout when the command settles (via a response or rejectAllPending) so a
      // burst of commands (e.g. a library import) doesn't hold hundreds of live timers for 20s.
      const timer = setTimeout(() => {
        if (this.pending.delete(message_id)) reject(new Error(`MA command ${command} timed out`));
      }, timeoutMs);
      this.pending.set(message_id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ message_id, command, args }));
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

/**
 * Mint a long-lived MA token from a username + password (for the co-hosted onboarding flow, so the
 * user never has to create one by hand). A one-shot raw connection: wait for ServerInfo → `auth/login`
 * (authenticates the session) → `auth/token/create` (the long-lived token). Not part of MaClient,
 * which auto-authenticates with a token instead.
 */
export async function mintMaToken(url: string, username: string, password: string, deviceName = 'Crate'): Promise<string> {
  const wsUrl = `${url.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>();
    let settled = false;
    const finish = (err?: Error, token?: string): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(token!);
    };
    const call = (command: string, args: Record<string, unknown>): Promise<unknown> =>
      new Promise((res, rej) => {
        const message_id = String(nextId++);
        pending.set(message_id, { res, rej });
        ws.send(JSON.stringify({ message_id, command, args }));
      });

    ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      // Command result / error.
      if (typeof msg['message_id'] === 'string') {
        const entry = pending.get(msg['message_id']);
        if (!entry) return;
        pending.delete(msg['message_id']);
        if ('error_code' in msg) entry.rej(new Error(`${String(msg['error_code'])}: ${String(msg['details'] ?? '')}`));
        else entry.res(msg['result']);
        return;
      }
      // ServerInfo (once) → login → authenticate the session with the returned access token →
      // create a long-lived token. `auth/login` returns {success, access_token} but does NOT itself
      // authenticate the WS session, so the `auth` step is required before token/create.
      if (typeof msg['server_version'] === 'string') {
        void (async () => {
          try {
            const login = (await call('auth/login', { username, password, device_name: deviceName })) as {
              success?: boolean;
              error?: string;
              access_token?: string;
            };
            if (!login?.success || !login.access_token) {
              throw new Error(login?.error || 'Invalid Music Assistant username or password.');
            }
            await call('auth', { token: login.access_token });
            const created = await call('auth/token/create', { name: `Crate (${deviceName})` });
            const token = typeof created === 'string' ? created : ((created as { token?: string } | null)?.token ?? '');
            if (!token) throw new Error('Music Assistant did not return a token.');
            finish(undefined, token);
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)));
          }
        })();
      }
    });
    ws.on('error', (e: Error) => finish(new Error(`Couldn’t reach Music Assistant: ${e.message}`)));
    ws.on('close', () => finish(new Error('Music Assistant closed the connection before login completed.')));
    setTimeout(() => finish(new Error('Music Assistant login timed out.')), 15_000);
  });
}

/**
 * Reachability + first-run state of a (co-hosted) MA. A fresh MA blocks the WS API with
 * "Setup required" and only accepts the owner via the unauthenticated `POST /setup` route; probing
 * it with an empty body distinguishes a fresh instance ("username required" style error) from a
 * configured one ("Setup already completed"). `reachable:false` means the HTTP server isn't up yet
 * (e.g. the container is still starting) — the caller can keep polling until it comes up.
 */
export async function maSetupState(url: string): Promise<{ reachable: boolean; needsSetup: boolean }> {
  try {
    const res = await fetchWithTimeout(`${url.replace(/\/+$/, '')}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, 10_000);
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!j || typeof j.error !== 'string') return { reachable: true, needsSetup: false };
    return { reachable: true, needsSetup: j.error !== 'Setup already completed' };
  } catch {
    return { reachable: false, needsSetup: false };
  }
}

/** Create the first admin account on a fresh MA via the unauthenticated `POST /setup` route. */
export async function setupMaAccount(url: string, username: string, password: string): Promise<void> {
  const res = await fetchWithTimeout(`${url.replace(/\/+$/, '')}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, device_name: 'Crate' }),
  }, 15_000);
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
  if (!j.success) throw new Error(j.error || `Music Assistant setup failed (HTTP ${res.status}).`);
}
