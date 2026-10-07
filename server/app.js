import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Room } from './room.js';
import { attachRoomSockets } from './sockets.js';
import { RoomStore } from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createServer(config) {
  const store = new RoomStore(config.dataDir, { debounceMs: config.saveDebounceMs ?? 750 });
  const rooms = new Map();
  for (const data of await store.load()) rooms.set(data.id, new Room(data));
  store.getRooms = () => [...rooms.values()];

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
      ].join('; '),
    });
    next();
  });

  const startedAt = Date.now();
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/stats', (_req, res) => {
    let online = 0;
    let active = 0;
    for (const room of rooms.values()) {
      const n = room.connectedMembers().length;
      online += n;
      if (n) active++;
    }
    res.json({ rooms: rooms.size, activeRooms: active, online, uptime: Math.round((Date.now() - startedAt) / 1000) });
  });

  app.use('/shared', express.static(path.join(root, 'shared')));
  app.use(express.static(path.join(root, 'public')));

  const httpServer = createHttpServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 512 * 1024,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    cors: config.corsOrigin ? { origin: config.corsOrigin } : undefined,
  });
  attachRoomSockets(io, { rooms, store, config });

  return {
    app,
    io,
    httpServer,
    rooms,
    store,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address())));
    },
    async close() {
      await new Promise((resolve) => io.close(() => resolve()));
      await store.close();
    },
  };
}
