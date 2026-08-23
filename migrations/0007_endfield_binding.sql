PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS endfield_bindings (
  uid TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('skland', 'skport')),
  server_id INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  role_nickname TEXT,
  server_name TEXT,
  cred_enc TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_endfield_bindings_status ON endfield_bindings(status);
