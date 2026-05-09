import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { createApiServer } from '../api/server.js';

interface ServeOptions { dataDir?: string; port?: string; }

export async function handleServe(opts: ServeOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const port = parseInt(opts.port || '43187', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('Error: Invalid port number.');
    process.exit(1);
  }
  ensureInitialized(dataDir);

  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: ' + err.message);
      process.exit(1);
    }
    throw err;
  }
  storage.close();
  try {
    const server = await createApiServer({ dataDir, port });
    await server.listen();
    console.log('Coding Effectiveness Tracker Dashboard');
    console.log('');
    console.log(' URL:      http://127.0.0.1:' + port);
    console.log(' Health:   http://127.0.0.1:' + port + '/health');
    console.log(' Privacy: All data stays local. No telemetry or external services.');
    console.log('');
    console.log('Press Ctrl+C to stop.');
    const shutdown = async () => {
      console.log('Shutting down...');
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise<void>(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('EADDRINUSE')) {
      console.error('Error: Port ' + port + ' is already in use.');
      console.error('Try a different port: cet serve -p <port>');
      process.exit(1);
    }
    console.error('Error: ' + message);
    process.exit(1);
  }
}

