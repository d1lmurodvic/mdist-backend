/**
 * Database CLI.
 *
 *   node src/db/cli.js migrate   apply pending migrations
 *   node src/db/cli.js status    show applied/pending migrations
 *
 * Kept separate from the server so migrations can be applied in a deploy step
 * or by hand without binding a port.
 */

import process from 'node:process';
import { loadConfig, loadEnvFile } from '../config/index.js';
import { Database } from './connection.js';
import { migrate, migrationStatus } from './migrate.js';

loadEnvFile();

const command = process.argv[2] ?? 'migrate';
const config = loadConfig(process.env);
const db = Database.open({ path: config.database.path, allowMemory: config.database.allowMemory });

try {
  if (command === 'migrate') {
    const { applied, alreadyApplied } = migrate(db);
    if (applied.length === 0) {
      process.stdout.write(`Database is up to date (${alreadyApplied.length} migration(s) applied).\n`);
    } else {
      process.stdout.write(`Applied ${applied.length} migration(s):\n`);
      for (const item of applied) process.stdout.write(`  ${item.version}_${item.name}\n`);
    }
  } else if (command === 'status') {
    const status = migrationStatus(db);
    process.stdout.write(`Applied (${status.applied.length}):\n`);
    for (const row of status.applied) {
      process.stdout.write(`  ${row.version}_${row.name}  ${row.applied_at}\n`);
    }
    process.stdout.write(`Pending (${status.pending.length}):\n`);
    for (const row of status.pending) process.stdout.write(`  ${row.version}_${row.name}\n`);
  } else {
    process.stderr.write(`Unknown command "${command}". Use: migrate | status\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
