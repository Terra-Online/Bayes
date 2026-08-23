export interface UserRegistrationReport {
  generatedAt: string;
  totalUsers: number;
  firstRegistrationDate: string | null;
  lastRegistrationDate: string | null;
  daily: Array<{ date: string; count: number }>;
  sources: Array<{ source: string; count: number }>;
}

type CountValue = number | string | null | undefined;

function toCount(value: CountValue): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export async function getUserRegistrationReport(db: D1Database): Promise<UserRegistrationReport> {
  const [summary, dailyRows, sourceRows] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS total_users,
           MIN(date(created_at)) AS first_registration_date,
           MAX(date(created_at)) AS last_registration_date
         FROM users`,
      )
      .first<{
        total_users: CountValue;
        first_registration_date: string | null;
        last_registration_date: string | null;
      }>(),
    db
      .prepare(
        `SELECT date(created_at) AS registration_date, COUNT(*) AS count
         FROM users
         WHERE date(created_at) IS NOT NULL
         GROUP BY date(created_at)
         ORDER BY registration_date ASC`,
      )
      .all<{ registration_date: string; count: CountValue }>(),
    db
      .prepare(
        `WITH ranked_accounts AS (
           SELECT
             userId,
             providerId,
             ROW_NUMBER() OVER (
               PARTITION BY userId
               ORDER BY datetime(createdAt) ASC, id ASC
             ) AS account_rank
           FROM auth_accounts
         ),
         primary_accounts AS (
           SELECT userId, providerId
           FROM ranked_accounts
           WHERE account_rank = 1
         )
         SELECT
           COALESCE(NULLIF(TRIM(primary_accounts.providerId), ''), 'unknown') AS source,
           COUNT(*) AS count
         FROM users
         LEFT JOIN primary_accounts ON primary_accounts.userId = users.uid
         GROUP BY COALESCE(NULLIF(TRIM(primary_accounts.providerId), ''), 'unknown')
         ORDER BY count DESC, source ASC`,
      )
      .all<{ source: string; count: CountValue }>(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    totalUsers: toCount(summary?.total_users),
    firstRegistrationDate: summary?.first_registration_date ?? null,
    lastRegistrationDate: summary?.last_registration_date ?? null,
    daily: (dailyRows.results ?? []).map((row) => ({
      date: String(row.registration_date),
      count: toCount(row.count),
    })),
    sources: (sourceRows.results ?? []).map((row) => ({
      source: String(row.source),
      count: toCount(row.count),
    })),
  };
}
