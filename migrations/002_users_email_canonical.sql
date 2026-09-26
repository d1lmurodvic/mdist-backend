-- 002: Email identity is case-insensitive.
--
-- An email identifies one person regardless of letter case, so the only stored
-- form is the canonical one: trimmed and lower-cased (normalizeEmail() in
-- src/lib/validate.js). The triggers below make the database refuse any other
-- form, which makes the UNIQUE(email) constraint from migration 001
-- case-insensitive: 'Owner@Example.com' can never sit beside
-- 'owner@example.com' (DEVELOPMENT_RULES.md §5.7).
--
-- SQLite's lower() and trim() handle ASCII only. The API boundary accepts ASCII
-- email addresses only (emailSchema), so the two layers agree.

-- Bring rows written before this migration to the canonical form first. If two
-- existing rows differ only by case, the UNIQUE constraint fails and the whole
-- migration rolls back instead of silently merging two accounts.
UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));

CREATE TRIGGER users_email_canonical_insert
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.email <> lower(trim(NEW.email))
BEGIN
  SELECT RAISE(ABORT, 'users.email must be trimmed and lower-cased');
END;

CREATE TRIGGER users_email_canonical_update
BEFORE UPDATE OF email ON users
FOR EACH ROW
WHEN NEW.email <> lower(trim(NEW.email))
BEGIN
  SELECT RAISE(ABORT, 'users.email must be trimmed and lower-cased');
END;
