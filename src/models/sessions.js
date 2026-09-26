/**
 * sessions: opaque server-side sessions. Only the SHA-256 hash of a token is
 * stored or queried; the token itself never reaches this layer.
 *
 * Timestamps are ISO 8601 UTC strings of fixed width, so they compare
 * correctly as text.
 */

function toSession(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    boundIp: row.bound_ip,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export function insertSession(db, { id, userId, tokenHash, expiresAt, boundIp, now }) {
  db.run(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at, bound_ip, last_used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    [id, userId, tokenHash, expiresAt, boundIp, now, now],
  );
}

/** A session that exists, is not revoked and has not expired at `now`. */
export function findActiveSessionByTokenHash(db, tokenHash, now) {
  return toSession(
    db.get(
      `SELECT id, user_id, expires_at, revoked_at, bound_ip, last_used_at, created_at
       FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      [tokenHash, now],
    ),
  );
}

/** Revoke by token hash. Returns true if an active session was revoked. */
export function revokeSessionByTokenHash(db, tokenHash, now) {
  return db.run(
    'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    [now, tokenHash],
  ).changes > 0;
}

export function touchSession(db, id, now) {
  db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', [now, id]);
}

/** Housekeeping: expired sessions can never authenticate again. */
export function deleteExpiredSessions(db, now) {
  return db.run('DELETE FROM sessions WHERE expires_at <= ?', [now]).changes;
}
