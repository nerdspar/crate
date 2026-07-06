import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { MusicAssistantProvider } from '@crate/providers';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Hub } from './hub.js';
import { registerRoutes } from './routes.js';
import { Service } from './service.js';

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const hub = new Hub();
const ma = new MusicAssistantProvider({
  url: cfg.maUrl,
  token: cfg.maToken,
  log: (level, msg) => process.stderr.write(`[ma:${level}] ${msg}\n`),
});
const service = new Service(cfg, db, ma, hub);

const app = Fastify({ logger: false });

await app.register(websocket);
await app.register(fastifyStatic, { root: cfg.artDir, prefix: '/art/' });
if (existsSync(cfg.shelfDist)) {
  await app.register(fastifyStatic, { root: cfg.shelfDist, prefix: '/', decorateReply: false });
}
if (existsSync(cfg.adminDist)) {
  await app.register(fastifyStatic, { root: cfg.adminDist, prefix: '/admin/', decorateReply: false });
}

app.get('/ws', { websocket: true }, (socket) => {
  hub.add(socket);
});

registerRoutes(app, service);

await service.init();
await app.listen({ host: cfg.host, port: cfg.port });
process.stdout.write(`[crate] server listening on http://${cfg.host}:${cfg.port} (MA: ${cfg.maUrl})\n`);
