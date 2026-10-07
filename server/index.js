import { loadConfig } from './config.js';
import { createServer } from './app.js';

try {
  process.loadEnvFile?.();
} catch {
  // no .env file: defaults and real environment variables apply
}

const config = loadConfig();
const server = await createServer(config);
const address = await server.listen();
const shownHost = ['0.0.0.0', '::'].includes(address.address) ? 'localhost' : address.address;
console.log(`SyncPad listening on http://${shownHost}:${address.port}`);
console.log(`Rooms persisted in ${config.dataDir} (${server.rooms.size} loaded)`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received, saving rooms and closing connections...`);
  const force = setTimeout(() => process.exit(1), 5000);
  await server.close();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
