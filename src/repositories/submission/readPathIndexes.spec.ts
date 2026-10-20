import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "../../test/sqliteD1";
import { getImageSubmissionByFilePath, getPublicSubmissionByFilePath } from "./statusSubmission";
import { countSubmissionUpvotes } from "./voteSubmission";

const migrations = new URL("../../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0036_file_path_and_vote_indexes.sql", migrations), "utf8");

describe("read path index migration on the repository schema", () => {
  let database: SqliteD1;
  beforeEach(() => {
    database = new SqliteD1();
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql") && name < "0036").sort()) {
      // 0017 removes a legacy column installed outside the historical migration
      // chain. Supply that old-layout fixture; do not modify/replay old migrations.
      if (file.startsWith("0017")) database.sqlite.exec("ALTER TABLE users ADD COLUMN ef_pass TEXT");
      database.sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
    // Reproduce the observed installation where 0027's vote index is missing.
    database.sqlite.exec("DROP INDEX idx_ugc_submission_upvotes_active_submission");
    database.sqlite.exec("INSERT INTO users (uid, email, password_hash, nickname) VALUES ('owner', 'owner@example.test', '', 'Owner'), ('other', 'other@example.test', '', 'Other')");
    const insert = database.sqlite.prepare(`INSERT INTO ugc_submissions
      (id, kind, poi_id, poi_hash, poi_type, snapshot_id, user_id, file_path, status, content)
      VALUES (?, ?, 'marker', 'hash', 'type', ?, ?, ?, ?, 'fixture')`);
    for (let index = 0; index < 1000; index += 1) {
      insert.run(`image-${index}`, "image", `snapshot-${index}`, "owner", `files/${index}.webp`, "active");
    }
    insert.run("pending", "image", "pending-snapshot", "owner", "files/shared.webp", "pending_audit");
    insert.run("public", "image", "public-snapshot", "other", "files/shared.webp", "active");
    insert.run("removed", "image", "removed-snapshot", "owner", "files/removed.webp", "stale");
    insert.run("comment", "comment", "comment-snapshot", "owner", "files/comment.webp", "active");
    database.sqlite.exec(`INSERT INTO ugc_submission_upvotes (submission_id, user_id, active)
      SELECT id, 'owner', 1 FROM ugc_submissions WHERE kind = 'image';
      INSERT INTO ugc_submission_upvotes (submission_id, user_id, active) VALUES ('public', 'other', 0);`);
  });
  afterEach(() => database.sqlite.close());

  async function lookup() {
    return Promise.all([
      getImageSubmissionByFilePath(database.db, "files/shared.webp", { uid: "owner", role: "n" }),
      getPublicSubmissionByFilePath(database.db, "files/shared.webp"),
      getPublicSubmissionByFilePath(database.db, "files/removed.webp"),
      getImageSubmissionByFilePath(database.db, "files/comment.webp", { uid: "owner", role: "n" }),
      getImageSubmissionByFilePath(database.db, "files/missing.webp", { uid: "owner", role: "n" }),
      countSubmissionUpvotes(database.db, "public"),
      countSubmissionUpvotes(database.db, "missing"),
    ]);
  }

  it("preserves duplicate paths, ownership, moderation visibility and active vote counts", async () => {
    const before = await lookup();
    expect(before[0]).toMatchObject({ id: "pending", userId: "owner", status: "pending_audit" });
    expect(before[1]).toMatchObject({ id: "public", userId: "other", status: "active" });
    expect(before.slice(2)).toEqual([null, null, null, 1, 0]);
    database.sqlite.exec(migration);
    database.sqlite.exec(migration); // Safe both on repaired and already-current installations.
    expect(await lookup()).toEqual(before);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM ugc_submissions WHERE file_path = 'files/shared.webp'").get()!.n).toBe(2);
  });

  it("turns broad kind/active scans into exact searches without requiring business SQL rewrites", async () => {
    await lookup();
    const queries = database.queries.slice(0, 7);
    const before = queries.map((query) => database.explain(query));
    expect(before[0]).not.toContain("file_path=?");
    expect(before[5]).not.toContain("submission_id=?");
    database.sqlite.exec(migration);
    const after = queries.map((query) => database.explain(query));
    expect(after[0]).toContain("idx_ugc_submissions_file_path_kind (file_path=? AND kind=?)");
    expect(after[1]).toContain("idx_ugc_submissions_file_path_kind (file_path=? AND kind=?)");
    expect(after[5]).toContain("COVERING INDEX idx_ugc_submission_upvotes_active_submission (active=? AND submission_id=?)");
  });

  it("is idempotent when the vote index from 0027 already exists", () => {
    database.sqlite.exec("CREATE INDEX idx_ugc_submission_upvotes_active_submission ON ugc_submission_upvotes(active, submission_id)");
    database.sqlite.exec(migration);
    const indexes = database.sqlite.prepare("PRAGMA index_list('ugc_submissions')").all();
    expect(indexes.find((row) => row.name === "idx_ugc_submissions_file_path_kind")!.unique).toBe(0);
    expect(database.sqlite.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  });

  it("filters ownership before LIMIT for duplicate paths and preserves privileged/stale access", async () => {
    for (const apply of [false, true]) {
      if (apply) database.sqlite.exec(migration);
      expect(await getImageSubmissionByFilePath(database.db, "files/shared.webp", { uid: "other", role: "n" })).toMatchObject({ id: "public" });
      expect(await getImageSubmissionByFilePath(database.db, "files/shared.webp", { uid: "stranger", role: "n" })).toBeNull();
      expect(await getImageSubmissionByFilePath(database.db, "files/removed.webp", { uid: "owner", role: "n" })).toBeNull();
      for (const role of ["p", "a", "r"] as const) {
        expect(await getImageSubmissionByFilePath(database.db, "files/removed.webp", { uid: "stranger", role })).toMatchObject({ id: "removed", status: "stale" });
      }
    }
  });
});
