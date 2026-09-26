/**
 * Migration 005 (documents) against an existing Phase 4 database, and the
 * constraints it adds. Uses the real migration files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db/connection.js';
import { migrate, migrationsDir } from '../src/db/migrate.js';

const PHASE_4 = ['001_auth_and_tenancy.sql', '002_users_email_canonical.sql', '003_financial_core.sql', '004_invoice_management.sql'];
const NOW = '2025-03-14T00:00:00.000Z';

function seedPhase4(db) {
  db.run(`INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES ('cmp_1','A','UZS',1,'UTC',0,'x','x')`);
  db.run(`INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES ('cmp_2','B','UZS',1,'UTC',0,'x','x')`);
  for (const company of ['cmp_1', 'cmp_2']) {
    const n = company.slice(-1);
    db.run(`INSERT INTO categories (id, company_id, name, type, is_system, created_at, updated_at) VALUES ('cat_${n}', ?, 'Uncategorized', NULL, 1, 'x', 'x')`, [company]);
    db.run(`INSERT INTO accounts (id, company_id, name, type, currency, created_at, updated_at) VALUES ('acc_${n}', ?, 'Bank', 'bank', 'UZS', 'x', 'x')`, [company]);
    db.run(`INSERT INTO transactions (id, company_id, type, amount_minor, currency, date, account_id, category_id, category_source, review_status, created_at, updated_at)
            VALUES ('txn_${n}', ?, 'expense', 700, 'UZS', '2025-03-01', 'acc_${n}', 'cat_${n}', 'fallback', 'needs_review', 'x', 'x')`, [company]);
    db.run(`INSERT INTO contacts (id, company_id, name, type, created_at, updated_at) VALUES ('con_${n}', ?, 'Vendor', 'vendor', 'x', 'x')`, [company]);
    db.run(`INSERT INTO invoices (id, company_id, number, type, contact_id, status, currency, issue_date, due_date, subtotal_minor, tax_minor, total_minor, created_at, updated_at)
            VALUES ('inv_${n}', ?, 'B-1', 'payable', 'con_${n}', 'draft', 'UZS', '2025-03-01', '2025-03-31', 100, 0, 100, 'x', 'x')`, [company]);
  }
}

function snapshot(db) {
  return Object.fromEntries(['companies', 'categories', 'accounts', 'transactions', 'contacts', 'invoices'].map(
    (table) => [table, db.all(`SELECT * FROM ${table} ORDER BY id`)],
  ));
}

function withPhase4Database(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ifrsmart-migrations-'));
  const db = Database.open({ path: ':memory:', allowMemory: true });
  try {
    for (const file of PHASE_4) fs.copyFileSync(path.join(migrationsDir, file), path.join(dir, file));
    migrate(db, { dir });
    seedPhase4(db);
    const before = snapshot(db);
    fs.copyFileSync(path.join(migrationsDir, '005_documents.sql'), path.join(dir, '005_documents.sql'));
    assert.deepEqual(migrate(db, { dir }).applied.map((m) => m.version), ['005']);
    assert.deepEqual(snapshot(db), before, 'existing Phase 1–4 rows are untouched');
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function insertDocument(db, overrides = {}) {
  const row = {
    id: 'doc_1', company_id: 'cmp_1', original_filename: 'r.pdf', storage_key: 'cmp_1/doc_1.pdf', mime_type: 'application/pdf',
    size_bytes: 10, status: 'processing', failure_code: null, failure_message: null, confirmed_target: null,
    transaction_id: null, invoice_id: null, confirmed_at: null, processed_at: null, created_at: NOW, updated_at: NOW, ...overrides,
  };
  const columns = Object.keys(row);
  db.run(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row));
}

test('migration 005 upgrades a Phase 4 database with accounts, categories, transactions, contacts and invoices intact', () => {
  withPhase4Database((db) => {
    assert.equal(db.getValue('SELECT count(*) FROM documents'), 0);
    assert.equal(db.getValue('SELECT count(*) FROM document_extractions'), 0);
    // The new tables work against the upgraded data.
    insertDocument(db, { status: 'ready', processed_at: NOW, confirmed_target: 'transaction', transaction_id: 'txn_1', confirmed_at: NOW });
    insertDocument(db, { id: 'doc_2', storage_key: 'cmp_1/doc_2.pdf', status: 'ready', processed_at: NOW, confirmed_target: 'invoice', invoice_id: 'inv_1', confirmed_at: NOW });
    assert.equal(db.getValue('SELECT count(*) FROM documents'), 2);
  });
});

test('migration 005 constrains document state, links and extraction history', () => {
  withPhase4Database((db) => {
    const rejected = [
      { mime_type: 'application/x-msdownload' },
      { status: 'done' },
      { size_bytes: 0 },
      { status: 'failed' },
      { failure_code: 'timeout' },
      { status: 'failed', failure_code: 'made_up', failure_message: 'x' },
      { confirmed_target: 'transaction' },
      { confirmed_target: 'invoice', transaction_id: 'txn_1', confirmed_at: NOW },
      { confirmed_target: 'transaction', transaction_id: 'txn_2', confirmed_at: NOW },
      { confirmed_target: 'invoice', invoice_id: 'inv_2', confirmed_at: NOW },
      { company_id: 'cmp_missing' },
    ];
    for (const overrides of rejected) {
      assert.throws(() => insertDocument(db, overrides), undefined, JSON.stringify(overrides));
    }
    assert.equal(db.getValue('SELECT count(*) FROM documents'), 0);

    insertDocument(db);
    assert.throws(() => insertDocument(db, { id: 'doc_2' }), /UNIQUE/, 'storage keys are unique');
    const extraction = (attempt, extra = {}) => db.run(
      `INSERT INTO document_extractions (id, company_id, document_id, attempt, method, provider, outcome, fields, failure_code, created_at)
       VALUES (?, 'cmp_1', 'doc_1', ?, ?, ?, ?, ?, ?, ?)`,
      Object.values({ id: `dex_${attempt}`, attempt, method: 'ai', provider: 'p', outcome: 'succeeded', fields: '{}', failure_code: null, created_at: NOW, ...extra }),
    );
    extraction(1);
    assert.throws(() => extraction(1, { id: 'dex_x' }), /UNIQUE/, 'one row per attempt');
    assert.throws(() => db.run(
      `INSERT INTO document_extractions (id, company_id, document_id, attempt, method, provider, outcome, fields, failure_code, created_at)
       VALUES ('dex_c', 'cmp_2', 'doc_1', 2, 'ai', 'p', 'succeeded', '{}', NULL, ?)`, [NOW],
    ), undefined, 'an extraction cannot point at another company\'s document');

    db.run(`DELETE FROM documents WHERE id = 'doc_1'`);
    assert.equal(db.getValue('SELECT count(*) FROM document_extractions'), 0, 'history goes with its document');
  });
});

test('deleting a linked transaction or invoice clears the document link instead of blocking', () => {
  withPhase4Database((db) => {
    insertDocument(db, { status: 'ready', processed_at: NOW, confirmed_target: 'transaction', transaction_id: 'txn_1', confirmed_at: NOW });
    db.run(`DELETE FROM transactions WHERE id = 'txn_1'`);
    assert.deepEqual(db.get(`SELECT confirmed_target, transaction_id FROM documents`), { confirmed_target: 'transaction', transaction_id: null });
  });
});

test('deleting a company removes its documents and extraction history', () => {
  withPhase4Database((db) => {
    insertDocument(db);
    db.run(`INSERT INTO document_extractions (id, company_id, document_id, attempt, method, provider, outcome, fields, failure_code, created_at)
            VALUES ('dex_1', 'cmp_1', 'doc_1', 1, 'unavailable', NULL, 'failed', NULL, 'ai_unavailable', ?)`, [NOW]);
    db.run(`DELETE FROM companies WHERE id = 'cmp_1'`);
    assert.equal(db.getValue('SELECT count(*) FROM documents'), 0);
    assert.equal(db.getValue('SELECT count(*) FROM document_extractions'), 0);
  });
});
