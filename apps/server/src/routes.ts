import type { FastifyInstance } from 'fastify';
import type {
  AddToShelfRequest,
  GroupRequest,
  PlayRequest,
  Settings,
  TransportRequest,
  VolumeRequest,
} from '@crate/shared';
import type { Service } from './service.js';

export function registerRoutes(app: FastifyInstance, service: Service): void {
  app.get('/api/shelf', () => service.getShelf());

  app.get('/api/albums/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await service.albumDetail(id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return detail;
  });

  app.get('/api/players', () => service.getPlayers());

  app.get('/api/search', async (req) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    return q ? service.search(q) : [];
  });

  app.post('/api/play', async (req) => {
    const b = req.body as PlayRequest;
    await service.play(b.albumId, b.trackIndex, b.playerId);
    return { ok: true };
  });

  app.post('/api/transport', async (req) => {
    const b = req.body as TransportRequest;
    await service.transport(b.playerId, b.cmd, b.position);
    return { ok: true };
  });

  app.post('/api/volume', async (req) => {
    const b = req.body as VolumeRequest;
    await service.setVolume(b.playerId, b.level);
    return { ok: true };
  });

  app.post('/api/group', async (req) => {
    const b = req.body as GroupRequest;
    await service.group(b.playerIds);
    return { ok: true };
  });

  app.post('/api/shelf/add', async (req) => {
    const b = req.body as AddToShelfRequest;
    await service.addToShelf(b.providerUri);
    return { ok: true };
  });

  app.delete('/api/shelf/:id', (req) => {
    const { id } = req.params as { id: string };
    service.removeFromShelf(id);
    return { ok: true };
  });

  app.get('/api/settings', () => service.getSettings());

  app.put('/api/settings', (req) => service.putSettings(req.body as Partial<Settings>));
}
