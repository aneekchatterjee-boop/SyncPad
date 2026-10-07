import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(root, env.DATA_DIR || 'data'),
    // How long a dropped connection keeps its seat (name, colour, join order).
    reconnectGraceMs: int(env.RECONNECT_GRACE_MS, 8000),
    // How long a disconnected host keeps admin rights before they move on.
    hostGraceMs: int(env.HOST_GRACE_MS, 3000),
    corsOrigin: env.CORS_ORIGIN || null,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
