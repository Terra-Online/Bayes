import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

import { migrateNativeDatabase } from "./native-test-database.mjs";
import { Miniflare } from "./worker-test-runtime.mjs";

const runtimeRequire = createRequire(
  createRequire(import.meta.url).resolve("wrangler/package.json"),
);
const { transform } = runtimeRequire("esbuild");
const source = await readFile(
  new URL("../../src/repositories/submission/appendCommentVersion.ts", import.meta.url),
  "utf8",
);
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const { appendCommentVersion } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`
);

test("native D1 competing edits have one winner and failed appends consume no revision", async () => {
  const worker = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("edit test"); } }',
    compatibilityDate: "2026-07-22",
    d1Databases: { DB: "ugc-edit-test" },
    outboundService() {
      throw new Error("External network prohibited");
    },
  });
  try {
    const first = await worker.getD1Database("DB");
    const second = await worker.getD1Database("DB");
    await migrateNativeDatabase(first);
    await first
      .prepare(
        "INSERT INTO users(uid,email,password_hash,nickname,role) VALUES ('author','author@example.test','','Author','n')",
      )
      .run();

    await first.batch([
      first.prepare(
        "INSERT INTO ugc_submissions(id,kind,poi_id,poi_hash,poi_type,user_id) VALUES ('comment','comment','marker','hash','poi','author')",
      ),
      first.prepare(
        "INSERT INTO ugc_snapshots(id,submission_id,kind,revision,content,review_status,creator_user_id) VALUES ('A','comment','comment',1,'Original','approved','author')",
      ),
    ]);
    const input = {
      submissionId: "comment",
      parentSnapshotId: "A",
      actorId: "author",
      content: "Changed",
    };
    await assert.rejects(
      appendCommentVersion(first, { ...input, snapshotId: "invalid", content: "  " }),
      /CHECK constraint/,
    );
    const results = await Promise.all([
      appendCommentVersion(first, { ...input, snapshotId: "B" }),
      appendCommentVersion(second, { ...input, snapshotId: "C" }),
    ]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["appended", "conflict"]);
    assert.deepEqual(await first.prepare("SELECT revision FROM ugc_submissions").first(), {
      revision: 2,
    });
    assert.deepEqual(
      (await first.prepare("SELECT revision FROM ugc_snapshots ORDER BY revision").all()).results,
      [{ revision: 1 }, { revision: 2 }],
    );
    assert.deepEqual((await first.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await worker.dispose();
  }
});
