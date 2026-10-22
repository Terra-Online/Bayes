import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { executeNativeSql as sql } from "./native-test-database.mjs";
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
    d1Databases: { DB: "local-regression-primary", DB_SECOND: "local-regression-secondary" },
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
        await sql(database, await readFile(join(root, "migrations", name), "utf8"));
      }
      await sql(
        database,
        `
        CREATE TABLE users (
          uid TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT DEFAULT '', role TEXT DEFAULT 'n',
          karma INTEGER DEFAULT 0, avt INTEGER DEFAULT 1, nickname TEXT UNIQUE, nickname_customized INTEGER DEFAULT 1,
          uid_number INTEGER DEFAULT 100001, uid_suffix TEXT DEFAULT 'AA',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_active TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO auth_users (id, name, email, emailVerified) VALUES ('${binding}-user', 'LocalUser', '${binding.toLowerCase()}@example.test', 1);
        INSERT INTO auth_sessions (id, expiresAt, token, userId) VALUES ('${binding}-session', datetime('now', '+180 days'), 'same-local-token', '${binding}-user');
        INSERT INTO users (uid, email, nickname) VALUES ('${binding}-user', '${binding.toLowerCase()}@example.test', 'LocalUser');
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
