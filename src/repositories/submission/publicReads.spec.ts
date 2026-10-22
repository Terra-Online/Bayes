import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markNotificationsRead } from "@/repositories/notifications";
import {
  getDuplicateImageMarkerSummary,
  listDuplicateImageMarkers,
  listDuplicateMarkerImages,
} from "@/repositories/submission-duplicates";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertNotification } from "@/test/fixtures/notifications";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import { listVisibleImageCountsByMarker } from "./imageCoverage";
import {
  listActiveCommentsByMarker,
  listCommentViewerStateByMarker,
  listUserCommentsByMarker,
} from "./listComments";
import {
  listActiveImagesByMarker,
  listImageViewerReactionsByMarker,
  listUserImagesByMarker,
} from "./listImages";
import { getVisibleCommentsByIds } from "./statusSubmission";

describe("public read SQL under D1 limits", () => {
  let connection: TestDatabase;
  const markerIds = Array.from({ length: 100 }, (_, index) => `marker-${index}`);

  beforeEach(() => {
    connection = createTestDatabase();
    insertUser(connection.sqlite, {
      uid: "viewer",
      uid_number: 1,
      uid_suffix: "test",
      nickname: "Viewer",
      avt: 1,
    });
    insertUser(connection.sqlite, { uid: "other-user" });
    insertUser(connection.sqlite, { uid: "another-user" });
  });

  afterEach(() => connection.close());

  function insert(
    id: string,
    markerId: string,
    options: {
      parentId?: string;
      depth?: number;
      kind?: "comment" | "image";
      status?: string;
      filePath?: string;
    } = {},
  ) {
    insertSubmission(connection.sqlite, {
      id,
      userId: "viewer",
      markerId,
      filePath: options.filePath ?? `prod/${id}.webp`,
      kind: options.kind ?? "comment",
      status: options.status ?? "active",
      parentId: options.parentId ?? null,
      depth: options.depth ?? 0,
      content: "content",
      createdAt: "2026-09-05",
    });
  }

  it("treats image namespace prefixes literally in public, private and viewer reads", async () => {
    for (const [id, filePath] of [
      ["test", "_test/image.webp"],
      ["similar", "xtest/image.webp"],
      ["sibling", "_test-other/image.webp"],
    ]) {
      insert(id, "marker-1", { kind: "image", filePath });
      connection.sqlite
        .prepare("INSERT INTO ugc_submission_flags (submission_id, user_id) VALUES (?, 'viewer')")
        .run(id);
    }
    const base = {
      markerId: "marker-1",
      assetBaseUrl: "https://assets.example",
      privateAssetBaseUrl: "https://private.example",
      userId: "viewer",
    };
    for (const [scope, ids] of [
      [{ pathPrefix: "_test" }, ["test"]],
      [{ excludePathPrefix: "_test" }, ["sibling", "similar"]],
    ] as const) {
      expect(
        (await listActiveImagesByMarker(connection.db, { ...base, ...scope }))
          .map((item) => item.id)
          .sort(),
      ).toEqual([...ids]);
      expect(
        (await listUserImagesByMarker(connection.db, { ...base, ...scope }))
          .map((item) => item.id)
          .sort(),
      ).toEqual([...ids]);
      expect(
        [
          ...(
            await listImageViewerReactionsByMarker(connection.db, {
              ...base,
              ...scope,
              markerIds: ["marker-1"],
              submissionIds: ["test", "similar", "sibling"],
            })
          ).keys(),
        ].sort(),
      ).toEqual([...ids]);
    }
    expect(
      await getDuplicateImageMarkerSummary(connection.db, {
        markerId: "marker-1",
        pathPrefix: "_test",
      }),
    ).toBeNull();
    expect(
      await listDuplicateImageMarkers(connection.db, { ...base, pathPrefix: "_test" }),
    ).toEqual({ items: [], total: 0 });
    expect(
      await listDuplicateMarkerImages(connection.db, { ...base, pathPrefix: "_test" }),
    ).toEqual({ items: [], total: 1 });
    expect(
      await getDuplicateImageMarkerSummary(connection.db, {
        markerId: "marker-1",
        excludePathPrefix: "_test",
      }),
    ).toEqual({ markerId: "marker-1", imageCount: 2 });
    expect(
      await listDuplicateImageMarkers(connection.db, { ...base, excludePathPrefix: "_test" }),
    ).toMatchObject({
      total: 1,
      items: [{ markerId: "marker-1", imageCount: 2, latestImage: { id: "similar" } }],
    });
    const duplicates = await listDuplicateMarkerImages(connection.db, {
      ...base,
      excludePathPrefix: "_test",
    });
    expect(duplicates.total).toBe(2);
    expect(duplicates.items.map((item) => item.id).sort()).toEqual(["sibling", "similar"]);
    expect(await listVisibleImageCountsByMarker(connection.db, { pathPrefix: "_test" })).toEqual([
      { markerId: "marker-1", imageCount: 1 },
    ]);
    expect(
      await listVisibleImageCountsByMarker(connection.db, { excludePathPrefix: "_test" }),
    ).toEqual([{ markerId: "marker-1", imageCount: 2 }]);
  });

  it("loads 100 markers and more than 100 reply roots without excess SQL parameters", async () => {
    for (const markerId of markerIds) {
      for (const suffix of ["a", "b"]) {
        const rootId = `${markerId}-${suffix}`;
        insert(rootId, markerId);
        insert(`${rootId}-reply`, markerId, { parentId: rootId, depth: 1 });
      }
    }
    const comments = await listActiveCommentsByMarker(connection.db, {
      markerIds,
      limit: 2,
      replyLimit: 3,
      viewerUserId: "viewer",
    });
    expect(comments).toHaveLength(200);
    expect(
      comments.every((comment) => comment.replyCount === 1 && comment.replies.length === 1),
    ).toBe(true);
    expect(connection.queries).toHaveLength(1);
    expect(connection.queries.every((query) => query.values.length === 4)).toBe(true);
  });

  it("preserves vote ranking, nested replies, visibility, and indexed reaction lookups", async () => {
    insert("root-low", "marker-1");
    insert("root-high", "marker-1");
    insert("reply", "marker-1", { parentId: "root-high", depth: 1 });
    insert("nested", "marker-1", { parentId: "reply", depth: 2 });
    insert("hidden", "marker-1", { parentId: "root-high", depth: 1, status: "pending_audit" });
    insert("unrelated", "outside");
    connection.sqlite.exec(`
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active)
        VALUES ('root-high', 'viewer', 1, 1), ('reply', 'viewer', -1, 1), ('unrelated', 'viewer', 1, 1);
      INSERT INTO ugc_submission_flags (submission_id, user_id, active) VALUES ('root-high', 'viewer', 1);
    `);
    const comments = await listActiveCommentsByMarker(connection.db, {
      markerId: "marker-1",
      limit: 1,
      replyLimit: 3,
      viewerUserId: "viewer",
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: "root-high",
      score: 1,
      viewerVote: 1,
      flagged: true,
      replyCount: 1,
    });
    expect(comments[0]!.replies[0]).toMatchObject({ id: "reply", score: -1, replyCount: 1 });
    expect(comments[0]!.replies[0]!.replies.map((reply) => reply.id)).toEqual(["nested"]);
    for (const query of connection.queries) {
      const detail = connection.explain(query);
      expect(detail).not.toMatch(/SCAN ugc_submission_(votes|flags)\b/);
      expect(detail).toContain("idx_ugc_visible_comment_parent");
    }
  });

  it("supports 100 markers for private lists and viewer overlays", async () => {
    insert("public-comment", "marker-99");
    insert("pending-comment", "marker-99", { status: "pending_audit" });
    insert("public-image", "marker-99", { kind: "image" });
    insert("test-image", "marker-99", { kind: "image", filePath: "_test/image.webp" });
    connection.sqlite.exec(`
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active) VALUES ('public-comment', 'viewer', 1, 1);
      INSERT INTO ugc_submission_upvotes (submission_id, user_id, active) VALUES ('public-image', 'viewer', 1);
    `);
    const scope = {
      markerIds,
      userId: "viewer",
      excludePathPrefix: "_test",
      submissionIds: ["public-comment", "public-image", "test-image"],
    };
    const images = await listActiveImagesByMarker(connection.db, {
      ...scope,
      assetBaseUrl: "https://assets.example",
      viewerUserId: "viewer",
    });
    expect(images.map((image) => image.id)).toEqual(["public-image"]);
    expect(images[0]!.upvoted).toBe(true);
    const privateImages = await listUserImagesByMarker(connection.db, {
      ...scope,
      assetBaseUrl: "https://assets.example",
      privateAssetBaseUrl: "https://private.example",
    });
    expect(privateImages.map((image) => image.id)).toEqual(["public-image"]);
    expect(
      (await listImageViewerReactionsByMarker(connection.db, scope)).get("public-image")?.upvoted,
    ).toBe(true);
    expect(await listUserCommentsByMarker(connection.db, scope)).toHaveLength(2);
    const state = await listCommentViewerStateByMarker(connection.db, scope);
    expect(state.pendingComments.map((comment) => comment.id)).toEqual(["pending-comment"]);
    expect(state.reactions.get("public-comment")?.viewerVote).toBe(1);
    for (const query of connection.queries.filter((entry) => entry.sql.includes("ranked_images"))) {
      const detail = connection.explain(query);
      expect(detail).not.toContain("idx_ugc_submission_upvotes_active_created");
      expect(detail).toContain(
        "SEARCH ugc_submission_upvotes USING INDEX sqlite_autoindex_ugc_submission_upvotes_1 (submission_id=?)",
      );
    }
  });

  it("counts direct visible replies without loading reply trees when the limit is zero", async () => {
    insert("root", "marker-1");
    insert("reply", "marker-1", { parentId: "root", depth: 1 });
    insert("nested", "marker-1", { parentId: "reply", depth: 2 });
    insert("hidden", "marker-1", { parentId: "root", depth: 1, status: "stale" });
    const comments = await listActiveCommentsByMarker(connection.db, {
      markerId: "marker-1",
      replyLimit: 0,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: "root", replyCount: 1, replies: [] });
    expect(connection.queries).toHaveLength(1);
    expect(connection.queries[0]!.values).toHaveLength(3);
  });

  it("preserves per-parent reply limits, ordering, and hidden-ancestor exclusion", async () => {
    insert("root", "marker-1");
    for (const suffix of ["a", "b", "c"]) {
      insert(`reply-${suffix}`, "marker-1", { parentId: "root", depth: 1 });
      insert(`nested-${suffix}`, "marker-1", { parentId: "reply-a", depth: 2 });
    }
    insert("hidden", "marker-1", { parentId: "root", depth: 1, status: "pending_audit" });
    insert("hidden-child", "marker-1", { parentId: "hidden", depth: 2 });
    insert("excluded-child", "marker-1", { parentId: "reply-c", depth: 2 });
    const comments = await listActiveCommentsByMarker(connection.db, {
      markerId: "marker-1",
      replyLimit: 2,
    });
    expect(comments[0]!.replyCount).toBe(3);
    expect(comments[0]!.replies.map((reply) => reply.id)).toEqual(["reply-a", "reply-b"]);
    expect(comments[0]!.replies[0]!.replyCount).toBe(3);
    expect(comments[0]!.replies[0]!.replies.map((reply) => reply.id)).toEqual([
      "nested-a",
      "nested-b",
    ]);
    expect(JSON.stringify(comments)).not.toContain("hidden-child");
    expect(JSON.stringify(comments)).not.toContain("excluded-child");
  });

  it("skips empty image reactions but still loads the viewer's pending comments", async () => {
    insert("pending", "marker-1", { status: "pending_audit" });
    const payload = { userId: "viewer", markerIds: ["marker-1"], submissionIds: [] };
    expect(await listImageViewerReactionsByMarker(connection.db, payload)).toEqual(new Map());
    expect(connection.queries).toHaveLength(0);
    const state = await listCommentViewerStateByMarker(connection.db, payload);
    expect(state.pendingComments.map((comment) => comment.id)).toEqual(["pending"]);
    expect(state.reactions.size).toBe(0);
    expect(connection.queries).toHaveLength(1);
  });

  it("uses the pending-only index instead of walking a user's approved comment history", async () => {
    connection.sqlite.exec(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 10000
      )
      INSERT INTO ugc_submissions (id, poi_id, user_id, kind, status, created_at, poi_hash, poi_type, snapshot_id, content)
        SELECT 'history-' || number, 'marker-1', 'viewer', 'comment', 'active', '2026-09-05', 'hash', 'poi', 'snapshot-' || number, 'content'
        FROM sequence;
    `);
    insert("pending", "marker-1", { status: "pending_openai" });
    const state = await listCommentViewerStateByMarker(connection.db, {
      userId: "viewer",
      markerIds: ["marker-1"],
      submissionIds: [],
    });
    expect(state.pendingComments.map((comment) => comment.id)).toEqual(["pending"]);
    const query = connection.queries[0]!;
    const detail = connection.explain(query);
    expect(detail).toContain("idx_ugc_user_pending_comment");
    expect(detail).not.toMatch(/SCAN ugc_submissions\b/);
  });

  it("limits viewer reactions to returned IDs without leaking hidden, wrong-scope, or other-user state", async () => {
    for (const kind of ["image", "comment"] as const) {
      insert(`${kind}-shown`, "marker-1", { kind });
      insert(`${kind}-omitted`, "marker-1", { kind });
      insert(`${kind}-hidden`, "marker-1", { kind, status: "stale" });
      insert(`${kind}-outside`, "outside", { kind });
    }
    insert("test-image", "marker-1", { kind: "image", filePath: "_test/image.webp" });
    connection.sqlite.exec(`
      INSERT INTO ugc_submission_flags (submission_id, user_id, active)
        SELECT id, 'viewer', 1 FROM ugc_submissions;
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active) VALUES ('comment-shown', 'other-user', 1, 1);
      INSERT INTO ugc_submission_upvotes (submission_id, user_id, active) VALUES ('image-shown', 'other-user', 1);
    `);
    const payload = {
      userId: "viewer",
      markerIds: ["marker-1"],
      excludePathPrefix: "_test",
      submissionIds: [
        "image-shown",
        "image-hidden",
        "image-outside",
        "test-image",
        "comment-shown",
        "comment-hidden",
        "comment-outside",
      ],
    };
    expect(await listImageViewerReactionsByMarker(connection.db, payload)).toEqual(
      new Map([["image-shown", { flagged: true, upvoted: false }]]),
    );
    const state = await listCommentViewerStateByMarker(connection.db, payload);
    expect(state.reactions).toEqual(new Map([["comment-shown", { flagged: true, viewerVote: 0 }]]));
    for (const query of [connection.queries[0]!, connection.queries[2]!]) {
      const detail = connection.explain(query);
      expect(detail).toContain("SEARCH s USING INDEX sqlite_autoindex_ugc_submissions_1 (id=?)");
    }
  });

  it("checks translation visibility with one narrow submission lookup and no author join", async () => {
    insert("shown", "marker-1");
    insert("flagged", "marker-1", { status: "flagged" });
    insert("hidden", "marker-1", { status: "pending_audit" });
    insert("image", "marker-1", { kind: "image" });
    const comments = await getVisibleCommentsByIds(connection.db, [
      "shown",
      "flagged",
      "hidden",
      "image",
      "missing",
      "shown",
    ]);
    expect(comments.sort((first, second) => first.id.localeCompare(second.id))).toEqual([
      { id: "flagged", content: "content" },
      { id: "shown", content: "content" },
    ]);
    expect(connection.queries).toHaveLength(1);
    expect(connection.queries[0]!.sql).not.toMatch(/JOIN users|s\.\*/);
  });

  it.each(["requested", "empty"])(
    "keeps %s comment reads bounded with competing production indexes and no ANALYZE",
    async (markerId) => {
      connection.sqlite.exec(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 10000
      )
      INSERT INTO ugc_submissions (id, poi_id, user_id, kind, status, comment_depth, created_at, poi_hash, poi_type, snapshot_id, content)
        SELECT 'outside-' || number, 'outside', 'viewer', 'comment', 'active', 0, '2026-09-05', 'hash', 'poi', 'snapshot-' || number, 'content'
        FROM sequence;
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active)
        SELECT id, 'viewer', 1, 1 FROM ugc_submissions;
    `);
      insert("selected-root", "requested");
      insert("selected-reply", "requested", { parentId: "selected-root", depth: 1 });
      const result = await listActiveCommentsByMarker(connection.db, {
        markerId,
        limit: 1,
        replyLimit: 1,
      });
      expect(result).toHaveLength(markerId === "requested" ? 1 : 0);
      const query = connection.queries[0]!;
      const detail = connection.explain(query);
      expect(detail).not.toContain("idx_ugc_submission_votes_active_created");
      expect(detail).not.toMatch(/SCAN s USING INDEX|SCAN ugc_submissions\b/);
      expect(detail).toContain("SEARCH s USING INDEX sqlite_autoindex_ugc_submissions_1 (id=?)");
      expect(detail).toMatch(
        /SEARCH child USING (?:COVERING )?INDEX idx_ugc_visible_comment_parent \(parent_id=\?\)/,
      );
    },
  );

  it("marks 100 notification ids without crossing recipient/category boundaries", async () => {
    for (const notificationId of markerIds) {
      insertNotification(connection.sqlite, {
        id: notificationId,
        recipientUserId: "viewer",
        category: "community",
      });
    }
    insertNotification(connection.sqlite, {
      id: "other-user",
      recipientUserId: "another-user",
      category: "community",
    });
    insertNotification(connection.sqlite, {
      id: "other-category",
      recipientUserId: "viewer",
      category: "system",
    });
    expect(
      await markNotificationsRead(connection.db, {
        userId: "viewer",
        category: "community",
        ids: markerIds,
      }),
    ).toBe(100);
    expect(
      await markNotificationsRead(connection.db, {
        userId: "viewer",
        category: "community",
        ids: ["other-user", "other-category"],
      }),
    ).toBe(0);
    expect(
      connection.sqlite
        .prepare("SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL")
        .get()?.count,
    ).toBe(2);
    expect(connection.queries.every((query) => query.values.length === 4)).toBe(true);
  });
});
