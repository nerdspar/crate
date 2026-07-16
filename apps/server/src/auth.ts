/**
 * Admin auth (Phase 5) — a single passphrase that gates the admin/config endpoints.
 *
 * Off until a passphrase is set. The wall (shelf) keeps working unauthenticated: playback,
 * grouping, and the control-center system controls stay open (see the OPEN allowlist in routes).
 * Sessions are stateless, signed cookies (survive restarts, no session store); the secret and the
 * scrypt password hash live in the DB (dotted `auth.*` keys, never returned to the client).
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

const COOKIE = 'crate_admin';
const SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days

export class Auth {
  constructor(private readonly db: Db) {}

  /** HMAC secret for session cookies — generated once, persisted. */
  private secret(): string {
    let s = this.db.getRaw<string>('auth.secret', '');
    if (!s) {
      s = randomBytes(32).toString('hex');
      this.db.setRaw('auth.secret', s);
    }
    return s;
  }

  /** Auth is enabled once a passphrase is set. */
  enabled(): boolean {
    return !!this.db.getRaw<string>('auth.hash', '');
  }

  /** Set (or, with an empty value, clear → disable) the admin passphrase. */
  setPassphrase(next: string): void {
    // Rotate the session-signing secret on ANY passphrase change so every previously-issued cookie
    // (incl. a captured one) is invalidated — a stateless token can't otherwise be revoked. The
    // caller re-issues its own cookie right after with the new secret, so it stays signed in.
    this.db.setRaw('auth.secret', randomBytes(32).toString('hex'));
    if (!next) {
      this.db.setRaw('auth.hash', '');
      return;
    }
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(next, salt, 32).toString('hex');
    this.db.setRaw('auth.hash', `${salt}:${hash}`);
  }

  verifyPassphrase(pass: string): boolean {
    const stored = this.db.getRaw<string>('auth.hash', '');
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const test = scryptSync(pass, salt, 32);
    const want = Buffer.from(hash, 'hex');
    return test.length === want.length && timingSafeEqual(test, want);
  }

  /** A stateless session token: `<expiryMs>.<hmac>`. */
  issueToken(): string {
    const exp = String(Date.now() + SESSION_MS);
    return `${exp}.${createHmac('sha256', this.secret()).update(exp).digest('hex')}`;
  }
  validToken(token: string | undefined): boolean {
    if (!token) return false;
    const [exp, sig] = token.split('.');
    const expMs = Number(exp);
    if (!exp || !sig || !Number.isFinite(expMs) || expMs < Date.now()) return false; // non-numeric exp → treat as invalid
    const want = createHmac('sha256', this.secret()).update(exp).digest('hex');
    // Decode both hex→bytes and compare byte buffers. Comparing the raw strings byte-lengths could
    // differ from their char-lengths (a crafted multibyte cookie), which throws in timingSafeEqual.
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(want, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  }

  /** True when the request carries a valid session cookie. */
  authed(cookieHeader: string | undefined): boolean {
    return this.validToken(this.parseToken(cookieHeader));
  }

  setCookieHeader(token: string): string {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`;
  }
  clearCookieHeader(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }
  private parseToken(cookieHeader: string | undefined): string | undefined {
    for (const part of (cookieHeader ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
    }
    return undefined;
  }
}
