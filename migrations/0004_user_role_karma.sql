PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS users_v2 (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified TEXT NOT NULL DEFAULT 'false',
  role TEXT NOT NULL DEFAULT 'n' CHECK (role IN ('n', 'p', 'a', 's', 'r')),
  avt INTEGER NOT NULL DEFAULT 0,
  nickname TEXT NOT NULL UNIQUE,
  progress_version INTEGER NOT NULL DEFAULT 0,
  progress_marker TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  uid_number INTEGER,
  uid_suffix TEXT,
  nickname_customized INTEGER NOT NULL DEFAULT 0,
  karma INTEGER NOT NULL DEFAULT 0 CHECK (karma BETWEEN 0 AND 5)
);

WITH ranked AS (
  SELECT uid, ROW_NUMBER() OVER (ORDER BY created_at, uid) AS rn
  FROM users
)
INSERT INTO users_v2 (
  uid,
  email,
  password_hash,
  email_verified,
  role,
  avt,
  nickname,
  progress_version,
  progress_marker,
  points,
  created_at,
  last_active,
  uid_number,
  uid_suffix,
  nickname_customized,
  karma
)
SELECT
  uid,
  email,
  password_hash,
  COALESCE(email_verified, 'false'),
  CASE LOWER(TRIM(COALESCE(role, '')))
    WHEN 'n' THEN 'n'
    WHEN 'normal' THEN 'n'
    WHEN 'p' THEN 'p'
    WHEN 'pioneer' THEN 'p'
    WHEN 'moderator' THEN 'p'
    WHEN 'a' THEN 'a'
    WHEN 'admin' THEN 'a'
    WHEN 's' THEN 's'
    WHEN 'suspend' THEN 's'
    WHEN 'suspended' THEN 's'
    WHEN 'r' THEN 'r'
    WHEN 'robot' THEN 'r'
    ELSE 'n'
  END,
  COALESCE(avt, 0),
  nickname,
  COALESCE(progress_version, 0),
  COALESCE(progress_marker, ''),
  COALESCE(points, 0),
  COALESCE(created_at, CURRENT_TIMESTAMP),
  COALESCE(last_active, CURRENT_TIMESTAMP),
  COALESCE(
    uid_number,
    100000 + (SELECT rn FROM ranked WHERE ranked.uid = users.uid)
  ),
  CASE
    WHEN uid_suffix IS NULL OR TRIM(uid_suffix) = '' THEN 'AA'
    WHEN LENGTH(TRIM(uid_suffix)) = 1 THEN UPPER(TRIM(uid_suffix) || 'X')
    ELSE UPPER(SUBSTR(TRIM(uid_suffix), 1, 2))
  END,
  COALESCE(nickname_customized, 0),
  CASE
    WHEN COALESCE(points, 0) >= 1500 THEN 5
    WHEN COALESCE(points, 0) >= 800 THEN 4
    WHEN COALESCE(points, 0) >= 400 THEN 3
    WHEN COALESCE(points, 0) >= 200 THEN 2
    WHEN COALESCE(points, 0) >= 50 THEN 1
    ELSE 0
  END
FROM users;

DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid_number ON users(uid_number);

PRAGMA foreign_keys = ON;
