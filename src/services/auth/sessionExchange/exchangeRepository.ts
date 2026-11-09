const CODE_PREFIX = "auth-session-exchange:";

export type StoredExchange = {
  value: string;
  expiresAt: string;
};

export async function storeExchange(
  db: D1Database,
  code: string,
  value: { token: string; origin: string; challenge: string },
  expiresAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_verifications (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(crypto.randomUUID(), `${CODE_PREFIX}${code}`, JSON.stringify(value), expiresAt)
    .run();
}

export function findExchange(db: D1Database, code: string): Promise<StoredExchange | null> {
  return db
    .prepare("SELECT value, expiresAt FROM auth_verifications WHERE identifier = ?1 LIMIT 1")
    .bind(`${CODE_PREFIX}${code}`)
    .first<StoredExchange>();
}

export async function consumeExchange(
  db: D1Database,
  code: string,
  storedValue: string,
): Promise<boolean> {
  // Comparing the stored value makes consumption conditional on the record we verified.
  const consumed = await db
    .prepare("DELETE FROM auth_verifications WHERE identifier = ?1 AND value = ?2 RETURNING id")
    .bind(`${CODE_PREFIX}${code}`, storedValue)
    .first<{ id: string }>();
  return consumed !== null;
}
