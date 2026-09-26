-- 005: Documents and the AI invoice/receipt reader (PRODUCT_REQUIREMENTS.md #10).
--
-- A document is an uploaded file (image or PDF) stored on the local
-- filesystem under a server-generated key; the database holds metadata only.
-- Each extraction attempt is its own row, so re-running extraction keeps the
-- history instead of overwriting it. Confirmation links the document to the
-- transaction or invoice created from it; the link lives on the document, so
-- the frozen ledger and invoice tables are unchanged.

-- ---------------------------------------------------------------------------
-- Document: status is processing | ready | failed. A failed document carries
-- a failure code; a confirmed one records what was created from it.
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id                TEXT    PRIMARY KEY,
  company_id        TEXT    NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  original_filename TEXT    CHECK (original_filename IS NULL OR length(original_filename) BETWEEN 1 AND 255),
  storage_key       TEXT    NOT NULL UNIQUE,
  mime_type         TEXT    NOT NULL CHECK (mime_type IN (
                      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf')),
  size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
  status            TEXT    NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  failure_code      TEXT    CHECK (failure_code IS NULL OR failure_code IN (
                      'ai_unavailable', 'provider_error', 'invalid_provider_response', 'unreadable', 'timeout',
                      'interrupted', 'internal_error')),
  failure_message   TEXT    CHECK (failure_message IS NULL OR length(failure_message) BETWEEN 1 AND 500),
  confirmed_target  TEXT    CHECK (confirmed_target IS NULL OR confirmed_target IN ('transaction', 'invoice')),
  -- SET NULL: deleting the created transaction or draft invoice (allowed by
  -- Phases 3–4) must not be blocked by the document that produced it.
  transaction_id    TEXT    REFERENCES transactions (id) ON DELETE SET NULL,
  invoice_id        TEXT    REFERENCES invoices (id) ON DELETE SET NULL,
  confirmed_at      TEXT,
  processed_at      TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  UNIQUE (company_id, id),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK ((failure_code IS NULL) = (failure_message IS NULL)),
  CHECK ((confirmed_at IS NULL) = (confirmed_target IS NULL)),
  CHECK (confirmed_target = 'transaction' OR transaction_id IS NULL),
  CHECK (confirmed_target = 'invoice' OR invoice_id IS NULL)
);

CREATE INDEX idx_documents_company_created ON documents (company_id, created_at);
CREATE INDEX idx_documents_company_status ON documents (company_id, status);
CREATE UNIQUE INDEX uq_documents_transaction ON documents (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX uq_documents_invoice ON documents (invoice_id) WHERE invoice_id IS NOT NULL;

-- A document may only point at a transaction or invoice of its own company.
-- (Single-column foreign keys are needed for ON DELETE SET NULL, so the tenant
-- rule is enforced here instead of by a composite key.)
CREATE TRIGGER documents_links_same_company_insert
BEFORE INSERT ON documents
FOR EACH ROW
WHEN (NEW.transaction_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM transactions t WHERE t.id = NEW.transaction_id AND t.company_id = NEW.company_id))
  OR (NEW.invoice_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id AND i.company_id = NEW.company_id))
BEGIN
  SELECT RAISE(ABORT, 'document links must stay within the company');
END;

CREATE TRIGGER documents_links_same_company_update
BEFORE UPDATE OF transaction_id, invoice_id, company_id ON documents
FOR EACH ROW
WHEN (NEW.transaction_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM transactions t WHERE t.id = NEW.transaction_id AND t.company_id = NEW.company_id))
  OR (NEW.invoice_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id AND i.company_id = NEW.company_id))
BEGIN
  SELECT RAISE(ABORT, 'document links must stay within the company');
END;

-- ---------------------------------------------------------------------------
-- DocumentExtraction: one row per attempt. method 'ai' when a provider read
-- the document, 'unavailable' when none could. fields holds the validated,
-- normalised extraction (JSON) only for a successful attempt — never
-- invented values.
-- ---------------------------------------------------------------------------
CREATE TABLE document_extractions (
  id           TEXT    PRIMARY KEY,
  company_id   TEXT    NOT NULL,
  document_id  TEXT    NOT NULL,
  attempt      INTEGER NOT NULL CHECK (attempt >= 1),
  method       TEXT    NOT NULL CHECK (method IN ('ai', 'unavailable')),
  provider     TEXT    CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 100),
  outcome      TEXT    NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  fields       TEXT,
  failure_code TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE (document_id, attempt),
  CHECK ((outcome = 'succeeded') = (fields IS NOT NULL)),
  CHECK ((outcome = 'failed') = (failure_code IS NOT NULL)),
  CHECK (method = 'ai' OR outcome = 'failed'),
  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id) ON DELETE CASCADE
);
