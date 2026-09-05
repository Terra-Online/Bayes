import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listActiveCommentsByMarker, listCommentViewerStateByMarker, listUserCommentsByMarker } from "./listComments";
import { listActiveImagesByMarker, listImageViewerReactionsByMarker, listUserImagesByMarker } from "./listImages";
import { markNotificationsRead } from "../notifications";
import { getVisibleCommentsByIds } from "./statusSubmission";
import { UGC_COMPETING_INDEXES_SQL } from "../../test/ugcIndexes";

describe("public read SQL under D1 limits", () => {
  let sqlite: DatabaseSync;
  let database: D1Database;
  let queries: Array<{ sql: string; values: SQLInputValue[] }>;
  const markerIds = Array.from({ length: 100 }, (_, index) => `marker-${index}`);

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    queries = [];
    sqlite.exec(`
      CREATE TABLE users (
        uid TEXT PRIMARY KEY, uid_number INTEGER, uid_suffix TEXT,
        role TEXT, karma INTEGER, nickname TEXT, avt INTEGER
      );
      INSERT INTO users VALUES ('viewer', 1, 'test', 'n', 0, 'Viewer', 1);
      CREATE TABLE ugc_submissions (
        id TEXT PRIMARY KEY, poi_id TEXT, poi_hash TEXT, poi_type TEXT, snapshot_id TEXT,
        user_id TEXT, content TEXT, file_path TEXT, kind TEXT, status TEXT,
        parent_id TEXT, comment_depth INTEGER, created_at TEXT, updated_at TEXT
      );
      CREATE INDEX idx_marker ON ugc_submissions(poi_id, kind, status);
      CREATE INDEX idx_ugc_user_kind_poi_created
        ON ugc_submissions(user_id, kind, poi_id, created_at DESC, id DESC);
      ${UGC_COMPETING_INDEXES_SQL}
      CREATE TABLE ugc_submission_votes (
        submission_id TEXT, user_id TEXT, value INTEGER, active INTEGER,
        created_at TEXT DEFAULT '2026-09-05',
        PRIMARY KEY (submission_id, user_id)
      );
      CREATE INDEX idx_ugc_submission_votes_active_created
        ON ugc_submission_votes(active, created_at);
      CREATE TABLE ugc_submission_flags (
        submission_id TEXT, user_id TEXT, active INTEGER,
        PRIMARY KEY (submission_id, user_id)
      );
      CREATE TABLE ugc_submission_upvotes (
        submission_id TEXT, user_id TEXT, active INTEGER,
        created_at TEXT DEFAULT '2026-09-05',
        PRIMARY KEY (submission_id, user_id)
      );
      CREATE INDEX idx_ugc_submission_upvotes_active_created
        ON ugc_submission_upvotes(active, created_at);
      CREATE TABLE notifications (id TEXT PRIMARY KEY, recipient_user_id TEXT, category TEXT, read_at TEXT);
      ${readFileSync(new URL("../../../migrations/0032_visible_comment_parent_index.sql", import.meta.url), "utf8")}
      ${readFileSync(new URL("../../../migrations/0034_pending_comment_overlay_index.sql", import.meta.url), "utf8")}
    `);
    const prepare = (sql: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
      bind: (...bindings: unknown[]) => {
        expect(bindings.length).toBeLessThanOrEqual(100);
        return prepare(sql, bindings as SQLInputValue[]);
      },
      run: async () => {
        queries.push({ sql, values });
        const named = Object.fromEntries(values.map((value, index) => [`${index + 1}`, value]));
        const result = sqlite.prepare(sql).run(named);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
      all: async () => {
        queries.push({ sql, values });
        const statement = sqlite.prepare(sql);
        statement.setAllowBareNamedParameters(true);
        const named = Object.fromEntries(values.map((value, index) => [`${index + 1}`, value]));
        return { success: true, results: statement.all(named), meta: {} };
      }
    }) as unknown as D1PreparedStatement;
    database = {
      prepare,
      batch: (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.all()))
    } as unknown as D1Database;
  });

  afterEach(() => sqlite.close());

  function insert(id: string, markerId: string, options: {
    parentId?: string; depth?: number; kind?: string; status?: string; filePath?: string;
  } = {}) {
    sqlite.prepare(`INSERT INTO ugc_submissions VALUES (
      ?, ?, 'hash', 'poi', ?, 'viewer', 'content', ?, ?, ?, ?, ?, '2026-09-05', '2026-09-05'
    )`).run(id, markerId, `snapshot-${id}`, options.filePath ?? `prod/${id}.webp`,
      options.kind ?? "comment", options.status ?? "active", options.parentId ?? null, options.depth ?? 0);
  }

  it("loads 100 markers and more than 100 reply roots without excess SQL parameters", async () => {
    for (const markerId of markerIds) {
      for (const suffix of ["a", "b"]) {
        const rootId = `${markerId}-${suffix}`;
        insert(rootId, markerId);
        insert(`${rootId}-reply`, markerId, { parentId: rootId, depth: 1 });
      }
    }
    const comments = await listActiveCommentsByMarker(database, {
      markerIds, limit: 2, replyLimit: 3, viewerUserId: "viewer"
    });
    expect(comments).toHaveLength(200);
    expect(comments.every((comment) => comment.replyCount === 1 && comment.replies.length === 1)).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries.every((query) => query.values.length === 4)).toBe(true);
  });

  it("preserves vote ranking, nested replies, visibility, and indexed reaction lookups", async () => {
    insert("root-low", "marker-1");
    insert("root-high", "marker-1");
    insert("reply", "marker-1", { parentId: "root-high", depth: 1 });
    insert("nested", "marker-1", { parentId: "reply", depth: 2 });
    insert("hidden", "marker-1", { parentId: "root-high", depth: 1, status: "pending_audit" });
    insert("unrelated", "outside");
    sqlite.exec(`
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active)
        VALUES ('root-high', 'viewer', 1, 1), ('reply', 'viewer', -1, 1), ('unrelated', 'viewer', 1, 1);
      INSERT INTO ugc_submission_flags VALUES ('root-high', 'viewer', 1);
    `);
    const comments = await listActiveCommentsByMarker(database, {
      markerId: "marker-1", limit: 1, replyLimit: 3, viewerUserId: "viewer"
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: "root-high", score: 1, viewerVote: 1, flagged: true, replyCount: 1 });
    expect(comments[0]!.replies[0]).toMatchObject({ id: "reply", score: -1, replyCount: 1 });
    expect(comments[0]!.replies[0]!.replies.map((reply) => reply.id)).toEqual(["nested"]);
    for (const query of queries) {
      const named = Object.fromEntries(query.values.map((value, index) => [`${index + 1}`, value]));
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(named);
      const detail = plan.map((row) => String(row.detail)).join("\n");
      expect(detail).not.toMatch(/SCAN ugc_submission_(votes|flags)\b/);
      expect(detail).toContain("idx_ugc_visible_comment_parent");
    }
  });

  it("supports 100 markers for private lists and viewer overlays", async () => {
    insert("public-comment", "marker-99");
    insert("pending-comment", "marker-99", { status: "pending_audit" });
    insert("public-image", "marker-99", { kind: "image" });
    insert("test-image", "marker-99", { kind: "image", filePath: "_test/image.webp" });
    sqlite.exec(`
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active) VALUES ('public-comment', 'viewer', 1, 1);
      INSERT INTO ugc_submission_upvotes (submission_id, user_id, active) VALUES ('public-image', 'viewer', 1);
    `);
    const scope = {
      markerIds, userId: "viewer", excludePathPrefix: "_test",
      submissionIds: ["public-comment", "public-image", "test-image"]
    };
    const images = await listActiveImagesByMarker(database, {
      ...scope, assetBaseUrl: "https://assets.example", viewerUserId: "viewer"
    });
    expect(images.map((image) => image.id)).toEqual(["public-image"]);
    expect(images[0]!.upvoted).toBe(true);
    const privateImages = await listUserImagesByMarker(database, {
      ...scope, assetBaseUrl: "https://assets.example", privateAssetBaseUrl: "https://private.example"
    });
    expect(privateImages.map((image) => image.id)).toEqual(["public-image"]);
    expect((await listImageViewerReactionsByMarker(database, scope)).get("public-image")?.upvoted).toBe(true);
    expect(await listUserCommentsByMarker(database, scope)).toHaveLength(2);
    const state = await listCommentViewerStateByMarker(database, scope);
    expect(state.pendingComments.map((comment) => comment.id)).toEqual(["pending-comment"]);
    expect(state.reactions.get("public-comment")?.viewerVote).toBe(1);
    for (const query of queries.filter((entry) => entry.sql.includes("ranked_images"))) {
      const named = Object.fromEntries(query.values.map((value, index) => [`${index + 1}`, value]));
      const detail = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(named).map((row) => String(row.detail)).join("\n");
      expect(detail).not.toContain("idx_ugc_submission_upvotes_active_created");
      expect(detail).toContain("SEARCH ugc_submission_upvotes USING INDEX sqlite_autoindex_ugc_submission_upvotes_1 (submission_id=?)");
    }
  });

  it("counts direct visible replies without loading reply trees when the limit is zero", async () => {
    insert("root", "marker-1");
    insert("reply", "marker-1", { parentId: "root", depth: 1 });
    insert("nested", "marker-1", { parentId: "reply", depth: 2 });
    insert("hidden", "marker-1", { parentId: "root", depth: 1, status: "rejected" });
    const comments = await listActiveCommentsByMarker(database, { markerId: "marker-1", replyLimit: 0 });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: "root", replyCount: 1, replies: [] });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.values).toHaveLength(3);
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
    const comments = await listActiveCommentsByMarker(database, { markerId: "marker-1", replyLimit: 2 });
    expect(comments[0]!.replyCount).toBe(3);
    expect(comments[0]!.replies.map((reply) => reply.id)).toEqual(["reply-a", "reply-b"]);
    expect(comments[0]!.replies[0]!.replyCount).toBe(3);
    expect(comments[0]!.replies[0]!.replies.map((reply) => reply.id)).toEqual(["nested-a", "nested-b"]);
    expect(JSON.stringify(comments)).not.toContain("hidden-child");
    expect(JSON.stringify(comments)).not.toContain("excluded-child");
  });

  it("skips empty image reactions but still loads the viewer's pending comments", async () => {
    insert("pending", "marker-1", { status: "pending_audit" });
    const payload = { userId: "viewer", markerIds: ["marker-1"], submissionIds: [] };
    expect(await listImageViewerReactionsByMarker(database, payload)).toEqual(new Map());
    expect(queries).toHaveLength(0);
    const state = await listCommentViewerStateByMarker(database, payload);
    expect(state.pendingComments.map((comment) => comment.id)).toEqual(["pending"]);
    expect(state.reactions.size).toBe(0);
    expect(queries).toHaveLength(1);
  });

  it("uses the pending-only index instead of walking a user's approved comment history", async () => {
    sqlite.exec(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 10000
      )
      INSERT INTO ugc_submissions (id, poi_id, user_id, kind, status, created_at)
        SELECT 'history-' || number, 'marker-1', 'viewer', 'comment', 'active', '2026-09-05'
        FROM sequence;
    `);
    insert("pending", "marker-1", { status: "pending_openai" });
    const state = await listCommentViewerStateByMarker(database, {
      userId: "viewer", markerIds: ["marker-1"], submissionIds: []
    });
    expect(state.pendingComments.map((comment) => comment.id)).toEqual(["pending"]);
    const query = queries[0]!;
    const named = Object.fromEntries(query.values.map((value, index) => [`${index + 1}`, value]));
    const detail = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(named).map((row) => String(row.detail)).join("\n");
    expect(detail).toContain("idx_ugc_user_pending_comment");
    expect(detail).not.toMatch(/SCAN ugc_submissions\b/);
  });

  it("limits viewer reactions to returned IDs without leaking hidden, wrong-scope, or other-user state", async () => {
    for (const kind of ["image", "comment"]) {
      insert(`${kind}-shown`, "marker-1", { kind });
      insert(`${kind}-omitted`, "marker-1", { kind });
      insert(`${kind}-hidden`, "marker-1", { kind, status: "rejected" });
      insert(`${kind}-outside`, "outside", { kind });
    }
    insert("test-image", "marker-1", { kind: "image", filePath: "_test/image.webp" });
    sqlite.exec(`
      INSERT INTO ugc_submission_flags
        SELECT id, 'viewer', 1 FROM ugc_submissions;
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active) VALUES ('comment-shown', 'other-user', 1, 1);
      INSERT INTO ugc_submission_upvotes (submission_id, user_id, active) VALUES ('image-shown', 'other-user', 1);
    `);
    const payload = {
      userId: "viewer", markerIds: ["marker-1"], excludePathPrefix: "_test",
      submissionIds: ["image-shown", "image-hidden", "image-outside", "test-image",
        "comment-shown", "comment-hidden", "comment-outside"]
    };
    expect(await listImageViewerReactionsByMarker(database, payload)).toEqual(new Map([
      ["image-shown", { flagged: true, upvoted: false }]
    ]));
    const state = await listCommentViewerStateByMarker(database, payload);
    expect(state.reactions).toEqual(new Map([["comment-shown", { flagged: true, viewerVote: 0 }]]));
    for (const query of [queries[0]!, queries[2]!]) {
      const named = Object.fromEntries(query.values.map((value, index) => [`${index + 1}`, value]));
      const detail = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(named).map((row) => String(row.detail)).join("\n");
      expect(detail).toContain("SEARCH s USING INDEX sqlite_autoindex_ugc_submissions_1 (id=?)");
    }
  });

  it("checks translation visibility with one narrow submission lookup and no author join", async () => {
    insert("shown", "marker-1");
    insert("flagged", "marker-1", { status: "flagged" });
    insert("hidden", "marker-1", { status: "pending_audit" });
    insert("image", "marker-1", { kind: "image" });
    const comments = await getVisibleCommentsByIds(database, ["shown", "flagged", "hidden", "image", "missing", "shown"]);
    expect(comments.sort((first, second) => first.id.localeCompare(second.id)))
      .toEqual([{ id: "flagged", content: "content" }, { id: "shown", content: "content" }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).not.toMatch(/JOIN users|s\.\*/);
  });

  it.each(["requested", "empty"])("keeps %s comment reads bounded with competing production indexes and no ANALYZE", async (markerId) => {
    sqlite.exec(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 10000
      )
      INSERT INTO ugc_submissions (id, poi_id, user_id, kind, status, comment_depth, created_at)
        SELECT 'outside-' || number, 'outside', 'viewer', 'comment', 'active', 0, '2026-09-05'
        FROM sequence;
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active)
        SELECT id, 'viewer', 1, 1 FROM ugc_submissions;
    `);
    insert("selected-root", "requested");
    insert("selected-reply", "requested", { parentId: "selected-root", depth: 1 });
    const result = await listActiveCommentsByMarker(database, { markerId, limit: 1, replyLimit: 1 });
    expect(result).toHaveLength(markerId === "requested" ? 1 : 0);
    const query = queries[0]!;
    const named = Object.fromEntries(query.values.map((value, index) => [`${index + 1}`, value]));
    const detail = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(named).map((row) => String(row.detail)).join("\n");
    expect(detail).not.toContain("idx_ugc_submission_votes_active_created");
    expect(detail).not.toMatch(/SCAN s USING INDEX|SCAN ugc_submissions\b/);
    expect(detail).toContain("SEARCH s USING INDEX sqlite_autoindex_ugc_submissions_1 (id=?)");
    expect(detail).toMatch(/SEARCH child USING (?:COVERING )?INDEX idx_ugc_visible_comment_parent \(parent_id=\?\)/);
  });

  it("marks 100 notification ids without crossing recipient/category boundaries", async () => {
    const insertNotification = sqlite.prepare("INSERT INTO notifications VALUES (?, ?, ?, NULL)");
    for (const notificationId of markerIds) insertNotification.run(notificationId, "viewer", "community");
    insertNotification.run("other-user", "another-user", "community");
    insertNotification.run("other-category", "viewer", "system");
    expect(await markNotificationsRead(database, { userId: "viewer", category: "community", ids: markerIds })).toBe(100);
    expect(await markNotificationsRead(database, {
      userId: "viewer", category: "community", ids: ["other-user", "other-category"]
    })).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL").get()?.count).toBe(2);
    expect(queries.every((query) => query.values.length === 4)).toBe(true);
  });
});
