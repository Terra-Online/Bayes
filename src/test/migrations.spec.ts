import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const directory = new URL("../../migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

describe("D1 migration chain", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
  });

  afterEach(() => database.close());

  function apply(files: string[]) {
    for (const file of files) {
      database.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }

  function columns() {
    return database
      .prepare("PRAGMA table_info(users)")
      .all()
      .map((row) => row.name);
  }

  it("initializes a fresh database without manual compatibility SQL", () => {
    apply(migrations);

    expect(columns()).not.toContain("ef_pass");
    expect(columns()).toContain("progress_retained_point_ids");
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.exec(`INSERT INTO users (uid, email, password_hash, nickname)
      VALUES ('fresh-user', 'fresh@example.test', '', 'Fresh');`);
    expect(database.prepare("SELECT role FROM users WHERE uid = 'fresh-user'").get()?.role).toBe(
      "n",
    );
  });

  it("preserves a user through the role migration without copying legacy credentials", () => {
    apply(migrations.filter((file) => file < "0004"));
    database.exec(`ALTER TABLE users ADD COLUMN ef_pass TEXT;
      INSERT INTO users (uid, email, password_hash, nickname, role, points, ef_pass)
      VALUES ('legacy-user', 'legacy@example.test', '', 'Legacy', 'admin', 10, 'synthetic-secret');`);
    apply(migrations.filter((file) => file >= "0004" && file < "0005"));

    expect(database.prepare("SELECT uid, role, points, ef_pass FROM users").get()).toEqual({
      uid: "legacy-user",
      role: "a",
      points: 10,
      ef_pass: null,
    });
  });

  it("removes an existing legacy column without changing users or cascading to bindings", () => {
    apply(migrations.filter((file) => file < "0017"));
    database.exec(`INSERT INTO users (uid, email, password_hash, nickname, ef_pass)
      VALUES ('bound-user', 'bound@example.test', '', 'Bound', 'synthetic-secret');
      INSERT INTO endfield_bindings (uid, provider, server_id, role_id, cred_enc, token_enc)
      VALUES ('bound-user', 'skland', 1, 'role', 'synthetic-cred', 'synthetic-token');`);
    const before = database.prepare("SELECT * FROM users").get()!;
    delete before.ef_pass;
    const binding = database.prepare("SELECT * FROM endfield_bindings").get();

    apply(migrations.filter((file) => file >= "0017" && file < "0018"));

    expect(columns()).not.toContain("ef_pass");
    expect(database.prepare("SELECT * FROM users").get()).toEqual(before);
    expect(database.prepare("SELECT * FROM endfield_bindings").get()).toEqual(binding);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    apply(migrations.filter((file) => file >= "0018"));
    expect(database.prepare("SELECT uid FROM users").get()?.uid).toBe("bound-user");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
