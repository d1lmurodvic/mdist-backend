-- 006: Intelligence and engagement (PRODUCT_REQUIREMENTS.md #17–#26).
--
-- Insights, anomalies and forecasts are stored results of deterministic
-- calculations over the ledger (ARCHITECTURE.md §7.4: derived records are
-- recomputable caches). They hold no money of their own that any report
-- reads back: every statement is still computed by the financial engine.
-- Notifications, assistant messages, accountant requests and user
-- preferences are ordinary tenant (or user) records.

-- ---------------------------------------------------------------------------
-- Insight: one finding for one period. `key` identifies the finding within
-- the period, so regenerating unchanged data updates rows instead of piling
-- up duplicates, and a dismissal survives regeneration.
-- ---------------------------------------------------------------------------
CREATE TABLE insights (
  id           TEXT    PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  period_start TEXT    NOT NULL,
  period_end   TEXT    NOT NULL,
  key          TEXT    NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  type         TEXT    NOT NULL CHECK (type IN (
                 'revenue_change', 'expense_increase', 'category_concentration', 'margin_movement',
                 'overdue_receivables', 'declining_cash', 'forecast_shortfall')),
  severity     TEXT    NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high')),
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  method       TEXT    NOT NULL CHECK (method IN ('rule', 'statistics', 'ai')),
  confidence   REAL    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  figures      TEXT    NOT NULL,
  evidence     TEXT    NOT NULL,
  dismissed_at TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  CHECK (period_start < period_end),
  UNIQUE (company_id, period_start, period_end, key)
);

-- ---------------------------------------------------------------------------
-- Anomaly: a review item for one transaction and one rule. Detection is
-- idempotent (one row per transaction and rule) and never changes the
-- transaction. The related transaction (a suspected duplicate) is resolved
-- at read time, so deleting it never blocks anything.
-- ---------------------------------------------------------------------------
CREATE TABLE anomalies (
  id                     TEXT    PRIMARY KEY,
  company_id             TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  transaction_id         TEXT    NOT NULL,
  related_transaction_id TEXT,
  rule_id                TEXT    NOT NULL CHECK (rule_id IN ('amount_outlier', 'first_time_payee', 'possible_duplicate', 'large_expense')),
  severity               TEXT    NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  score                  REAL    NOT NULL,
  explanation            TEXT    NOT NULL,
  comparison             TEXT    NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'false_positive', 'confirmed')),
  note                   TEXT    CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  detected_at            TEXT    NOT NULL,
  resolved_at            TEXT,
  updated_at             TEXT    NOT NULL,
  UNIQUE (company_id, transaction_id, rule_id),
  FOREIGN KEY (company_id, transaction_id) REFERENCES transactions (company_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_anomalies_company_status ON anomalies (company_id, status);

-- ---------------------------------------------------------------------------
-- Forecast: a stored projection with its assumptions (JSON).
-- ---------------------------------------------------------------------------
CREATE TABLE forecasts (
  id           TEXT    PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  as_of        TEXT    NOT NULL,
  horizon_days INTEGER NOT NULL CHECK (horizon_days IN (30, 60, 90)),
  method       TEXT    NOT NULL CHECK (method IN ('deterministic')),
  result       TEXT    NOT NULL,
  created_at   TEXT    NOT NULL
);

CREATE INDEX idx_forecasts_company_created ON forecasts (company_id, created_at);

-- ---------------------------------------------------------------------------
-- Notification: per recipient. `dedupe_key` makes each real event notify a
-- user at most once; a dismissed notification is kept (dismissed_at) so the
-- same event does not reappear.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id           TEXT    PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK (type IN (
                 'anomaly_detected', 'anomaly_confirmed', 'forecast_below_zero', 'invoice_overdue',
                 'invoice_paid', 'document_processed')),
  severity     TEXT    NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  entity_type  TEXT    NOT NULL CHECK (entity_type IN ('anomaly', 'forecast', 'invoice', 'document')),
  entity_id    TEXT    NOT NULL,
  dedupe_key   TEXT    NOT NULL,
  read_at      TEXT,
  dismissed_at TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE (user_id, company_id, dedupe_key)
);

CREATE INDEX idx_notifications_user ON notifications (company_id, user_id, read_at);

-- ---------------------------------------------------------------------------
-- User preferences: which notification types are enabled (JSON).
-- ---------------------------------------------------------------------------
CREATE TABLE user_preferences (
  user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  notifications TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Assistant conversation, per user and company.
-- ---------------------------------------------------------------------------
CREATE TABLE assistant_messages (
  id         TEXT    PRIMARY KEY,
  company_id TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT    NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  details    TEXT,
  created_at TEXT    NOT NULL
);

CREATE INDEX idx_assistant_messages_user ON assistant_messages (company_id, user_id, created_at);

-- ---------------------------------------------------------------------------
-- Accountant request: lead capture only (PRODUCT_REQUIREMENTS.md #23).
-- ---------------------------------------------------------------------------
CREATE TABLE accountant_requests (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  created_by    TEXT    REFERENCES users (id) ON DELETE SET NULL,
  contact_name  TEXT    NOT NULL CHECK (length(contact_name) BETWEEN 1 AND 200),
  contact_email TEXT    NOT NULL CHECK (length(contact_email) BETWEEN 3 AND 254),
  contact_phone TEXT    CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 1 AND 50),
  topic         TEXT    NOT NULL CHECK (topic IN ('bookkeeping', 'tax_preparation', 'financial_statements', 'advisory', 'other')),
  description   TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  period_start  TEXT,
  period_end    TEXT,
  share_summary INTEGER NOT NULL DEFAULT 0 CHECK (share_summary IN (0, 1)),
  status        TEXT    NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_contact', 'closed')),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  CHECK ((period_start IS NULL) = (period_end IS NULL)),
  CHECK (period_start IS NULL OR period_start < period_end)
);

CREATE INDEX idx_accountant_requests_company ON accountant_requests (company_id, created_at);
