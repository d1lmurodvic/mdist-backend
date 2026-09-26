-- 001: Authentication and tenancy foundation.
--
-- Only User, Session, Company and Membership live here: the identity and tenant
-- boundary every later table depends on. Financial tables arrive in their own
-- migrations alongside the services that exercise them.
--
-- Conventions:
--   * snake_case column and table names; entity names in ARCHITECTURE.md map
--     to these tables in the models layer.
--   * Timestamps are ISO 8601 UTC strings.
--   * Booleans are INTEGER 0/1 with a CHECK constraint.
--   * Money is INTEGER minor units plus an explicit currency (money.js).

-- ---------------------------------------------------------------------------
-- User: a human identity. Global, not tenant-owned (ARCHITECTURE.md §7.1).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT    PRIMARY KEY,
  -- Stored lower-cased and trimmed: email uniqueness is global because an
  -- account represents a person, and case must not create a second account.
  email         TEXT    NOT NULL UNIQUE
                CHECK (length(email) >= 3 AND length(email) <= 254),
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL CHECK (length(name) >= 1 AND length(name) <= 200),
  status        TEXT    NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'disabled')),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Company: the tenant root and its configuration.
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id                     TEXT    PRIMARY KEY,
  name                   TEXT    NOT NULL CHECK (length(name) >= 1 AND length(name) <= 200),
  industry               TEXT,
  size                   TEXT,
  -- One currency per company for the MVP; no conversion (locked decision).
  currency               TEXT    NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1
                           CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  timezone               TEXT    NOT NULL DEFAULT 'UTC',
  is_demo                INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  onboarded_at           TEXT,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

-- Demo companies are the demo dataset; at most one is ever created per seed.
CREATE INDEX idx_companies_is_demo ON companies (is_demo);

-- ---------------------------------------------------------------------------
-- Membership: user <-> company access with a role.
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  -- One company per user in the MVP, but the constraint does not forbid a
  -- second membership later (ARCHITECTURE.md §7.1).
  UNIQUE (user_id, company_id)
);

-- The company-scoped lookup that every authenticated request performs.
CREATE INDEX idx_memberships_company ON memberships (company_id);
CREATE INDEX idx_memberships_user ON memberships (user_id);

-- ---------------------------------------------------------------------------
-- Session: opaque server-side authentication.
--
-- Only the SHA-256 hash of the token is stored, so a database leak does not
-- yield usable session tokens. Sessions are revocable and expire.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  -- Only used when SESSION_BIND_IP is enabled; off by default because it
  -- breaks legitimate use across mobile and office networks.
  bound_ip     TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
