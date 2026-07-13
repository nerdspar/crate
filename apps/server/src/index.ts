import { existsSync } from 'node:fs';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Hub } from './hub.js';
import { registerRoutes } from './routes.js';
import { Service } from './service.js';

// Keep the appliance alive. A stray background rejection (a failed art fetch, an MA blip)
// must not take down the wall — log and carry on. A truly uncaught exception leaves us in
// an unknown state, so log and exit; systemd (Restart=always) relaunches cleanly.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[crate] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`[crate] uncaughtException: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const hub = new Hub();
const auth = new Auth(db);
// The service owns the MA provider (it can swap the connection at runtime via onboarding/settings).
const service = new Service(cfg, db, hub);

const app = Fastify({ logger: false });

await app.register(websocket);
await app.register(fastifyMultipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
await app.register(fastifyStatic, { root: cfg.artDir, prefix: '/art/' });
// Serve the built front-end bundles (they have no process of their own) and record which
// were mounted so the System service-status view can report them as alive & serving.
const shelfServed = existsSync(cfg.shelfDist);
const adminServed = existsSync(cfg.adminDist);
// The admin owns the root (phones open http://<host>/); the wall/kiosk lives under /wall/.
if (shelfServed) {
  await app.register(fastifyStatic, { root: cfg.shelfDist, prefix: '/wall/', decorateReply: false });
}
if (adminServed) {
  await app.register(fastifyStatic, { root: cfg.adminDist, prefix: '/', decorateReply: false });
  // Back-compat: old /admin bookmarks land on the admin root.
  app.get('/admin', (_req, reply) => reply.redirect('/'));
  app.get('/admin/', (_req, reply) => reply.redirect('/'));
}
service.setFrontendsServed({ shelf: shelfServed, admin: adminServed });

app.get('/ws', { websocket: true }, (socket, req) => {
  // Clients tag themselves (?app=shelf|admin) so the System view can report which apps
  // are connected; anything else counts as 'other'.
  const app = (req.query as { app?: string })?.app;
  hub.add(socket, app === 'shelf' || app === 'admin' ? app : 'other');
});

registerRoutes(app, service, auth);

await service.init();

// Automatic GitHub backups + scheduled auto-update: check each minute whether either is due
// (no-op unless enabled; auto-update also no-ops off the appliance).
setInterval(() => {
  void service.maybeAutoBackup().catch(() => {});
  void service.maybeAutoUpdate().catch(() => {});
}, 60_000).unref();

// Graceful shutdown: `systemctl stop/restart` and the in-app restart send SIGTERM. Close the
// HTTP server + WebSocket hub, then the DB (checkpoints the WAL) before exiting.
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[crate] ${signal} received — shutting down\n`);
  try {
    await app.close();
  } catch {
    /* already closing */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: cfg.host, port: cfg.port });
  process.stdout.write(`[crate] server listening on http://${cfg.host}:${cfg.port} (MA: ${cfg.maUrl})\n`);
} catch (err) {
  process.stderr.write(`[crate] failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
