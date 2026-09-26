/**
 * Migration 006 against an existing Phase 5 database, and its constraints.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db/connection.js';
import { migrate, migrationsDir } from '../src/db/migrate.js';

const PHASE_5 = ['001_auth_and_tenancy.sql', '002_users_email_canonical.sql', '003_financial_core.sql', '004_invoice_management.sql', '005_documents.sql'];
const TABLES = ['companies', 'users', 'memberships', 'accounts', 'categories', 'transactions', 'contacts', 'invoices', 'documents', 'document_extractions'];

function seed(db) {
  db.run("INSERT INTO users (id, email, password_hash, name, status, created_at, updated_at) VALUES ('usr_1', 'a@a.example', 'h', 'A', 'active', 'x', 'x')");
  db.run("INSERT INTO companies (id, name, currency, fiscal_year_start_month, timezone, is_demo, created_at, updated_at) VALUES ('cmp_1','A','UZS',1,'UTC',0,'x','x')");
  db.run("INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES ('mem_1', 'usr_1', 'cmp_1', 'owner', 'x')");
  db.run("INSERT INTO categories (id, company_id, name, type, is_system, created_at, updated_at) VALUES ('cat_1', 'cmp_1', 'Uncategorized', NULL, 1, 'x', 'x')");
  db.run("INSERT INTO accounts (id, company_id, name, type, currency, created_at, updated_at) VALUES ('acc_1', 'cmp_1', 'Bank', 'bank', 'UZS', 'x', 'x')");
  db.run(`INSERT INTO transactions (id, company_id, type, amount_minor, currency, date, account_id, category_id, category_source, review_status, source, created_at, updated_at)
          VALUES ('txn_1', 'cmp_1', 'expense', 700, 'UZS', '2025-03-01', 'acc_1', 'cat_1', 'fallback', 'needs_review', 'document', 'x', 'x')`);
  db.run(`INSERT INTO documents (id, company_id, original_filename, storage_key, mime_type, size_bytes, status, failure_code, failure_message,
            confirmed_target, transaction_id, invoice_id, confirmed_at, processed_at, created_at, updated_at)
          VALUES ('doc_1', 'cmp_1', 'r.pdf', 'cmp_1/doc_1.pdf', 'application/pdf', 10, 'failed', 'ai_unavailable', 'No provider.',
            'transaction', 'txn_1', NULL, 'x', 'x', 'x', 'x')`);
  db.run(`INSERT INTO document_extractions (id, company_id, document_id, attempt, method, provider, outcome, fields, failure_code, created_at)
          VALUES ('dex_1', 'cmp_1', 'doc_1', 1, 'unavailable', NULL, 'failed', NULL, 'ai_unavailable', 'x')`);
}

test('migration 006 upgrades a Phase 5 database with every existing row intact, and constrains its tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ifrsmart-migrations-'));
  const db = Database.open({ path: ':memory:', allowMemory: true });
  try {
    for (const file of PHASE_5) fs.copyFileSync(path.join(migrationsDir, file), path.join(dir, file));
    migrate(db, { dir });
    seed(db);
    const snapshot = () => Object.fromEntries(TABLES.map((table) => [table, db.all(`SELECT * FROM ${table} ORDER BY id`)]));
    const before = snapshot();
    fs.copyFileSync(path.join(migrationsDir, '006_intelligence_and_engagement.sql'), path.join(dir, '006_intelligence_and_engagement.sql'));
    assert.deepEqual(migrate(db, { dir }).applied.map((m) => m.version), ['006']);
    assert.deepEqual(snapshot(), before, 'Phase 1–5 rows are untouched');

    const anomaly = (id, extra = '') => db.run(
      `INSERT INTO anomalies (id, company_id, transaction_id, rule_id, severity, score, explanation, comparison, detected_at, updated_at${extra ? ', status' : ''})
       VALUES (?, 'cmp_1', 'txn_1', 'large_expense', 'low', 1, 'x', '{}', 'x', 'x'${extra ? `, '${extra}'` : ''})`, [id],
    );
    anomaly('anm_1');
    assert.throws(() => anomaly('anm_2'), /UNIQUE/, 'one flag per transaction and rule');
    assert.throws(() => db.run("UPDATE anomalies SET status = 'deleted'"), /CHECK/);
    const notify = (id) => db.run(
      `INSERT INTO notifications (id, company_id, user_id, type, severity, title, body, entity_type, entity_id, dedupe_key, created_at)
       VALUES (?, 'cmp_1', 'usr_1', 'invoice_paid', 'info', 't', 'b', 'invoice', 'inv_1', 'invoice_paid:inv_1', 'x')`, [id],
    );
    notify('ntf_1');
    assert.throws(() => notify('ntf_2'), /UNIQUE/, 'one notification per user and event');
    assert.throws(() => db.run(`INSERT INTO forecasts (id, company_id, as_of, horizon_days, method, result, created_at) VALUES ('f', 'cmp_1', 'x', 45, 'deterministic', '{}', 'x')`), /CHECK/);
    assert.throws(() => db.run(`INSERT INTO accountant_requests (id, company_id, contact_name, contact_email, topic, description, period_start, created_at, updated_at)
      VALUES ('a', 'cmp_1', 'n', 'n@a.example', 'other', 'd', '2025-01-01', 'x', 'x')`), /CHECK/, 'a period needs both ends');

    db.run("DELETE FROM documents WHERE id = 'doc_1'");
    db.run("DELETE FROM transactions WHERE id = 'txn_1'");
    assert.equal(db.getValue('SELECT count(*) FROM anomalies'), 0, 'a flag goes with its transaction');
    db.run("DELETE FROM companies WHERE id = 'cmp_1'");
    for (const table of ['notifications', 'insights', 'forecasts', 'assistant_messages', 'accountant_requests']) {
      assert.equal(db.getValue(`SELECT count(*) FROM ${table}`), 0, table);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
