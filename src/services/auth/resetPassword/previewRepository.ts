export function findResetVerification(db: D1Database, token: string) {
  // Better Auth stores reset tokens with this identifier prefix.
  return db
    .prepare("SELECT value, expiresAt FROM auth_verifications WHERE identifier = ?1 LIMIT 1")
    .bind(`reset-password:${token}`)
    .first<{ value: string; expiresAt: string }>();
}

export function findResetUserEmail(db: D1Database, userId: string) {
  return db
    .prepare("SELECT email FROM auth_users WHERE id = ?1 LIMIT 1")
    .bind(userId)
    .first<{ email: string }>();
}
