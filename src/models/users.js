/**
 * users: global (not tenant-owned) identities.
 * Emails are stored in canonical form only (migration 002).
 */

const COLUMNS = 'id, email, password_hash, name, status, created_at, updated_at';

function toUser(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findUserByEmail(db, email) {
  return toUser(db.get(`SELECT ${COLUMNS} FROM users WHERE email = ?`, [email]));
}

export function findUserById(db, id) {
  return toUser(db.get(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]));
}

export function insertUser(db, { id, email, passwordHash, name, now }) {
  db.run(
    `INSERT INTO users (id, email, password_hash, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [id, email, passwordHash, name, now, now],
  );
  return findUserById(db, id);
}
