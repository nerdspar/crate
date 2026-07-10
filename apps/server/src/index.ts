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
if (shelfServed) {
  await app.register(fastifyStatic, { root: cfg.shelfDist, prefix: '/', decorateReply: false });
}
if (adminServed) {
  await app.register(fastifyStatic, { root: cfg.adminDist, prefix: '/admin/', decorateReply: false });
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

// Automatic GitHub backups: check each minute whether one is due (no-op unless enabled).
setInterval(() => void service.maybeAutoBackup(), 60_000).unref();

await app.listen({ host: cfg.host, port: cfg.port });
process.stdout.write(`[crate] server listening on http://${cfg.host}:${cfg.port} (MA: ${cfg.maUrl})\n`);
