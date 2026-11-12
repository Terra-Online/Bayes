import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { executeNativeSql as sql, migrateNativeDatabase } from "./native-test-database.mjs";
import { bundleFixture, deferred, Miniflare, root, within } from "./worker-test-runtime.mjs";

const temporary = await mkdtemp(join(tmpdir(), "bayes-auth-regression-"));
const secret = "local-runtime-only-secret-at-least-32-characters";
const authOrigin = "https://api.opendfieldmap.org";
const migration = await readFile(
  join(root, "migrations/0036_file_path_and_vote_indexes.sql"),
  "utf8",
);

async function runtime() {
  const fixture = await bundleFixture(temporary, "authRuntime");
  let blocked = deferred();
  let release = deferred();
  const worker = new Miniflare({
    ...fixture,
    d1Databases: {
      DB: "local-regression-primary",
      DB_SECOND: "local-regression-secondary",
      DB_MIGRATION: "local-user-migration",
    },
    ratelimits: {
      OEM_PUBLIC_RATE_LIMIT: { namespace_id: "100", simple: { limit: 100, period: 60 } },
      OEM_AUTH_RATE_LIMIT: { namespace_id: "101", simple: { limit: 100, period: 60 } },
    },
    bindings: {
      BETTER_AUTH_URL: authOrigin,
      BETTER_AUTH_SECRET: secret,
      EMAIL_PROVIDER_MODE: "cloudflare_only",
      GOOGLE_CLIENT_ID: "local-google",
      GOOGLE_CLIENT_SECRET: "local-secret",
      GITHUB_CLIENT_ID: "local-github",
      GITHUB_CLIENT_SECRET: "local-secret",
      DISCORD_CLIENT_ID: "local-discord",
      DISCORD_CLIENT_SECRET: "local-secret",
    },
    serviceBindings: {
      TEST_GATE: async () => {
        blocked.resolve();
        await release.promise;
        return new Response("released");
      },
    },
    outboundService: () => {
      throw new Error("External network is forbidden in this local regression");
    },
  });
  try {
    for (const binding of ["DB", "DB_SECOND"]) {
      const database = await worker.getD1Database(binding);
      // Keep this specialist schema: cold enumeration counts measure auth initialization,
      // and the index probe below needs tables without 0036 already applied.
      for (const name of [
        "0002_better_auth.sql",
        "0005_auth_verifications_unique_identifier.sql",
      ]) {
        await sql(
          database,
          (await readFile(join(root, "migrations", name), "utf8")).replaceAll(
            "REFERENCES auth_users(id)",
            "REFERENCES users(id)",
          ),
        );
      }
      await sql(
        database,
        `
        CREATE TABLE users (
          id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL DEFAULT '', email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, role TEXT DEFAULT 'n',
          karma INTEGER DEFAULT 0, avt INTEGER DEFAULT 1, nickname TEXT UNIQUE, nickname_confirmed INTEGER DEFAULT 1,
          uid_number INTEGER DEFAULT 100001, uid_suffix TEXT DEFAULT 'AA',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_active TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users (id, email, name, nickname, email_verified) VALUES ('${binding}-user', '${binding.toLowerCase()}@example.test', 'LocalUser', 'LocalUser', 1);
        INSERT INTO auth_sessions (id, expiresAt, token, userId) VALUES ('${binding}-session', datetime('now', '+180 days'), 'same-local-token', '${binding}-user');
        CREATE TABLE user_uid_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT);
        INSERT INTO user_uid_sequence (id) VALUES (1);
      `,
      );
    }
  } catch (error) {
    await worker.dispose();
    throw error;
  }
  return {
    worker,
    request: (path, extra = {}) =>
      worker.dispatchFetch(`${authOrigin}${path}`, {
        headers: { authorization: "Bearer same-local-token", ...extra },
      }),
    blocked: () => blocked.promise,
    release: () => {
      release.resolve();
    },
    resetGate: () => {
      blocked = deferred();
      release = deferred();
    },
  };
}

