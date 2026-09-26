/**
 * Process entry point.
 *
 * Order matters: configuration is validated, then the database is opened and
 * migrated, and only then is the port bound. A configuration or migration
 * failure therefore stops startup with a clear message instead of serving a
 * half-working API.
 */

import process from 'node:process';
import { loadConfig, loadEnvFile } from './config/index.js';
import { Database } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createLogger } from './lib/logger.js';
import { startServer } from './app.js';

async function main() {
  loadEnvFile();

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n`);
    process.stderr.write('Copy backend/.env.example to backend/.env and adjust it.\n');
    process.exit(1);
    return;
  }

  const logger = createLogger({ level: config.logLevel });

  const db = Database.open({
    path: config.database.path,
    allowMemory: config.database.allowMemory,
  });

  try {
    const { applied } = migrate(db, { log: logger });
    if (applied.length > 0) {
      logger.info('migrations applied', { count: applied.length, versions: applied.map((m) => m.version) });
    }
  } catch (error) {
    logger.error('migration failed', { error });
    db.close();
    process.exit(1);
    return;
  }

  const app = await startServer({ config, db, logger });

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    app.server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not hang forever on lingering keep-alive connections.
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  process.stderr.write(`Fatal startup error: ${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
