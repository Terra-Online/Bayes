PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_uid_sequence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

WITH seed AS (
  SELECT
    CASE
      WHEN MAX(uid_number) IS NOT NULL AND MAX(uid_number) > 100000 THEN MAX(uid_number) - 100000
      ELSE 0
    END AS seq_seed
  FROM users
)
INSERT INTO user_uid_sequence (id, created_at)
SELECT seq_seed, CURRENT_TIMESTAMP
FROM seed
WHERE seq_seed > 0
  AND NOT EXISTS (SELECT 1 FROM user_uid_sequence LIMIT 1);
