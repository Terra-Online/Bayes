import type { DatabaseSync } from "node:sqlite";

/** Synthetic configuration; no provider is contacted when validating seeded sessions. */
export const testAuthConfig = {
  BETTER_AUTH_URL: "http://localhost",
  BETTER_AUTH_SECRET: "test-fixture-secret-at-least-32-characters-long",
  GOOGLE_CLIENT_ID: "test-google",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
  GITHUB_CLIENT_ID: "test-github",
  GITHUB_CLIENT_SECRET: "test-github-secret",
  DISCORD_CLIENT_ID: "test-discord",
  DISCORD_CLIENT_SECRET: "test-discord-secret",
};

export function insertAuthUser(
  sqlite: DatabaseSync,
  input: { id: string; email?: string; name?: string },
) {
  const user = { email: `${input.id}@example.test`, name: input.id, ...input };
  sqlite
    .prepare("INSERT INTO auth_users (id, email, name, emailVerified) VALUES (?, ?, ?, 1)")
    .run(user.id, user.email, user.name);
  return user;
}

/** Seed a session for an explicitly prepared auth user; middleware validates it normally. */
export function insertSession(sqlite: DatabaseSync, input: { userId: string }) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  sqlite
    .prepare(`INSERT INTO auth_sessions
    (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      crypto.randomUUID(),
      input.userId,
      token,
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      now,
      now,
    );
  return { headers: { authorization: `Bearer ${token}` } };
}
