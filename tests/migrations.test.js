import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db/connection.js';
import { migrate, migrationStatus, migrationsDir } from '../src/db/migrate.js';

function withTempMigrations(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ifrsmart-migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql, 'utf8');
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function openMemory() {
  return Database.open({ path: ':memory:', allowMemory: true });
}

test('migrations create the auth and tenancy schema', () => {
  const db = openMemory();
  try {
    const { applied } = migrate(db);
    assert.ok(applied.length >= 1, 'at least one migration must be applied');

    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type='table'")
      .map((row) => row.name);

    for (const table of ['users', 'companies', 'memberships', 'sessions', '_migrations']) {
      assert.ok(tables.includes(table), `expected table ${table}`);
    }
  } finally {
    db.close();
  }
});

test('migrations are idempotent — running twice applies nothing new', () => {
  const db = openMemory();
  try {
    const first = migrate(db);
    const second = migrate(db);
    assert.ok(first.applied.length >= 1);
    assert.equal(second.applied.length, 0, 'second run must apply nothing');
    assert.ok(second.alreadyApplied.length >= 1);
  } finally {
    db.close();
  }
});

test('migrations run in filename order', () => {
  withTempMigrations(
    {
      '001_first.sql': 'CREATE TABLE step_one (id TEXT PRIMARY KEY);',
      '002_second.sql': 'CREATE TABLE step_two (id TEXT PRIMARY KEY);',
      '010_tenth.sql': 'CREATE TABLE step_ten (id TEXT PRIMARY KEY);',
    },
    (dir) => {
      const db = openMemory();
      try {
        const { applied } = migrate(db, { dir });
        assert.deepEqual(applied.map((m) => m.version), ['001', '002', '010']);
      } finally {
        db.close();
      }
    },
  );
});

test('editing an applied migration is detected rather than silently diverging', () => {
  withTempMigrations({ '001_only.sql': 'CREATE TABLE original_table (id TEXT PRIMARY KEY);' }, (dir) => {
    const db = openMemory();
    try {
      migrate(db, { dir });
      fs.writeFileSync(
        path.join(dir, '001_only.sql'),
        'CREATE TABLE tampered_table (id TEXT PRIMARY KEY);',
        'utf8',
      );
      assert.throws(() => migrate(db, { dir }), /has changed since it was applied/);
    } finally {
      db.close();
    }
  });
});

test('a migration with a bad filename is rejected', () => {
  withTempMigrations({ 'no-version.sql': 'SELECT 1;' }, (dir) => {
    const db = openMemory();
    try {
      assert.throws(() => migrate(db, { dir }), /must be NNN_name\.sql/);
    } finally {
      db.close();
    }
  });
});

test('a failing migration rolls back and is not recorded as applied', () => {
  withTempMigrations(
    {
      '001_valid.sql': 'CREATE TABLE keeper (id TEXT PRIMARY KEY);',
      '002_invalid.sql': 'CREATE TABLE broken (id TEXT PRIMARY KEY, ;',
    },
    (dir) => {
      const db = openMemory();
      try {
        assert.throws(() => migrate(db, { dir }));
        const status = migrationStatus(db, { dir });
        assert.equal(status.applied.length, 1, 'only the valid migration is recorded');
        assert.equal(status.pending.length, 1, 'the failed migration remains pending');
      } finally {
        db.close();
      }
    },
  );
});

test('migrationStatus separates applied from pending', () => {
  const db = openMemory();
  try {
    migrate(db);
    const status = migrationStatus(db);
    assert.equal(status.pending.length, 0);
    assert.ok(status.applied.length >= 1);
    assert.ok(status.applied[0].applied_at, 'records when the migration was applied');
  } finally {
    db.close();
  }
});

