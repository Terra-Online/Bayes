import assert from "node:assert/strict";

import { deferred, within } from "./worker-test-runtime.mjs";

export async function testPublicReads(t, { worker, db, read, gate }) {
  for (const kind of ["images", "comments"]) {
    await t.test(`${kind}: independent cold reads and completed KV reuse`, async () => {
      const first = read(`${kind}-cold`, { "x-test-kind": kind, "x-test-block": "1" });
      await within(gate.blocked.promise);
      try {
        assert.deepEqual(await read(`${kind}-cold`, { "x-test-kind": kind }), {
          items: [],
          statements: 1,
        });
      } finally {
        gate.released.resolve();
      }
      assert.deepEqual(await first, { items: [], statements: 1 });
      assert.deepEqual(await read(`${kind}-cold`, { "x-test-kind": kind }), {
        items: [],
        statements: 0,
      });
      gate.blocked = deferred();
      gate.released = deferred();
    });
  }
  await t.test(
    "image origin: native GET and HEAD retain payload, cache policy and purge tags",
    async () => {
      await db.batch([
        db.prepare(`INSERT INTO ugc_submissions
          (id,kind,poi_id,poi_hash,poi_type,user_id)
          VALUES ('native-image','image','origin-image','hash','poi','user')`),
        db.prepare(`INSERT INTO ugc_snapshots
          (id,submission_id,kind,revision,file_path,review_status,creator_user_id)
          VALUES ('native-image-snapshot','native-image','image',1,'images/native.webp','approved','user')`),
      ]);
      const url =
        "https://fixture.test/origin/images?markerId=origin-image&limit=6&namespace=default&assetBaseUrl=https://assets.test";
      const get = await within(worker.dispatchFetch(url));
      assert.equal(get.status, 200);
      assert.equal(get.headers.get("content-type"), "application/json; charset=utf-8");
      assert.match(get.headers.get("cache-control"), /^public, max-age=\d+$/);
      assert.match(get.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
      assert.equal(get.headers.get("x-oem-marker-kv-cache"), "enabled");
      assert.ok(get.headers.get("cache-tag"));
      const payload = await get.json();
      assert.equal(payload.items.length, 1);
      assert.equal(payload.items[0].id, "native-image");
      assert.equal(payload.items[0].url, "https://assets.test/images/native.webp");

      const head = await within(worker.dispatchFetch(url, { method: "HEAD" }));
      assert.equal(head.status, 200);
      for (const header of [
        "cache-control",
        "cloudflare-cdn-cache-control",
        "cache-tag",
        "x-oem-marker-kv-cache",
      ]) {
        assert.equal(head.headers.get(header), get.headers.get(header));
      }
      assert.equal(await head.text(), "");

      const empty = await within(
        worker.dispatchFetch(url.replace("origin-image", "origin-empty-image")),
      );
      assert.deepEqual(await empty.json(), { items: [] });
      assert.match(empty.headers.get("cache-control"), /^public, max-age=\d+$/);
      assert.match(empty.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
    },
  );
  await t.test(
    "comment origin: native GET and HEAD retain a bounded thread and positive/empty cache policy",
    async () => {
      for (const [id, parentId, depth] of [
        ["native-comment", null, 0],
        ["native-reply", "native-comment", 1],
        ["native-reply-2", "native-comment", 1],
      ]) {
        await db.batch([
          db
            .prepare(`INSERT INTO ugc_submissions
            (id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth)
            VALUES (?1,'comment','origin-comment','hash','poi','user',?2,?3)`)
            .bind(id, parentId, depth),
          db
            .prepare(`INSERT INTO ugc_snapshots
            (id,submission_id,kind,revision,content,review_status,creator_user_id)
            VALUES (?1,?2,'comment',1,?3,'approved','user')`)
            .bind(`${id}-snapshot`, id, `Content ${id}`),
        ]);
      }
      const url =
        "https://fixture.test/origin/comments?markerId=origin-comment&limit=6&replyLimit=1&namespace=default";
      const get = await within(worker.dispatchFetch(url));
      assert.equal(get.status, 200);
      assert.match(get.headers.get("cache-control"), /^public, max-age=\d+$/);
      assert.match(get.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
      assert.equal(get.headers.get("x-oem-marker-comment-kv-cache"), "enabled");
      assert.ok(get.headers.get("cache-tag"));
      const payload = await get.json();
      assert.equal(payload.items.length, 1);
      assert.equal(payload.items[0].content, "Content native-comment");
      assert.equal(payload.items[0].replies.length, 1);
      assert.equal(payload.items[0].replies[0].content, "Content native-reply");
      assert.equal(payload.items[0].replyCount, 2);

      const head = await within(worker.dispatchFetch(url, { method: "HEAD" }));
      assert.equal(head.status, 200);
      for (const header of [
        "cache-control",
        "cloudflare-cdn-cache-control",
        "cache-tag",
        "x-oem-marker-comment-kv-cache",
      ]) {
        assert.equal(head.headers.get(header), get.headers.get(header));
      }
      assert.equal(await head.text(), "");

      const empty = await within(
        worker.dispatchFetch(url.replace("origin-comment", "origin-empty-comment")),
      );
      assert.deepEqual(await empty.json(), { items: [] });
      assert.match(empty.headers.get("cache-control"), /^public, max-age=\d+$/);
      assert.match(empty.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
    },
  );
  await t.test(
    "origin errors stay uncacheable for rejected methods, unknown resources and invalid queries",
    async () => {
      const images =
        "/origin/images?markerId=origin-image&limit=6&namespace=prod&assetBaseUrl=https://assets.test";
      const cases = [
        [images, "POST", 405],
        ["/origin/unknown", "GET", 404],
        [images.replace("limit=6", "limit=1.5"), "GET", 422],
      ];
      for (const [path, method, status] of cases) {
        const response = await within(
          worker.dispatchFetch(`https://fixture.test${path}`, { method }),
        );
        assert.equal(response.status, status, path);
        assert.equal(response.headers.get("cache-control"), "private, no-store", path);
        assert.equal(response.headers.get("cloudflare-cdn-cache-control"), null, path);
        assert.equal((await response.json()).code, "INVALID_PUBLIC_CACHE_REQUEST", path);
      }
    },
  );
}
