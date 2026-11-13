-- Run as one D1 migration transaction. All validation precedes identity changes.
PRAGMA defer_foreign_keys = ON;

-- Normalize once and index the lookup: per-user LOWER/TRIM scans exceed D1's
-- CPU budget on populated installations even when every identity is consistent.
CREATE TABLE _user_merge_auth (id TEXT PRIMARY KEY, email TEXT NOT NULL);
INSERT INTO _user_merge_auth SELECT id, lower(trim(email)) FROM auth_users;
CREATE INDEX _user_merge_auth_email ON _user_merge_auth(email);
CREATE TABLE _user_merge_map (business_id TEXT PRIMARY KEY, auth_id TEXT NOT NULL UNIQUE);
INSERT INTO _user_merge_map
SELECT u.uid, COALESCE(by_id.id, by_email.id)
FROM users u
LEFT JOIN _user_merge_auth by_id ON by_id.id = u.uid
LEFT JOIN _user_merge_auth by_email ON by_email.id = (
  SELECT id FROM _user_merge_auth WHERE email = lower(trim(u.email)) LIMIT 1
)
WHERE by_id.id IS NOT NULL OR by_email.id IS NOT NULL;

CREATE TABLE _user_merge_check (
  orphan_count INTEGER CONSTRAINT BUSINESS_USER_WITHOUT_AUTH_USER CHECK (orphan_count = 0),
  email_collision_count INTEGER CONSTRAINT AMBIGUOUS_AUTH_EMAIL CHECK (email_collision_count = 0),
  identity_collision_count INTEGER CONSTRAINT CONFLICTING_USER_IDENTITIES CHECK (identity_collision_count = 0),
  invalid_uid_count INTEGER CONSTRAINT INVALID_PUBLIC_UID CHECK (invalid_uid_count = 0)
);
INSERT INTO _user_merge_check SELECT
  (SELECT COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM _user_merge_map m WHERE m.business_id = u.uid)),
  (SELECT COUNT(*) FROM (SELECT email FROM _user_merge_auth GROUP BY email HAVING COUNT(*) > 1)),
  (SELECT COUNT(*) FROM _user_merge_map m JOIN users u ON u.uid = m.auth_id WHERE u.uid <> m.business_id)
    + (SELECT COUNT(*) FROM users u JOIN _user_merge_auth a ON a.email = lower(trim(u.email))
       JOIN _user_merge_map m ON m.business_id = u.uid WHERE a.id <> m.auth_id),
  (SELECT COUNT(*) FROM users WHERE uid_number IS NULL OR uid_number <= 0 OR uid_suffix IS NULL OR length(uid_suffix) <> 2);

-- Renaming the referenced column also updates every existing business FK definition.
ALTER TABLE users RENAME COLUMN uid TO id;
-- Preserve first-confirmation eligibility. Existing suffixes stay untouched here;
-- only users with nickname_confirmed = 0 finalize them on their first profile save.
ALTER TABLE users RENAME COLUMN nickname_customized TO nickname_confirmed;
ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users DROP COLUMN email_verified;
ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;
ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE users SET id = (SELECT auth_id FROM _user_merge_map WHERE business_id = users.id)
WHERE id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);

UPDATE endfield_bindings SET uid = (SELECT auth_id FROM _user_merge_map WHERE business_id = endfield_bindings.uid)
WHERE uid IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE progress_sync_mutations SET uid = (SELECT auth_id FROM _user_merge_map WHERE business_id = progress_sync_mutations.uid)
WHERE uid IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE progress_stats_outbox SET uid = (SELECT auth_id FROM _user_merge_map WHERE business_id = progress_stats_outbox.uid)
WHERE uid IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE notification_counters SET user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = notification_counters.user_id)
WHERE user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE user_archive_progress SET uid = (SELECT auth_id FROM _user_merge_map WHERE business_id = user_archive_progress.uid)
WHERE uid IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE archive_progress_sync_mutations SET uid = (SELECT auth_id FROM _user_merge_map WHERE business_id = archive_progress_sync_mutations.uid)
WHERE uid IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE ugc_submissions SET deleted_by = (SELECT auth_id FROM _user_merge_map WHERE business_id = ugc_submissions.deleted_by)
WHERE deleted_by IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE ugc_submissions SET user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = ugc_submissions.user_id)
WHERE user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
-- Identity remapping changes the reference, not snapshot authorship or content.
-- Suspend the guard only within this migration transaction and restore it verbatim.
DROP TRIGGER prevent_ugc_snapshot_content_update;
UPDATE ugc_snapshots SET creator_user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = ugc_snapshots.creator_user_id)
WHERE creator_user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
CREATE TRIGGER prevent_ugc_snapshot_content_update
BEFORE UPDATE ON ugc_snapshots
WHEN NEW.id IS NOT OLD.id
  OR NEW.submission_id IS NOT OLD.submission_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.revision IS NOT OLD.revision
  OR NEW.content IS NOT OLD.content
  OR NEW.file_path IS NOT OLD.file_path
  OR NEW.mime_type IS NOT OLD.mime_type
  OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.creator_user_id IS NOT OLD.creator_user_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.baseline_snapshot_id IS NOT OLD.baseline_snapshot_id
  OR NEW.source_snapshot_id IS NOT OLD.source_snapshot_id
  OR NEW.edit_note IS NOT OLD.edit_note OR NEW.creation_source IS NOT OLD.creation_source