test('foreign keys are enforced by the connection', () => {
  const db = openMemory();
  try {
    migrate(db);
    assert.equal(db.getValue('PRAGMA foreign_keys'), 1, 'foreign_keys pragma must be ON');
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ['cmp_1', 'Acme', 'UZS', 1, 'UTC', 0, now, now],
    );
    assert.throws(
      () =>
        db.run(
          'INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES (?,?,?,?,?)',
          ['mem_1', 'usr_missing', 'cmp_1', 'owner', now],
        ),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('company demo flag and fiscal month are constrained by the schema', () => {
  const db = openMemory();
  try {
    migrate(db);
    const now = new Date().toISOString();
    assert.throws(
      () =>
        db.run(
          'INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          ['cmp_bad', 'Bad', 'UZS', 13, 'UTC', 0, now, now],
        ),
      /CHECK constraint failed/,
      'fiscal month must be 1-12',
    );
    assert.throws(
      () =>
        db.run(
          'INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          ['cmp_bad2', 'Bad', 'usd', 1, 'UTC', 0, now, now],
        ),
      /CHECK constraint failed/,
      'currency must be uppercase ISO code',
    );
  } finally {
    db.close();
  }
});

test('membership role is constrained and unique per user/company', () => {
  const db = openMemory();
  try {
    migrate(db);
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ['cmp_1', 'Acme', 'UZS', 1, 'UTC', 0, now, now],
    );
    db.run(
      'INSERT INTO users (id, email, password_hash, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ['usr_1', 'owner@example.com', 'hash', 'Owner', 'active', now, now],
    );
    db.run(
      'INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES (?,?,?,?,?)',
      ['mem_1', 'usr_1', 'cmp_1', 'owner', now],
    );
    assert.throws(
      () =>
        db.run(
          'INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES (?,?,?,?,?)',
          ['mem_2', 'usr_1', 'cmp_1', 'owner', now],
        ),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        db.run(
          'INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES (?,?,?,?,?)',
          ['mem_3', 'usr_1', 'cmp_1', 'superuser', now],
        ),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

const INSERT_USER =
  'INSERT INTO users (id, email, password_hash, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)';

function insertUser(db, id, email) {
  const now = new Date().toISOString();
  db.run(INSERT_USER, [id, email, 'hash', 'Name', 'active', now, now]);
}

test('a duplicate canonical email is rejected by UNIQUE', () => {
  const db = openMemory();
  try {
    migrate(db);
    insertUser(db, 'usr_1', 'owner@example.com');
    assert.throws(() => insertUser(db, 'usr_2', 'owner@example.com'), /UNIQUE constraint failed/);
  } finally {
    db.close();
  }
});

// Regression (BUG 6). This file used to hold a test called "email uniqueness is
// case-insensitive via normalisation" that inserted the SAME lower-case email
// twice — it never tried a case variant, and 'Owner@Example.com' was accepted
// beside 'owner@example.com'. Migration 002 makes the database enforce it.
test('email identity is case-insensitive in the database', () => {
  const db = openMemory();
  try {
    migrate(db);
    insertUser(db, 'usr_1', 'owner@example.com');
    for (const variant of ['Owner@Example.com', 'OWNER@EXAMPLE.COM', ' owner@example.com']) {
      assert.throws(() => insertUser(db, 'usr_x', variant), /users\.email must be trimmed and lower-cased/, variant);
    }
    assert.throws(
      () => db.run('UPDATE users SET email = ? WHERE id = ?', ['Owner@Example.com', 'usr_1']),
      /users\.email must be trimmed and lower-cased/,
    );
    db.run('UPDATE users SET email = ? WHERE id = ?', ['new@example.com', 'usr_1']);
    db.run('UPDATE users SET name = ? WHERE id = ?', ['Renamed', 'usr_1']);
    assert.equal(db.getValue('SELECT count(*) FROM users'), 1);
  } finally {
    db.close();
  }
});

test('migration 002 canonicalises existing emails', () => {
  withTempMigrations({}, (dir) => {
    fs.copyFileSync(path.join(migrationsDir, '001_auth_and_tenancy.sql'), path.join(dir, '001_auth_and_tenancy.sql'));
    const db = openMemory();
    try {
      migrate(db, { dir });
      insertUser(db, 'usr_1', ' Owner@Example.COM');
      fs.copyFileSync(path.join(migrationsDir, '002_users_email_canonical.sql'), path.join(dir, '002_users_email_canonical.sql'));
      const { applied } = migrate(db, { dir });
      assert.deepEqual(applied.map((m) => m.version), ['002']);
      assert.equal(db.getValue('SELECT email FROM users WHERE id = ?', ['usr_1']), 'owner@example.com');
    } finally {
      db.close();
    }
  });
});

test('migration 002 refuses to merge accounts that differ only by case', () => {
  withTempMigrations({}, (dir) => {
    fs.copyFileSync(path.join(migrationsDir, '001_auth_and_tenancy.sql'), path.join(dir, '001_auth_and_tenancy.sql'));
    const db = openMemory();
    try {
      migrate(db, { dir });
      insertUser(db, 'usr_1', 'owner@example.com');
      insertUser(db, 'usr_2', 'Owner@Example.com');
      fs.copyFileSync(path.join(migrationsDir, '002_users_email_canonical.sql'), path.join(dir, '002_users_email_canonical.sql'));
      assert.throws(() => migrate(db, { dir }), /UNIQUE constraint failed/);
      // Rolled back as a unit: nothing changed, 002 is still pending.
      assert.deepEqual(migrationStatus(db, { dir }).pending.map((m) => m.version), ['002']);
      assert.equal(db.getValue('SELECT email FROM users WHERE id = ?', ['usr_2']), 'Owner@Example.com');
    } finally {
      db.close();
    }
  });
});

test('a clean database gets every migration, in order', () => {
  const db = openMemory();
  try {
    const { applied } = migrate(db);
    // 003 (financial core) was added in Phase 3, 004 (invoices) in Phase 4, 005 (documents) in Phase 5,
    // 006 (intelligence and engagement) in the final backend completion.
    assert.deepEqual(applied.map((m) => m.version), ['001', '002', '003', '004', '005', '006']);
    const triggers = db.all("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").map((r) => r.name);
    // The documents_* triggers come from 005 (Phase 5).
    assert.deepEqual(triggers, [
      'documents_links_same_company_insert', 'documents_links_same_company_update',
      'users_email_canonical_insert', 'users_email_canonical_update',
    ]);
  } finally {
    db.close();
  }
});

test('migration 003 gives every existing company its Uncategorized category', () => {
  withTempMigrations({}, (dir) => {
    for (const file of ['001_auth_and_tenancy.sql', '002_users_email_canonical.sql']) {
      fs.copyFileSync(path.join(migrationsDir, file), path.join(dir, file));
    }
    const db = openMemory();
    try {
      migrate(db, { dir });
      const now = new Date().toISOString();
      for (const id of ['cmp_1', 'cmp_2']) {
        db.run(
          'INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          [id, id, 'UZS', 1, 'UTC', 0, now, now],
        );
      }
      fs.copyFileSync(path.join(migrationsDir, '003_financial_core.sql'), path.join(dir, '003_financial_core.sql'));
      assert.deepEqual(migrate(db, { dir }).applied.map((m) => m.version), ['003']);

      const rows = db.all('SELECT company_id, name, type, is_system, id FROM categories ORDER BY company_id');
      assert.deepEqual(rows.map((row) => [row.company_id, row.name, row.type, row.is_system]), [
        ['cmp_1', 'Uncategorized', null, 1], ['cmp_2', 'Uncategorized', null, 1],
      ]);
      for (const row of rows) assert.match(row.id, /^cat_[0-9A-F]{26}$/, 'a valid opaque id');
    } finally {
      db.close();
    }
  });
});

test('deleting a company removes all of its financial data', () => {
  const db = openMemory();
  try {
    migrate(db);
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ['cmp_1', 'Acme', 'UZS', 1, 'UTC', 0, now, now],
    );
    db.run("INSERT INTO categories (id, company_id, name, type, is_system, created_at, updated_at) VALUES ('cat_u', 'cmp_1', 'Uncategorized', NULL, 1, 'x', 'x')");
    db.run("INSERT INTO categories (id, company_id, name, type, is_system, created_at, updated_at) VALUES ('cat_r', 'cmp_1', 'Rent', 'expense', 0, 'x', 'x')");
    db.run("INSERT INTO accounts (id, company_id, name, type, currency, created_at, updated_at) VALUES ('acc_1', 'cmp_1', 'Bank', 'bank', 'UZS', 'x', 'x')");
    db.run("INSERT INTO category_rules (id, company_id, source, match_type, pattern, category_id, created_at, updated_at) VALUES ('rul_1', 'cmp_1', 'user', 'exact', 'x', 'cat_r', 'x', 'x')");
    db.run(`INSERT INTO transactions (id, company_id, type, amount_minor, currency, date, account_id, category_id, category_source, review_status, created_at, updated_at)
            VALUES ('txn_1', 'cmp_1', 'expense', 5, 'UZS', '2025-03-01', 'acc_1', 'cat_r', 'rule', 'needs_review', 'x', 'x')`);

    // A category still used by a transaction cannot be removed on its own...
    assert.throws(() => db.run("DELETE FROM categories WHERE id = 'cat_r'"), /FOREIGN KEY constraint failed/);
    // ...but deleting the company cascades through everything it owns.
    db.run("DELETE FROM companies WHERE id = 'cmp_1'");
    for (const table of ['accounts', 'categories', 'category_rules', 'transactions']) {
      assert.equal(db.getValue(`SELECT count(*) FROM ${table}`), 0, table);
    }
  } finally {
    db.close();
  }
});

test('the ledger schema enforces money and direction constraints', () => {
  const db = openMemory();
  try {
    migrate(db);
    db.run("INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES ('cmp_1','A','UZS',1,'UTC',0,'x','x')");
    db.run("INSERT INTO categories (id, company_id, name, type, is_system, created_at, updated_at) VALUES ('cat_u', 'cmp_1', 'Uncategorized', NULL, 1, 'x', 'x')");
    db.run("INSERT INTO accounts (id, company_id, name, type, currency, created_at, updated_at) VALUES ('acc_1', 'cmp_1', 'Bank', 'bank', 'UZS', 'x', 'x')");
    const insert = (type, amount) => db.run(
      `INSERT INTO transactions (id, company_id, type, amount_minor, currency, date, account_id, category_id, category_source, review_status, created_at, updated_at)
       VALUES (?, 'cmp_1', ?, ?, 'UZS', '2025-03-01', 'acc_1', 'cat_u', 'fallback', 'needs_review', 'x', 'x')`,
      [`txn_${type}_${amount}`, type, amount],
    );
    assert.throws(() => insert('expense', 0), /CHECK constraint failed/, 'amounts are positive');
    assert.throws(() => insert('expense', -1), /CHECK constraint failed/);
    assert.throws(() => insert('transfer', 1), /CHECK constraint failed/, 'direction is income or expense');
    assert.throws(() => insert('income', 2 ** 53), /CHECK constraint failed/, 'beyond the exact range');
    insert('income', Number.MAX_SAFE_INTEGER);
    assert.throws(
      () => db.run("INSERT INTO categories (id, company_id, name, type, is_system, created_at, updated_at) VALUES ('cat_n', 'cmp_1', 'Untyped', NULL, 0, 'x', 'x')"),
      /CHECK constraint failed/,
      'only the system category may be untyped',
    );
  } finally {
    db.close();
  }
});

test('migration 004 upgrades a 003 database with existing ledger data intact', () => {
  withTempMigrations({}, (dir) => {
    for (const file of ['001_auth_and_tenancy.sql', '002_users_email_canonical.sql', '003_financial_core.sql']) {
      fs.copyFileSync(path.join(migrationsDir, file), path.join(dir, file));
    }
    const db = openMemory();
    try {
      migrate(db, { dir });
      db.run("INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES ('cmp_1','A','UZS',1,'UTC',0,'x','x')");
      db.run("INSERT INTO categories (id, company_id, name, type, is_system, created_at, updated_at) VALUES ('cat_u', 'cmp_1', 'Uncategorized', NULL, 1, 'x', 'x')");
      db.run("INSERT INTO accounts (id, company_id, name, type, currency, created_at, updated_at) VALUES ('acc_1', 'cmp_1', 'Bank', 'bank', 'UZS', 'x', 'x')");
      db.run(`INSERT INTO transactions (id, company_id, type, amount_minor, currency, date, account_id, category_id, category_source, review_status, created_at, updated_at)
              VALUES ('txn_1', 'cmp_1', 'income', 700, 'UZS', '2025-03-01', 'acc_1', 'cat_u', 'fallback', 'needs_review', 'x', 'x')`);

      fs.copyFileSync(path.join(migrationsDir, '004_invoice_management.sql'), path.join(dir, '004_invoice_management.sql'));
      assert.deepEqual(migrate(db, { dir }).applied.map((m) => m.version), ['004']);
      assert.equal(db.getValue("SELECT amount_minor FROM transactions WHERE id = 'txn_1'"), 700, 'ledger rows untouched');
      for (const table of ['contacts', 'invoices', 'invoice_line_items', 'idempotency_keys']) {
        assert.equal(db.getValue(`SELECT count(*) FROM ${table}`), 0, table);
      }
    } finally {
      db.close();
    }
  });
});

// Renamed: this test used to be called "... roll back independently", but what
// it proves is that an inner error that propagates rolls back the OUTER
// transaction too. Independent rollback is covered in connection.test.js.
test('an error propagating out of a nested transaction rolls back the outer one', () => {
  const db = openMemory();
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.run('INSERT INTO t (id) VALUES (?)', ['a']);

    assert.throws(() => {
      db.transaction(() => {
        db.run('INSERT INTO t (id) VALUES (?)', ['b']);
        db.transaction(() => {
          db.run('INSERT INTO t (id) VALUES (?)', ['c']);
          throw new Error('inner failure');
        });
      });
    }, /inner failure/);

    const rows = db.all('SELECT id FROM t ORDER BY id').map((row) => row.id);
    assert.deepEqual(rows, ['a'], 'the outer transaction rolled back entirely');
  } finally {
    db.close();
  }
});

test('committed nested transactions persist', () => {
  const db = openMemory();
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.transaction(() => {
      db.run('INSERT INTO t (id) VALUES (?)', ['a']);
      db.transaction(() => {
        db.run('INSERT INTO t (id) VALUES (?)', ['b']);
      });
    });
    assert.equal(db.all('SELECT id FROM t').length, 2);
  } finally {
    db.close();
  }
});
