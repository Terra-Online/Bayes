import { DatabaseSync } from "node:sqlite";

export function createUGCImageDatabase(): {
  sqlite: DatabaseSync;
  db: D1Database;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    [
      "CREATE TABLE ugc_submissions (",
      "  id TEXT PRIMARY KEY, kind TEXT, status TEXT, poi_id TEXT, file_path TEXT,",
      "  user_id TEXT, content TEXT, created_at TEXT",
      ");",
      "CREATE INDEX idx_ugc_user_kind_poi_created",
      "  ON ugc_submissions(user_id, kind, poi_id, created_at DESC, id DESC);",
      "CREATE INDEX idx_ugc_kind_status_poi_created",
      "  ON ugc_submissions(kind, status, poi_id, created_at DESC, id DESC);",
      "CREATE TABLE users (",
      "  uid TEXT PRIMARY KEY, uid_number INTEGER, uid_suffix TEXT, role TEXT,",
      "  karma INTEGER, nickname TEXT",
      ");",
      "CREATE TABLE ugc_submission_upvotes (submission_id TEXT, user_id TEXT, active INTEGER,",
      "  PRIMARY KEY (submission_id, user_id));",
      "CREATE TABLE ugc_submission_flags (submission_id TEXT, user_id TEXT, active INTEGER,",
      "  PRIMARY KEY (submission_id, user_id));",
      "INSERT INTO users VALUES ('author', 123, 'abcd', 'n', 0, 'Author');",
      "INSERT INTO ugc_submissions VALUES",
      "  ('photo', 'image', 'active', '42', 'images/photo.webp', 'author', 'Caption', '2026-09-01'),",
      "  ('test-photo', 'image', 'active', '42', '_test/photo.webp', 'author', NULL, '2026-09-02'),",
      "  ('mine', 'image', 'active', '42', 'images/mine.webp', 'author', NULL, '2026-09-03');",
      "INSERT INTO ugc_submission_upvotes VALUES",
      "  ('photo', 'viewer', 1), ('photo', 'other', 1), ('photo', 'inactive', 0);",
      "INSERT INTO ugc_submission_flags VALUES",
      "  ('photo', 'viewer', 1), ('photo', 'inactive', 0);",
    ].join("\n"),
  );

  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, "$p$1"));
      return {
        bind(...values: Array<string | number | null>) {
          const bindings = Object.fromEntries(
            values.map((value, index) => ["$p" + (index + 1), value]),
          );
          return {
            first: async () => statement.get(bindings) ?? null,
            all: async () => ({
              results: statement.all(bindings),
              success: true,
            }),
          };
        },
      };
    },
  } as unknown as D1Database;

  return { sqlite, db };
}
