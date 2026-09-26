/**
 * SQLite access layer.
 *
 * Locked decisions: SQLite, hand-written SQL, no ORM. `node:sqlite` is a
 * Node built-in, so there is no native dependency to compile.
 *
 * This wrapper exists to provide exactly three things and nothing more:
 *   1. Statement caching (prepare() per call would re-parse SQL every time).
 *   2. Parameter sanitisation — node:sqlite rejects `undefined` and booleans,
 *      and a silent coercion would be a data-integrity hazard.
 *   3. Transactions, including safe nesting via SAVEPOINT.
 *
 * It contains no business logic (DEVELOPMENT_RULES.md §3.4).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Convert a JavaScript value into one node:sqlite can bind without coercion. */
function sanitizeValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`Cannot bind value of type ${typeof value} to a SQL parameter.`);
}

/** Named parameters become a null-prototype object with ':'-prefixed keys. */
function sanitizeParams(params) {
  const list = Array.isArray(params) ? params : [params];
  const named = list.length === 1 && list[0] !== null && typeof list[0] === 'object'
    && !Array.isArray(list[0]) && !(list[0] instanceof Uint8Array);

  if (named) {
    const out = Object.create(null);
    for (const [key, value] of Object.entries(list[0])) {
      out[key.startsWith(':') || key.startsWith('$') ? key : `:${key}`] = sanitizeValue(value);
    }
    return [out];
  }
  return list.map(sanitizeValue);
}

/** node:sqlite returns null-prototype rows; normalise to plain objects. */
function toPlainRow(row) {
  return row === undefined || row === null ? row : { ...row };
}

export class Database {
  /** @param {import('node:sqlite').DatabaseSync} handle */
  constructor(handle, { isMemory = false, path: dbPath = ':memory:' } = {}) {
    this.handle = handle;
    this.isMemory = isMemory;
    this.path = dbPath;
    this.statementCache = new Map();
    this.bigIntStatementCache = new Map();
    this.transactionDepth = 0;
    // Set when a ROLLBACK itself failed, so SQLite may still hold the failed
    // transaction open. It is discarded before the connection is used again.
    this.pendingRollback = false;
    this.closed = false;
  }

  /**
   * Open a database and apply the pragmas the product depends on.
   * foreign_keys is OFF by default in SQLite, so it is enabled explicitly —
   * without it the schema's referential integrity would be decorative.
   */
  static open({ path: dbPath = ':memory:', allowMemory = false } = {}) {
    const isMemory = dbPath === ':memory:' || dbPath === '';

    if (isMemory && !allowMemory) {
      throw new Error('In-memory database is disabled. Set DATABASE_ALLOW_MEMORY=true to permit it.');
    }
    if (!isMemory) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    const handle = new DatabaseSync(isMemory ? ':memory:' : dbPath);

    const database = new Database(handle, { isMemory, path: dbPath });

    handle.exec('PRAGMA foreign_keys = ON');
    if (!isMemory) {
      handle.exec('PRAGMA journal_mode = WAL');
    }
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('PRAGMA synchronous = NORMAL');

    return database;
  }

  prepared(sql) {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.handle.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }

  exec(sql) {
    this.discardOrphanedTransaction();
    this.handle.exec(sql);
  }

  run(sql, params = []) {
    this.discardOrphanedTransaction();
    const result = this.prepared(sql).run(...sanitizeParams(params));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid ?? null,
    };
  }

  get(sql, params = []) {
    this.discardOrphanedTransaction();
    return toPlainRow(this.prepared(sql).get(...sanitizeParams(params)));
  }

  all(sql, params = []) {
    this.discardOrphanedTransaction();
    return this.prepared(sql).all(...sanitizeParams(params)).map(toPlainRow);
  }

  /**
   * Like all(), but INTEGER columns are read as BigInt. Used for monetary
   * aggregates (SUM), which must stay exact and are added up in BigInt.
   */
  allBigInts(sql, params = []) {
    this.discardOrphanedTransaction();
    let statement = this.bigIntStatementCache.get(sql);
    if (!statement) {
      statement = this.handle.prepare(sql);
      statement.setReadBigInts(true);
      this.bigIntStatementCache.set(sql, statement);
    }
    return statement.all(...sanitizeParams(params)).map(toPlainRow);
  }

  /** First column of the first row, or undefined. */
  getValue(sql, params = []) {
    const row = this.get(sql, params);
    if (row === undefined) return undefined;
    const [first] = Object.values(row);
    return first;
  }

  /**
   * Run `fn` inside a transaction. Nested calls use SAVEPOINTs so a service
   * can compose another service's transactional work safely.
   *
   * Whatever happens — `fn` throwing, COMMIT failing (e.g. a deferred
   * constraint, SQLITE_BUSY, a full disk) or the rollback itself failing — the
   * depth is restored to its value on entry, the failed work is rolled back,
   * and the original error is rethrown. The connection stays usable.
   *
   * `fn` must be synchronous: node:sqlite is synchronous, and an async callback
   * would reach COMMIT before its awaited statements ran.
   */
  transaction(fn) {
    const depth = this.transactionDepth;
    const isOutermost = depth === 0;
    const savepoint = `sp_${depth}`;

    if (isOutermost) {
      this.discardOrphanedTransaction();
      this.handle.exec('BEGIN');
    } else {
      this.handle.exec(`SAVEPOINT ${savepoint}`);
    }
    this.transactionDepth = depth + 1;

    try {
      const result = fn();
      if (result !== null && typeof result?.then === 'function') {
        throw new TypeError('db.transaction() requires a synchronous callback; an async one would commit before its work ran.');
      }
      this.handle.exec(isOutermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.rollbackFailedTransaction(isOutermost, savepoint);
      throw error;
    } finally {
      this.transactionDepth = depth;
    }
  }

  /** Undo a failed transaction or savepoint without masking the original error. */
  rollbackFailedTransaction(isOutermost, savepoint) {
    try {
      if (isOutermost) {
        this.handle.exec('ROLLBACK');
      } else {
        // ROLLBACK TO keeps the savepoint on the stack; RELEASE removes it.
        this.handle.exec(`ROLLBACK TO ${savepoint}`);
        this.handle.exec(`RELEASE ${savepoint}`);
      }
    } catch {
      // Either SQLite already rolled the transaction back (it does on some
      // errors) or the rollback genuinely failed and the transaction may still
      // be open. Both are resolved by discarding it before the next use.
      this.pendingRollback = true;
    }
  }

  /**
   * Roll back a transaction left open by a failed ROLLBACK. Only runs outside
   * any transaction of ours, so it can never cut short work that is in flight.
   */
  discardOrphanedTransaction() {
    if (!this.pendingRollback || this.transactionDepth !== 0) return;
    this.pendingRollback = false;
    try {
      this.handle.exec('ROLLBACK');
    } catch {
      // Nothing was left open.
    }
  }

  close() {
    if (this.closed) return;
    this.statementCache.clear();
    this.bigIntStatementCache.clear();
    this.handle.close();
    this.closed = true;
  }
}
