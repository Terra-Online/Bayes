import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { unstable_splitSqlQuery } from "wrangler";

import { migrateNativeDatabase } from "./native-test-database.mjs";
import { Miniflare } from "./worker-test-runtime.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
const migration = "0038_ugc_snapshots.sql";
const source = await readFile(new URL(`../../migrations/${migration}`, import.meta.url), "utf8");
const seed = await readFile(
  new URL("../../src/test/fixtures/ugcSnapshotLegacy.sql", import.meta.url),
  "utf8",
);

for (const failure of [false, true]) {
  test(`Wrangler local migration executor ${failure ? "rolls back a late failure including registration" : "commits and registers once"}`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ugc-executor-"));
    const state = join(temporary, "state");
    const id = "00000000-0000-4000-8000-000000000013";
    const open = () =>
      new Miniflare({
        modules: true,
        script: "export default {fetch(){return new Response('isolated')}}",
        compatibilityDate: "2026-07-22",
        d1Databases: { DB: id },
        d1Persist: join(state, "v3/d1"),
        outboundService() {
          throw new Error("External network prohibited");
        },
      });
    let worker = open();
    try {
      let db = await worker.getD1Database("DB");
      await migrateNativeDatabase(db, { before: "0038" });
      await db.batch(unstable_splitSqlQuery(seed).map((sql) => db.prepare(sql)));
      const before = (
        await db.prepare("SELECT * FROM notification_counters ORDER BY user_id").all()
      ).results;
      await worker.dispose();
      worker = null;
      await mkdir(join(temporary, "migrations"));
      await writeFile(
        join(temporary, "migrations", migration),
        source + (failure ? "\nINSERT INTO ugc_snapshots(id) VALUES ('late-failure');" : ""),
      );
      const config = join(temporary, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "ugc-executor",
          compatibility_date: "2026-07-22",
          d1_databases: [
            {
              binding: "DB",
              database_name: "ugc-executor",
              database_id: id,
              migrations_dir: "migrations",
            },
          ],
        }),
      );
      const apply = () =>
        run(
          process.execPath,
          [
            cli,
            "d1",
            "migrations",
            "apply",
            "DB",
            "--local",
            "--config",
            config,
            "--persist-to",
            state,
          ],
          {
            env: {
              ...process.env,
              CI: "true",
              WRANGLER_SEND_METRICS: "false",
              WRANGLER_LOG_PATH: join(temporary, "wrangler.log"),
            },
            maxBuffer: 1024 * 1024,
          },
        );
      if (failure) {
        await assert.rejects(apply(), /NOT NULL/);
      } else {
        await apply();
        const repeated = await apply();
        assert.match(repeated.stdout, /No migrations to apply/);
      }
      worker = open();
      db = await worker.getD1Database("DB");
      assert.deepEqual(
        (await db.prepare("SELECT * FROM notification_counters ORDER BY user_id").all()).results,
        before,
      );
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
      const registered = (await db.prepare("SELECT name FROM d1_migrations").all()).results;
      assert.deepEqual(registered, failure ? [] : [{ name: migration }]);
      if (failure) {
        assert.equal(
          (
            await db
              .prepare("SELECT count(*) AS n FROM ugc_submissions WHERE snapshot_id IS NOT NULL")
              .first()
          ).n,
          10,
        );
        assert.equal(
          await db.prepare("SELECT name FROM sqlite_schema WHERE name='ugc_snapshots'").first(),
          null,
        );
      } else {
        assert.equal((await db.prepare("SELECT count(*) AS n FROM ugc_snapshots").first()).n, 10);
        await assert.rejects(
          db.prepare("UPDATE ugc_snapshots SET content='overwrite'").run(),
          /immutable/,
        );
      }
    } finally {
      await worker?.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
