/**
 * Versioned SQL migrations.
 *
 * ARCHITECTURE.md B5 / the task brief require the database to be reproducible
 * from a clean checkout, so schema is never created by hand: every change is a
 * numbered .sql file applied in order and recorded in `_migrations`.
 *
 * Each migration runs in a transaction and is checksummed, so editing an
 * already-applied file is detected instead of silently diverging environments.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nowIsoTimestamp } from '../lib/dates.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

function readMigrationFiles(dir = migrationsDir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((file) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) {
        throw new Error(`Migration filename must be NNN_name.sql, got "${file}".`);
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return {
        version: match[1],
        name: match[2],
        file,
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    });
}

function ensureLedger(db) {
  db.exec(CREATE_LEDGER);
}

function appliedRecords(db) {
  ensureLedger(db);
  return db.all('SELECT version, name, checksum, applied_at FROM _migrations ORDER BY version');
}

/**
 * Apply every pending migration. Returns what was applied.
 * @returns {{ applied: Array<{version: string, name: string}>, alreadyApplied: string[] }}
 */
export function migrate(db, { dir = migrationsDir, log } = {}) {
  const files = readMigrationFiles(dir);
  const existing = appliedRecords(db);
  const existingByVersion = new Map(existing.map((row) => [row.version, row]));

  const problems = [];
  for (const row of existing) {
    const file = files.find((candidate) => candidate.version === row.version);
    if (!file) {
      problems.push(`Migration ${row.version} (${row.name}) is recorded as applied but its file is missing.`);
    } else if (file.checksum !== row.checksum) {
      problems.push(
        `Migration ${file.file} has changed since it was applied. Applied migrations are immutable — add a new migration instead.`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Migration history is inconsistent:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  const pending = files.filter((file) => !existingByVersion.has(file.version));
  const applied = [];

  for (const file of pending) {
    db.transaction(() => {
      db.exec(file.sql);
      db.run(
        'INSERT INTO _migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [file.version, file.name, file.checksum, nowIsoTimestamp()],
      );
    });
    applied.push({ version: file.version, name: file.name });
    log?.info?.('migration applied', { version: file.version, name: file.name });
  }

  return { applied, alreadyApplied: existing.map((row) => row.version) };
}

/** Report applied/pending state without changing anything. */
export function migrationStatus(db, { dir = migrationsDir } = {}) {
  const files = readMigrationFiles(dir);
  const existing = appliedRecords(db);
  const existingVersions = new Set(existing.map((row) => row.version));

  return {
    applied: existing,
    pending: files
      .filter((file) => !existingVersions.has(file.version))
      .map((file) => ({ version: file.version, name: file.name })),
  };
}

export { migrationsDir };
