CREATE TABLE IF NOT EXISTS endfield_role_device_profiles (
  role_id TEXT PRIMARY KEY,
  device_profile TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

WITH ranked AS (
  SELECT
    role_id,
    device_profile,
    ROW_NUMBER() OVER (
      PARTITION BY role_id
      ORDER BY updated_at DESC, uid ASC
    ) AS row_number
  FROM endfield_bindings
  WHERE device_profile IS NOT NULL AND trim(device_profile) <> ''
)
INSERT OR IGNORE INTO endfield_role_device_profiles (role_id, device_profile)
SELECT role_id, device_profile
FROM ranked
WHERE row_number = 1;