BEGIN SELECT RAISE(ABORT, 'snapshot content and provenance are immutable'); END;

-- Audit identities follow the same canonical user mapping. Restore every
-- immutability guard before commit; audit facts and provenance stay unchanged.
DROP TRIGGER prevent_ugc_snapshots_review_audit_update;
UPDATE ugc_snapshots_review_audit SET admin_user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = ugc_snapshots_review_audit.admin_user_id)
WHERE admin_user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
CREATE TRIGGER prevent_ugc_snapshots_review_audit_update BEFORE UPDATE ON ugc_snapshots_review_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;

DROP TRIGGER prevent_ugc_submission_audit_update;
UPDATE ugc_submission_audit SET
  actor_user_id = COALESCE((SELECT auth_id FROM _user_merge_map WHERE business_id = actor_user_id), actor_user_id),
  deleted_by = COALESCE((SELECT auth_id FROM _user_merge_map WHERE business_id = deleted_by), deleted_by);
CREATE TRIGGER prevent_ugc_submission_audit_update BEFORE UPDATE ON ugc_submission_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;

DROP TRIGGER prevent_ugc_submission_flag_audit_update;
UPDATE ugc_submission_flag_audit SET
  reporter_user_id = COALESCE((SELECT auth_id FROM _user_merge_map WHERE business_id = reporter_user_id), reporter_user_id),
  actor_user_id = COALESCE((SELECT auth_id FROM _user_merge_map WHERE business_id = actor_user_id), actor_user_id);
CREATE TRIGGER prevent_ugc_submission_flag_audit_update BEFORE UPDATE ON ugc_submission_flag_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
UPDATE ugc_submission_upvotes SET user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = ugc_submission_upvotes.user_id)
WHERE user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE ugc_submission_flags SET user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = ugc_submission_flags.user_id)
WHERE user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE ugc_submission_votes SET user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = ugc_submission_votes.user_id)
WHERE user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE notifications SET actor_user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = notifications.actor_user_id)
WHERE actor_user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE notifications SET recipient_user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = notifications.recipient_user_id)
WHERE recipient_user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);
UPDATE notification_messages SET actor_user_id = (SELECT auth_id FROM _user_merge_map WHERE business_id = notification_messages.actor_user_id)
WHERE actor_user_id IN (SELECT business_id FROM _user_merge_map WHERE business_id <> auth_id);

UPDATE users SET
  email = (SELECT lower(trim(a.email)) FROM auth_users a WHERE a.id = users.id),
  name = (SELECT a.name FROM auth_users a WHERE a.id = users.id),
  email_verified = (SELECT a.emailVerified FROM auth_users a WHERE a.id = users.id),
  image = (SELECT a.image FROM auth_users a WHERE a.id = users.id),
  updated_at = (SELECT a.updatedAt FROM auth_users a WHERE a.id = users.id);

-- Respect both historical UID allocations and existing public UIDs.
INSERT INTO user_uid_sequence (id)
SELECT MAX(uid_number) - 100000 FROM users
HAVING MAX(uid_number) - 100000 > COALESCE((SELECT MAX(id) FROM user_uid_sequence), 0);
CREATE TABLE _user_merge_new AS
SELECT a.*, 100000 + COALESCE((SELECT MAX(id) FROM user_uid_sequence), 0)
  + ROW_NUMBER() OVER (ORDER BY a.createdAt, a.id) AS public_number
FROM auth_users a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.id);
INSERT INTO user_uid_sequence (id) SELECT public_number - 100000 FROM _user_merge_new;
-- Choose a deterministic free default without renaming any existing user.
WITH RECURSIVE suffixes(value) AS (
  VALUES ('') UNION ALL SELECT value || 'X' FROM suffixes WHERE length(value) < 25
)
INSERT INTO users (id, email, name, email_verified, image, created_at, updated_at,
                   nickname, uid_number, uid_suffix, nickname_confirmed)
SELECT n.id, lower(trim(n.email)), n.name, n.emailVerified, n.image, n.createdAt, n.updatedAt,
       (SELECT 'U' || n.public_number || value FROM suffixes
        WHERE length('U' || n.public_number || value) <= 26
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.nickname = 'U' || n.public_number || value)
        ORDER BY length(value) LIMIT 1),
       n.public_number, 'AA', 0
FROM _user_merge_new n;

CREATE TABLE auth_accounts_unified (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessToken TEXT, refreshToken TEXT, idToken TEXT,
  accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT, password TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO auth_accounts_unified SELECT * FROM auth_accounts;
DROP TABLE auth_accounts;
ALTER TABLE auth_accounts_unified RENAME TO auth_accounts;
CREATE INDEX idx_auth_accounts_userId ON auth_accounts(userId);
CREATE UNIQUE INDEX idx_auth_accounts_provider_account ON auth_accounts(providerId, accountId);
CREATE INDEX idx_auth_accounts_user_created_at ON auth_accounts(userId, createdAt);

CREATE TABLE auth_sessions_unified (
  id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ipAddress TEXT, userAgent TEXT,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO auth_sessions_unified SELECT * FROM auth_sessions;
DROP TABLE auth_sessions;
ALTER TABLE auth_sessions_unified RENAME TO auth_sessions;
CREATE INDEX idx_auth_sessions_userId ON auth_sessions(userId);

DROP TABLE auth_users;
DROP TABLE _user_merge_new;
DROP TABLE _user_merge_check;
DROP TABLE _user_merge_map;
DROP TABLE _user_merge_auth;
