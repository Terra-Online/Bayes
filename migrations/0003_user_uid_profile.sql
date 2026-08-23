PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN uid_number INTEGER;
ALTER TABLE users ADD COLUMN uid_suffix TEXT;
ALTER TABLE users ADD COLUMN nickname_customized INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT uid, ROW_NUMBER() OVER (ORDER BY created_at, uid) AS rn
  FROM users
)
UPDATE users
SET uid_number = (
  SELECT 100000 + ranked.rn
  FROM ranked
  WHERE ranked.uid = users.uid
)
WHERE uid_number IS NULL;

UPDATE users
SET uid_suffix = CASE
  WHEN LENGTH(TRIM(nickname)) >= 2 THEN UPPER(SUBSTR(TRIM(nickname), LENGTH(TRIM(nickname)) - 1, 2))
  WHEN LENGTH(TRIM(nickname)) = 1 THEN UPPER(TRIM(nickname) || 'X')
  ELSE 'AA'
END
WHERE uid_suffix IS NULL OR uid_suffix = '';

UPDATE users
SET uid_suffix = UPPER(SUBSTR(uid_suffix, 1, 2))
WHERE uid_suffix IS NOT NULL;

UPDATE users
SET uid_suffix = uid_suffix || 'X'
WHERE LENGTH(uid_suffix) = 1;

UPDATE users
SET uid_suffix = 'AA'
WHERE uid_suffix IS NULL OR LENGTH(uid_suffix) = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid_number ON users(uid_number);
