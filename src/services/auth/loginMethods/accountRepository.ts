type AccountRow = {
  providerId: string;
  createdAt: string;
};

export async function listUserAccounts(db: D1Database, userId: string): Promise<AccountRow[]> {
  const result = await db
    .prepare(
      `SELECT providerId, createdAt
       FROM auth_accounts
       WHERE userId = ?1
       ORDER BY createdAt ASC, providerId ASC`,
    )
    .bind(userId)
    .all<AccountRow>();
  return result.results ?? [];
}

export async function findUserProviderAccounts(
  db: D1Database,
  userId: string,
  providerId: string,
): Promise<Array<{ id: string }>> {
  const result = await db
    .prepare("SELECT id FROM auth_accounts WHERE userId = ?1 AND providerId = ?2 LIMIT 2")
    .bind(userId, providerId)
    .all<{ id: string }>();
  return result.results ?? [];
}
