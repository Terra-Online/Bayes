PRAGMA foreign_keys = ON;

DELETE FROM auth_verifications
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY identifier
        ORDER BY datetime(createdAt) DESC, id DESC
      ) AS row_num
    FROM auth_verifications
  ) dedup
  WHERE dedup.row_num > 1
);

DROP INDEX IF EXISTS idx_auth_verifications_identifier;
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_verifications_identifier ON auth_verifications(identifier);
