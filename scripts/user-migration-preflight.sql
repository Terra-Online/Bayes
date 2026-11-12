-- Read-only report for the 0040 cutover. Run against the old schema before applying
-- migrations. Every row in the first four result sets requires resolution first.
SELECT 'BUSINESS_USER_WITHOUT_AUTH_USER' AS issue,
       u.uid AS business_id, u.uid_number, u.uid_suffix,
       (SELECT COUNT(*) FROM ugc_submissions s WHERE s.user_id = u.uid) AS submissions,
       (SELECT COUNT(*) FROM endfield_bindings b WHERE b.uid = u.uid) AS bindings,
       (SELECT COUNT(*) FROM user_archive_progress p WHERE p.uid = u.uid) AS archive_progress
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM auth_users a WHERE a.id = u.uid OR lower(trim(a.email)) = lower(trim(u.email))
);

SELECT 'AMBIGUOUS_AUTH_EMAIL' AS issue, lower(trim(email)) AS normalized_email, COUNT(*) AS identities
FROM auth_users GROUP BY lower(trim(email)) HAVING COUNT(*) > 1;

SELECT 'CONFLICTING_USER_IDENTITIES' AS issue, u.uid AS business_id,
       by_id.id AS auth_id, by_email.id AS email_auth_id
FROM users u
JOIN auth_users by_email ON lower(trim(by_email.email)) = lower(trim(u.email))
LEFT JOIN auth_users by_id ON by_id.id = u.uid
WHERE (by_id.id IS NOT NULL AND by_id.id <> by_email.id)
   OR EXISTS (SELECT 1 FROM users other WHERE other.uid = by_email.id AND other.uid <> u.uid);

SELECT 'INVALID_PUBLIC_UID' AS issue, uid AS business_id, uid_number, uid_suffix
FROM users WHERE uid_number IS NULL OR uid_number <= 0 OR uid_suffix IS NULL OR length(uid_suffix) <> 2;

-- Informational: these identities receive default business fields during migration.
SELECT 'INITIALIZE_BUSINESS_FIELDS' AS action, a.id AS auth_id
FROM auth_users a
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.uid = a.id OR lower(trim(u.email)) = lower(trim(a.email)));

-- Informational: audit the deterministic business-to-auth identity mapping.
SELECT 'REMAP_BUSINESS_ID' AS action, u.uid AS business_id, a.id AS auth_id
FROM users u JOIN auth_users a ON lower(trim(a.email)) = lower(trim(u.email))
WHERE u.uid <> a.id AND NOT EXISTS (SELECT 1 FROM auth_users by_id WHERE by_id.id = u.uid);