try {
  await test("native Workers request isolation, schema checks, sessions and D1 indexes", async (t) => {
    const current = await runtime();
    const { worker, request } = current;
    try {
      await t.test(
        "concurrent cold callers own their initialization; warm callers skip schema enumeration",
        async () => {
          const first = request("/init", { "x-test-block-schema": "1" });
          await within(current.blocked());
          let second;
          try {
            second = await within(request("/init"));
          } finally {
            current.release();
          }
          const responses = [await within(first), second];
          for (const response of responses) {
            assert.equal(response.status, 200, await response.text());
            assert.equal(response.headers.get("x-test-schema-lists"), "1");
            assert.equal(response.headers.get("x-test-schema-columns"), "4");
          }
          const warm = await request("/init");
          assert.equal(warm.status, 200);
          assert.equal(warm.headers.get("x-test-schema-lists"), "0");
          assert.equal(warm.headers.get("x-test-db-statements"), "0");
          current.resetGate();
        },
      );
      await t.test("the session route makes one session read and isolates bindings", async () => {
        const first = await request("/auth/v1/session");
        assert.equal(first.status, 200, await first.clone().text());
        assert.equal(first.headers.get("x-test-session-reads"), "1");
        assert.equal(first.headers.get("x-test-schema-lists"), "0");
        const identities = await Promise.all([request("/identity"), request("/identity?second")]);
        assert.deepEqual(
          await Promise.all(
            identities.map((response) => response.json().then((value) => value.uid)),
          ),
          ["DB-user", "DB_SECOND-user"],
        );
      });
      await t.test(
        "concurrent first nickname confirmations finalize the UID once on native D1",
        async () => {
          const db = await worker.getD1Database("DB");
          await db.prepare("UPDATE users SET nickname_confirmed = 0 WHERE id = 'DB-user'").run();
          const save = (nickname) =>
            worker.dispatchFetch(`${authOrigin}/auth/v1/profile`, {
              method: "PATCH",
              headers: {
                authorization: "Bearer same-local-token",
                "content-type": "application/json",
                origin: "https://opendfieldmap.org",
              },
              body: JSON.stringify({ nickname }),
            });
          const responses = await Promise.all([save("Explorer"), save("Navigator")]);
          for (const response of responses) {
            assert.equal(response.status, 200, await response.clone().text());
          }
          const profiles = await Promise.all(responses.map((response) => response.json()));
          const uid = profiles[0].user.uid;
          assert.ok(["100001ER", "100001OR"].includes(uid));
          assert.equal(profiles[1].user.uid, uid);
          const renamed = await save("Renamed");
          assert.equal(renamed.status, 200, await renamed.clone().text());
          assert.equal((await renamed.json()).user.uid, uid);
          assert.deepEqual(
            await db
              .prepare(
                "SELECT uid_number, uid_suffix, nickname_confirmed FROM users WHERE id = 'DB-user'",
              )
              .first(),
            {
              uid_number: 100001,
              uid_suffix: uid.slice(-2),
              nickname_confirmed: 1,
            },
          );
        },
      );
      await t.test(
        "password login checks redirect destinations before authenticating credentials",
        async () => {
          for (const [field, code] of [
            ["redirectTo", "INVALID_REDIRECT_URL"],
            ["errorCallbackURL", "INVALID_ERROR_CALLBACK_URL"],
            ["newUserCallbackURL", "INVALID_NEW_USER_CALLBACK_URL"],
          ]) {
            const response = await worker.dispatchFetch(`${authOrigin}/auth/v1/sign-in/email`, {
              method: "POST",
              headers: { "content-type": "application/json", origin: "https://opendfieldmap.org" },
              body: JSON.stringify({
                email: "db@example.test",
                password: "unused-password",
                [field]: "https://untrusted.example/return",
              }),
            });
            assert.equal(response.status, 403, await response.clone().text());
            assert.equal((await response.json()).code, code);
          }
        },
      );
      await t.test(
        "one failed request cannot own or reject another request's pending auth work",
        async () => {
          const db = await worker.getD1Database("DB");
          await db.prepare("UPDATE auth_sessions SET token = 'independent-token'").run();
          // This token is cold in the completed identity cache.
          const owner = request("/identity", {
            authorization: "Bearer independent-token",
            "x-test-block": "1",
          });
          await within(current.blocked());
          const other = request("/identity", { authorization: "Bearer independent-token" });
          try {
            const response = await within(other);
            assert.equal(response.status, 200, await response.text());
          } finally {
            current.release();
          }
          assert.equal((await within(owner)).status, 500);
        },
      );
      await t.test(
        "native D1 point reads shrink and index write/storage cost stays visible",
        async () => {
          const db = await worker.getD1Database("DB");
          await sql(
            db,
            `
          CREATE TABLE ugc_submissions (id TEXT PRIMARY KEY, kind TEXT, file_path TEXT, status TEXT, user_id TEXT);
          CREATE INDEX idx_ugc_comment_threads ON ugc_submissions(kind);
          CREATE TABLE ugc_submission_upvotes (submission_id TEXT, user_id TEXT, active INTEGER, created_at TEXT, PRIMARY KEY(submission_id, user_id));
          CREATE INDEX idx_ugc_submission_upvotes_active_created ON ugc_submission_upvotes(active, created_at);
          WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4096)
            INSERT INTO ugc_submissions SELECT 'image-'||x, 'image', 'files/'||x||'.webp', 'active', 'local-user' FROM n;
          INSERT INTO ugc_submission_upvotes SELECT id, 'local-user', 1, '2026-10-16' FROM ugc_submissions;
        `,
          );
          const fileSql =
            "SELECT * FROM ugc_submissions WHERE file_path = ?1 AND kind = 'image' AND (?2 = 1 OR (user_id = ?3 AND status <> 'stale')) LIMIT 1";
          const votesSql =
            "SELECT COUNT(*) AS count FROM ugc_submission_upvotes WHERE submission_id = ?1 AND active = 1";
          async function inspect() {
            const file = await db.prepare(fileSql).bind("files/4096.webp", 0, "local-user").all();
            const votes = await db.prepare(votesSql).bind("image-4096").all();
            const filePlan = (
              await db
                .prepare(`EXPLAIN QUERY PLAN ${fileSql}`)
                .bind("files/4096.webp", 0, "local-user")
                .all()
            ).results;
            const votesPlan = (
              await db.prepare(`EXPLAIN QUERY PLAN ${votesSql}`).bind("image-4096").all()
            ).results;
            const write = await db
              .prepare(
                "INSERT INTO ugc_submissions VALUES ('write-probe', 'image', 'files/write.webp', 'pending_audit', 'local-user')",
              )
              .run();
            const voteWrite = await db
              .prepare(
                "INSERT INTO ugc_submission_upvotes VALUES ('write-probe', 'local-user', 1, '2026-10-16')",
              )
              .run();
            await db
              .prepare("DELETE FROM ugc_submission_upvotes WHERE submission_id = 'write-probe'")
              .run();
            await db.prepare("DELETE FROM ugc_submissions WHERE id = 'write-probe'").run();
            return {
              file,
              votes,
              filePlan,
              votesPlan,
              write: write.meta,
              voteWrite: voteWrite.meta,
              sizeBytes: voteWrite.meta.size_after,
            };
          }
          const before = await inspect();
          const applied = (await sql(db, migration)).map((result) => result.meta);
          await sql(db, migration); // Idempotency on native D1 too.
          const after = await inspect();
          assert.deepEqual(after.file.results, before.file.results);
          assert.deepEqual(after.votes.results, before.votes.results);
          assert.ok(after.file.meta.rows_read < before.file.meta.rows_read);
          assert.ok(after.votes.meta.rows_read < before.votes.meta.rows_read);
          const evidence = (result) => ({
            file: result.file.meta,
            votes: result.votes.meta,
            filePlan: result.filePlan,
            votesPlan: result.votesPlan,
            write: result.write,
            voteWrite: result.voteWrite,
            sizeBytes: result.sizeBytes,
          });
          console.log(
            JSON.stringify({
              nativeD1: {
                fixtureRows: 4096,
                fileSql,
                votesSql,
                before: evidence(before),
                after: evidence(after),
                migration: applied,
              },
            }),
          );
        },
      );
      await t.test(
        "populated native D1 migration preserves business data under the auth ID",
        async () => {
          const db = await worker.getD1Database("DB_MIGRATION");
          const files = (await readdir(join(root, "migrations")))
            .filter((file) => file.endsWith(".sql"))
            .sort();
          await migrateNativeDatabase(
            db,
            files.filter((file) => file < "0039"),
          );
          await sql(
            db,
            `
          INSERT INTO auth_users (id, email, name, emailVerified) VALUES ('auth', 'owner@example.test', 'Owner', 1);
          INSERT INTO users (uid, email, password_hash, nickname, uid_number, uid_suffix, points)
            VALUES ('business', 'owner@example.test', '', 'Owner', 123456, 'AB', 31);
          INSERT INTO endfield_bindings (uid, provider, server_id, role_id, cred_enc, token_enc)
            VALUES ('business', 'skland', 1, 'role', 'cred', 'token');
          INSERT INTO auth_sessions (id, token, expiresAt, userId) VALUES ('session', 'token', '2099-01-01', 'auth');
          INSERT INTO ugc_submissions (id, kind, poi_id, poi_hash, poi_type, user_id)
            VALUES ('comment', 'comment', 'marker', 'hash', 'poi', 'business');
          INSERT INTO ugc_snapshots (id, submission_id, kind, revision, content, review_status, creator_user_id)
            VALUES ('snapshot', 'comment', 'comment', 1, 'Original content', 'approved', 'business');
        `,
          );
          await migrateNativeDatabase(db, ["0039_unified_users.sql"]);
          assert.deepEqual(
            await db.prepare("SELECT id, uid_number, uid_suffix, points FROM users").first(),
            { id: "auth", uid_number: 123456, uid_suffix: "AB", points: 31 },
          );
          assert.equal(await db.prepare("SELECT uid FROM endfield_bindings").first("uid"), "auth");
          assert.equal(
            await db.prepare("SELECT userId FROM auth_sessions").first("userId"),
            "auth",
          );
          assert.deepEqual(
            await db.prepare("SELECT creator_user_id, content FROM ugc_snapshots").first(),
            { creator_user_id: "auth", content: "Original content" },
          );
          await assert.rejects(
            db.prepare("UPDATE ugc_snapshots SET content = 'Changed content'").run(),
            /snapshot content is immutable/,
          );
          await assert.rejects(
            db.prepare("UPDATE ugc_snapshots SET creator_user_id = 'business'").run(),
            /snapshot content is immutable/,
          );
          assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
        },
      );
      await t.test("user creation rolls back its UID allocation on native D1", async () => {
        const db = await worker.getD1Database("DB");
        await sql(
          db,
          `CREATE TRIGGER reject_new_user BEFORE INSERT ON users
          WHEN NEW.email = 'rollback@example.test'
          BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`,
        );
        assert.equal((await request("/create-user?email=rollback@example.test")).status, 500);
        assert.equal(
          await db
            .prepare("SELECT COUNT(*) FROM users WHERE email = 'rollback@example.test'")
            .first("COUNT(*)"),
          0,
        );
        assert.equal(await db.prepare("SELECT MAX(id) FROM user_uid_sequence").first("MAX(id)"), 1);
        await sql(db, "DROP TRIGGER reject_new_user");
        const created = await request("/create-user?email=rollback@example.test");
        assert.equal(created.status, 200, await created.clone().text());
        const user = await db
          .prepare(
            "SELECT uid_number, nickname_confirmed FROM users WHERE email = 'rollback@example.test'",
          )
          .first();
        assert.deepEqual(user, { uid_number: 100002, nickname_confirmed: 0 });
      });
    } finally {
      current.release();
      await worker.dispose();
    }

    await t.test(
      "previous global-promise pattern reproduces cross-request failure propagation",
      async () => {
        const previous = await runtime();
        try {
          const owner = previous.request("/legacy-identity", { "x-test-block": "1" });
          await within(previous.blocked());
          const other = previous.request("/legacy-identity");
          const resultBeforeRelease = await Promise.race([
            other.then((response) => response.status),
            delay(200, null),
          ]);
          assert.equal(resultBeforeRelease, null);
          previous.release();
          const responses = await within(Promise.all([owner, other]));
          assert.deepEqual(
            responses.map((response) => response.status),
            [500, 500],
          );
        } finally {
          previous.release();
          await previous.worker.dispose();
        }
      },
    );
    await t.test(
      "a rejected singleton design couples otherwise independent requests through Kysely's lock",
      async () => {
        const singleton = await runtime();
        try {
          assert.equal((await singleton.request("/singleton-init")).status, 200);
          const owner = singleton.request("/singleton-identity", { "x-test-block": "1" });
          await within(singleton.blocked());
          const other = singleton.request("/singleton-identity");
          assert.equal(
            await Promise.race([other.then((response) => response.status), delay(200, null)]),
            null,
          );
          singleton.release();
          const responses = await within(Promise.all([owner, other]));
          assert.deepEqual(
            responses.map((response) => response.status),
            [500, 200],
          );
        } finally {
          singleton.release();
          await singleton.worker.dispose();
        }
      },
    );
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
