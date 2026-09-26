-- 004: Invoice management — contacts, invoices, line items, idempotency keys.
--
-- Conventions as in 001/003: money is INTEGER minor units within ±(2^53 − 1)
-- (UZS exponent 0, D9); dates are 'YYYY-MM-DD'; every cross-table reference
-- carries company_id and targets UNIQUE (company_id, id), so the database
-- itself refuses a link to another tenant's contact, invoice or transaction.

-- Paid invoices point at their payment transaction by (company_id, id).
CREATE UNIQUE INDEX uq_transactions_company_id ON transactions (company_id, id);

-- ---------------------------------------------------------------------------
-- Contact: a customer or vendor of the company (ARCHITECTURE.md §7.3).
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type       TEXT NOT NULL CHECK (type IN ('customer', 'vendor')),
  email      TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  phone      TEXT CHECK (phone IS NULL OR length(phone) BETWEEN 1 AND 50),
  address    TEXT CHECK (address IS NULL OR length(address) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id)
);

CREATE INDEX idx_contacts_company_name ON contacts (company_id, name COLLATE NOCASE);

-- ---------------------------------------------------------------------------
-- Invoice: a receivable (owed to the company) or payable (owed by it).
-- The stored status is draft | sent | paid | cancelled; "overdue" is derived
-- (sent and past its due date) and never stored. Totals are computed by the
-- server from the line items; the database checks total = subtotal + tax and
-- that an invoice is paid exactly when it has a payment transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id                  TEXT    PRIMARY KEY,
  company_id          TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  number              TEXT    NOT NULL CHECK (length(number) BETWEEN 1 AND 50),
  type                TEXT    NOT NULL CHECK (type IN ('receivable', 'payable')),
  contact_id          TEXT    NOT NULL,
  status              TEXT    NOT NULL CHECK (status IN ('draft', 'sent', 'paid', 'cancelled')),
  currency            TEXT    NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  issue_date          TEXT    NOT NULL CHECK (issue_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  due_date            TEXT    NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  subtotal_minor      INTEGER NOT NULL CHECK (subtotal_minor BETWEEN 1 AND 9007199254740991),
  tax_minor           INTEGER NOT NULL CHECK (tax_minor BETWEEN 0 AND 9007199254740991),
  total_minor         INTEGER NOT NULL CHECK (total_minor BETWEEN 1 AND 9007199254740991),
  notes               TEXT    CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 2000),
  paid_transaction_id TEXT    UNIQUE,
  sent_at             TEXT,
  cancelled_at        TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  UNIQUE (company_id, id),
  CHECK (due_date >= issue_date),
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK ((status = 'paid') = (paid_transaction_id IS NOT NULL)),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  -- NO ACTION: a payment transaction cannot be deleted while an invoice points at it.
  FOREIGN KEY (company_id, paid_transaction_id) REFERENCES transactions (company_id, id)
);

CREATE UNIQUE INDEX uq_invoices_company_number ON invoices (company_id, number COLLATE NOCASE);
CREATE INDEX idx_invoices_company_status_due ON invoices (company_id, status, due_date);
CREATE INDEX idx_invoices_company_issue ON invoices (company_id, issue_date);
CREATE INDEX idx_invoices_company_contact ON invoices (company_id, contact_id);

-- ---------------------------------------------------------------------------
-- InvoiceLineItem: reachable only through its company-owned invoice.
-- quantity is a whole number; tax_rate_bp is basis points (1200 = 12%).
-- line_total_minor = quantity × unit price (net); tax_minor is the line's tax.
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_line_items (
  id               TEXT    PRIMARY KEY,
  company_id       TEXT    NOT NULL,
  invoice_id       TEXT    NOT NULL,
  position         INTEGER NOT NULL CHECK (position BETWEEN 1 AND 200),
  description      TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  quantity         INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor BETWEEN 1 AND 9007199254740991),
  tax_rate_bp      INTEGER NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor BETWEEN 1 AND 9007199254740991),
  tax_minor        INTEGER NOT NULL CHECK (tax_minor BETWEEN 0 AND 9007199254740991),
  UNIQUE (invoice_id, position),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices (company_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Idempotency keys (API_CONTRACT.md §2): the stored outcome of a successful
-- request, replayed when the same key is sent again for the same request.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  company_id      TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  key             TEXT    NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  scope           TEXT    NOT NULL CHECK (scope IN ('invoice_payment')),
  request_hash    TEXT    NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  PRIMARY KEY (company_id, key)
);
