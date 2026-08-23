CREATE INDEX IF NOT EXISTS idx_users_created_at
  ON users(created_at);

CREATE INDEX IF NOT EXISTS idx_auth_accounts_user_created_at
  ON auth_accounts(userId, createdAt);
