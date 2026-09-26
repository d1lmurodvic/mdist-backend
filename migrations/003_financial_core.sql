-- 003: Financial core — accounts, categories, category rules, transactions.
--
-- Conventions as in 001. Money is INTEGER minor units (money.js; UZS has
-- exponent 0, ARCHITECTURE.md D9) bounded to ±(2^53 − 1), the range that is
-- stored, read back and serialized exactly.
--
-- Tenant integrity is enforced by the database, not only by queries: every
-- cross-table reference carries company_id and targets UNIQUE (company_id, id),
-- so a transaction can never point at another company's account or category.

-- ---------------------------------------------------------------------------
-- Account: where money is held or owed (ARCHITECTURE.md §7.3). The opening
-- balance is explicit configuration, never a transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id                    TEXT    PRIMARY KEY,
  company_id            TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name                  TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  type                  TEXT    NOT NULL CHECK (type IN ('cash', 'bank', 'liability', 'equity')),
  currency              TEXT    NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  opening_balance_minor INTEGER NOT NULL DEFAULT 0
                        CHECK (opening_balance_minor BETWEEN -9007199254740991 AND 9007199254740991),
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  UNIQUE (company_id, id)
);

CREATE UNIQUE INDEX uq_accounts_company_name ON accounts (company_id, name COLLATE NOCASE);

-- ---------------------------------------------------------------------------
-- Category: two-level income/expense hierarchy (category -> subcategory).
-- Exactly one system category per company, "Uncategorized", has no type: it is
-- the fallback for both income and expense, so no transaction is ever
-- category-less or invisible in a report.
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id         TEXT    PRIMARY KEY,
  company_id TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  type       TEXT    CHECK (type IN ('income', 'expense')),
  parent_id  TEXT,
  is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  UNIQUE (company_id, id),
  CHECK ((is_system = 1 AND type IS NULL AND parent_id IS NULL) OR (is_system = 0 AND type IS NOT NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (company_id, parent_id) REFERENCES categories (company_id, id)
);

CREATE UNIQUE INDEX uq_categories_company_name ON categories (company_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX uq_categories_company_system ON categories (company_id) WHERE is_system = 1;
CREATE INDEX idx_categories_parent ON categories (company_id, parent_id);

-- Every existing company gets its Uncategorized category; new companies get it
-- when they are created (services/companies.js).
INSERT INTO categories (id, company_id, name, type, parent_id, is_system, created_at, updated_at)
SELECT 'cat_' || upper(hex(randomblob(13))), id, 'Uncategorized', NULL, NULL, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM companies;

-- ---------------------------------------------------------------------------
-- CategoryRule: deterministic, company-specific categorization.
--   source 'user'    — curated by an owner: exact or contains match.
--   source 'learned' — recorded from a user's category correction: exact
--                      counterparty match. "Learned" is not machine learning.
-- Patterns are stored normalised (trimmed, lower-case, single spaces).
-- ---------------------------------------------------------------------------
CREATE TABLE category_rules (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('user', 'learned')),
  match_type  TEXT NOT NULL CHECK (match_type IN ('exact', 'contains')),
  pattern     TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 200),
  category_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (source = 'user' OR match_type = 'exact'),
  UNIQUE (company_id, source, match_type, pattern),
  FOREIGN KEY (company_id, category_id) REFERENCES categories (company_id, id)
);

CREATE INDEX idx_category_rules_category ON category_rules (company_id, category_id);

-- ---------------------------------------------------------------------------
-- Transaction: the ledger — the only source of recorded monetary activity.
-- amount_minor is a positive magnitude; `type` gives the direction.
-- counterparty_key = normalised payee (or description when there is no payee):
-- the one key used by exact category rules and duplicate detection.
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id               TEXT    PRIMARY KEY,
  company_id       TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  type             TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  currency         TEXT    NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  date             TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  account_id       TEXT    NOT NULL,
  category_id      TEXT    NOT NULL,
  description      TEXT    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  payee            TEXT    CHECK (payee IS NULL OR length(payee) BETWEEN 1 AND 200),
  counterparty_key TEXT,
  payment_method   TEXT    CHECK (payment_method IS NULL OR length(payment_method) BETWEEN 1 AND 50),
  notes            TEXT    CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 2000),
  source           TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'document', 'ai')),
  category_source  TEXT    NOT NULL CHECK (category_source IN ('user', 'rule', 'learned', 'fallback')),
  category_rule_id TEXT    REFERENCES category_rules (id) ON DELETE SET NULL,
  review_status    TEXT    NOT NULL CHECK (review_status IN ('confirmed', 'needs_review')),
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  FOREIGN KEY (company_id, account_id) REFERENCES accounts (company_id, id),
  FOREIGN KEY (company_id, category_id) REFERENCES categories (company_id, id)
);

-- The access paths the product uses (ARCHITECTURE.md §7.5).
CREATE INDEX idx_transactions_company_date ON transactions (company_id, date);
CREATE INDEX idx_transactions_company_type_date ON transactions (company_id, type, date);
CREATE INDEX idx_transactions_company_category ON transactions (company_id, category_id);
CREATE INDEX idx_transactions_company_account_date ON transactions (company_id, account_id, date);
CREATE INDEX idx_transactions_duplicates ON transactions (company_id, counterparty_key, amount_minor, date);
