/**
 * Transaction state after failures (BUG 1).
 *
 * Before the fix, a failed COMMIT decremented transactionDepth twice, leaving
 * it at -1; every later db.transaction() then issued `SAVEPOINT sp_-1` and
 * failed with a syntax error until the process restarted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/connection.js';

function openWithDeferredForeignKey() {
  const db = Database.open({ path: ':memory:', allowMemory: true });
  db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
  // A deferred constraint is checked at COMMIT, so it makes COMMIT itself fail.
  db.exec(
    'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED)',
  );
  return db;
}

/** Where the runtime exposes it, confirm SQLite itself is back in autocommit. */
function assertNoOpenTransaction(db) {
  if (typeof db.handle.isTransaction === 'boolean') {
    assert.equal(db.handle.isTransaction, false, 'SQLite must not be left inside a transaction');
  }
}

function ids(db, table) {
  return db.all(`SELECT id FROM ${table} ORDER BY id`).map((row) => row.id);
}

test('a failed COMMIT rolls back, restores depth 0, and the next transaction works', () => {
  const db = openWithDeferredForeignKey();
  try {
    assert.throws(
      () => db.transaction(() => db.run('INSERT INTO child VALUES (?, ?)', ['c1', 'missing-parent'])),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(db.transactionDepth, 0, 'depth must never go negative');
    assertNoOpenTransaction(db);
    assert.deepEqual(ids(db, 'child'), [], 'the failed transaction left nothing behind');

    db.transaction(() => {
      db.run('INSERT INTO parent VALUES (?)', ['p1']);
      db.run('INSERT INTO child VALUES (?, ?)', ['c2', 'p1']);
    });
    assert.deepEqual(ids(db, 'parent'), ['p1']);
    assert.deepEqual(ids(db, 'child'), ['c2']);
  } finally {
    db.close();
  }
});

test('repeated COMMIT failures never accumulate state', () => {
  const db = openWithDeferredForeignKey();
  try {
    for (let i = 0; i < 5; i += 1) {
      assert.throws(() => db.transaction(() => db.run('INSERT INTO child VALUES (?, ?)', [`c${i}`, 'nope'])));
      assert.equal(db.transactionDepth, 0);
    }
    db.transaction(() => db.run('INSERT INTO parent VALUES (?)', ['ok']));
    assert.deepEqual(ids(db, 'parent'), ['ok']);
  } finally {
    db.close();
  }
});

test('a failed COMMIT inside a nested call keeps the savepoint stack correct', () => {
  const db = openWithDeferredForeignKey();
  try {
    assert.throws(() => {
      db.transaction(() => {
        db.run('INSERT INTO parent VALUES (?)', ['outer']);
        db.transaction(() => db.run('INSERT INTO child VALUES (?, ?)', ['c1', 'missing']));
      });
    }, /FOREIGN KEY constraint failed/);
    assert.equal(db.transactionDepth, 0);
    assertNoOpenTransaction(db);
    assert.deepEqual(ids(db, 'parent'), [], 'outer work is rolled back with the failed commit');

    db.transaction(() => {
      db.run('INSERT INTO parent VALUES (?)', ['after']);
      db.transaction(() => db.run('INSERT INTO parent VALUES (?)', ['after-nested']));
    });
    assert.deepEqual(ids(db, 'parent'), ['after', 'after-nested']);
  } finally {
    db.close();
  }
});

test('an inner failure caught by the outer transaction rolls back only the inner work', () => {
  const db = Database.open({ path: ':memory:', allowMemory: true });
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', ['outer-1']);
      assert.throws(() => db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', ['inner']);
        throw new Error('inner failure');
      }), /inner failure/);
      assert.equal(db.transactionDepth, 1, 'back at the outer depth');
      db.run('INSERT INTO t VALUES (?)', ['outer-2']);
    });
    assert.deepEqual(ids(db, 't'), ['outer-1', 'outer-2']);
    assert.equal(db.transactionDepth, 0);

    // The same savepoint name can be reused afterwards.
    db.transaction(() => db.transaction(() => db.run('INSERT INTO t VALUES (?)', ['reused'])));
    assert.deepEqual(ids(db, 't'), ['outer-1', 'outer-2', 'reused']);
  } finally {
    db.close();
  }
});

test('a failed ROLLBACK leaves a recoverable connection: the orphaned transaction is discarded', () => {
  const db = Database.open({ path: ':memory:', allowMemory: true });
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

    // Make exactly one ROLLBACK fail, so SQLite really keeps the transaction open.
    const real = db.handle;
    let failNextRollback = true;
    db.handle = {
      exec(sql) {
        if (sql === 'ROLLBACK' && failNextRollback) {
          failNextRollback = false;
          throw new Error('simulated rollback failure');
        }
        return real.exec(sql);
      },
      prepare: (sql) => real.prepare(sql),
      close: () => real.close(),
      get isTransaction() {
        return real.isTransaction;
      },
    };

    assert.throws(() => db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', ['doomed']);
      throw new Error('business failure');
    }), /business failure/, 'the original error surfaces, not the rollback error');
    assert.equal(db.transactionDepth, 0);

    // Plain statements and new transactions work, and the doomed row is gone.
    db.run('INSERT INTO t VALUES (?)', ['plain']);
    assertNoOpenTransaction(db);
    db.transaction(() => db.run('INSERT INTO t VALUES (?)', ['tx']));
    assert.deepEqual(ids(db, 't'), ['plain', 'tx']);
  } finally {
    db.close();
  }
});

test('an async transaction callback is refused and its work rolled back', () => {
  const db = Database.open({ path: ':memory:', allowMemory: true });
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    assert.throws(
      () => db.transaction(async () => {
        db.run('INSERT INTO t VALUES (?)', ['async']);
      }),
      /synchronous callback/,
    );
    assert.equal(db.transactionDepth, 0);
    assert.deepEqual(ids(db, 't'), []);
    db.transaction(() => db.run('INSERT INTO t VALUES (?)', ['sync']));
    assert.deepEqual(ids(db, 't'), ['sync']);
  } finally {
    db.close();
  }
});

test('transactions return the callback value', () => {
  const db = Database.open({ path: ':memory:', allowMemory: true });
  try {
    assert.equal(db.transaction(() => 42), 42);
    assert.equal(db.transaction(() => db.transaction(() => 'nested')), 'nested');
  } finally {
    db.close();
  }
});
