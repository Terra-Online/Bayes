import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createUGCImageDatabase } from "../test/ugcImageDatabase";
import { getContributionImage, listContributions } from "./me";

let database: ReturnType<typeof createUGCImageDatabase>;
beforeEach(() => {
  database = createUGCImageDatabase();
  database.sqlite.exec(`
    ALTER TABLE ugc_submissions ADD COLUMN mime_type TEXT;
    ALTER TABLE ugc_submissions ADD COLUMN poi_type TEXT DEFAULT 'sample';
    ALTER TABLE ugc_submissions ADD COLUMN moderation_note TEXT;
    ALTER TABLE ugc_submissions ADD COLUMN snapshot_id TEXT DEFAULT 'current';
    ALTER TABLE ugc_submissions ADD COLUMN updated_at TEXT DEFAULT '2026-09-05T12:00:00Z';
    ${readFileSync(new URL("../../migrations/0035_ugc_review_events.sql", import.meta.url), "utf8")}
    CREATE TABLE notification_messages (submission_id TEXT, dedupe_key TEXT UNIQUE, created_at TEXT);
  `);
});
afterEach(() => database.sqlite.close());

const list = () =>
  listContributions(database.db, {
    uid: "author",
    limit: 20,
    previewBaseUrl: "/me/v1/contributions",
  });
function event(
  id: string,
  from: string,
  to: string,
  snapshot = "current",
  at = "2026-09-04T12:00:00Z",
) {
  database.sqlite
    .prepare("INSERT INTO notification_messages VALUES (?, ?, ?)")
    .run(id, `system:${id}:${snapshot}:${from}:${to}`, at);
}

it("returns portable preview paths and retains complete comment content", async () => {
  const content = "**a long comment** ".repeat(30);
  database.sqlite
    .prepare("UPDATE ugc_submissions SET kind = 'comment', content = ? WHERE id = 'mine'")
    .run(content);
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.previewUrl).toBe(
    "/me/v1/contributions/photo/preview",
  );
  expect(items.find((item) => item.id === "mine")).toMatchObject({ content, previewUrl: null });
});

it("retains a completed manual review for the current published snapshot only", async () => {
  event("photo", "pending_openai", "pending_audit");
  event("mine", "pending_openai", "pending_audit", "old-edit");
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.review).toMatchObject({
    manual: true,
    published: true,
  });
  expect(items.find((item) => item.id === "mine")?.review).toMatchObject({
    manual: false,
    published: true,
  });
});

it("distinguishes an archived public submission from one recalled before approval", async () => {
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'stale'");
  event("photo", "pending_openai", "pending_audit");
  event("photo", "pending_audit", "active");
  event("photo", "active", "stale");
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.review).toMatchObject({
    manual: true,
    published: true,
  });
  expect(items.find((item) => item.id === "mine")?.review).toMatchObject({
    manual: false,
    published: false,
  });
});

it("recognizes an ongoing manual review before any notification is available", async () => {
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'pending_audit' WHERE id = 'photo'");
  expect((await list()).items.find((item) => item.id === "photo")?.review).toMatchObject({
    manual: true,
    published: false,
  });
});

it("returns real decision times without borrowing a previous snapshot's timestamps", async () => {
  event("photo", "pending_openai", "pending_audit", "current", "2026-09-02T12:00:00Z");
  event("photo", "pending_audit", "active", "current", "2026-09-03T12:00:00Z");
  event("mine", "pending_audit", "active", "old-edit", "2026-09-02T10:00:00Z");
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'stale' WHERE id = 'photo'");
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.review.times).toEqual({
    uploaded: "2026-09-01",
    ai: "2026-09-02T12:00:00Z",
    manual: "2026-09-03T12:00:00Z",
    public: "2026-09-03T12:00:00Z",
    archived: "2026-09-05T12:00:00Z",
  });
  expect(items.find((item) => item.id === "mine")?.review.times.public).toBeNull();
});

const paths: Array<[string, Array<[string, string, string]>, string[]]> = [
  ["stale", [["pending_openai", "stale", "manual_moderation"]], ["uploaded", "manual", "archived"]],
  ["stale", [["pending_openai", "stale", "auto_moderation"]], ["uploaded", "ai", "archived"]],
  ["stale", [["pending_openai", "stale", "user_action"]], ["uploaded", "archived"]],
  [
    "stale",
    [
      ["pending_openai", "pending_audit", "auto_moderation"],
      ["pending_audit", "stale", "manual_moderation"],
    ],
    ["uploaded", "ai", "manual", "archived"],
  ],
  [
    "stale",
    [
      ["pending_openai", "pending_audit", "auto_moderation"],
      ["pending_audit", "stale", "user_action"],
    ],
    ["uploaded", "ai", "archived"],
  ],
  ["active", [["pending_openai", "active", "manual_moderation"]], ["uploaded", "manual", "public"]],
  ["active", [["pending_openai", "active", "auto_moderation"]], ["uploaded", "ai", "public"]],
  [
    "stale",
    [
      ["pending_openai", "active", "auto_moderation"],
      ["active", "stale", "user_action"],
    ],
    ["uploaded", "ai", "public", "archived"],
  ],
  [
    "stale",
    [
      ["pending_openai", "active", "auto_moderation"],
      ["flagged", "stale", "manual_moderation"],
    ],
    ["uploaded", "ai", "public", "manual", "archived"],
  ],
  [
    "active",
    [
      ["pending_openai", "stale", "manual_moderation"],
      ["stale", "active", "manual_moderation"],
    ],
    ["uploaded", "manual", "archived", "manual", "public"],
  ],
  [
    "pending_audit",
    [["pending_openai", "pending_audit", "auto_moderation"]],
    ["uploaded", "ai", "manual"],
  ],
];
it.each(paths)("reconstructs %s from actual decisions: %j", async (status, events, expected) => {
  database.sqlite.prepare("UPDATE ugc_submissions SET status = ? WHERE id = 'photo'").run(status);
  events.forEach(([from, to, source], index) => {
    database.sqlite
      .prepare(`INSERT INTO ugc_review_events
      (submission_id, snapshot_id, from_status, to_status, source, created_at)
      VALUES ('photo', 'current', ?, ?, ?, ?)`)
      .run(from, to, source, `2026-09-0${index + 2}T12:00:00Z`);
  });
  // Events from a different edit must never become part of this path.
  database.sqlite.exec(`INSERT INTO ugc_review_events
    (submission_id, snapshot_id, from_status, to_status, source, created_at)
    VALUES ('photo', 'old-edit', 'pending_openai', 'active', 'auto_moderation', '2026-09-01')`);
  const review = (await list()).items.find((item) => item.id === "photo")?.review;
  expect(review?.path.map((step) => step.key)).toEqual(expected);
});

it("keeps a historical publication with an unknown approval time, without inventing AI review", async () => {
  const review = (await list()).items.find((item) => item.id === "photo")?.review;
  expect(review?.path).toEqual([
    { key: "uploaded", at: "2026-09-01" },
    { key: "public", at: null },
  ]);
});

it.each([
  ["OpenAI moderation passed: clean", "stale", ["uploaded", "ai", "public", "archived"]],
  ["OpenAI moderation needs audit: flagged", "active", ["uploaded", "ai", "manual", "public"]],
  [
    "OpenAI moderation flagged: unsafe",
    "active",
    ["uploaded", "ai", "archived", "manual", "public"],
  ],
])(
  "uses old moderation evidence without inventing decision times: %s",
  async (note, status, expected) => {
    database.sqlite
      .prepare("UPDATE ugc_submissions SET status = ?, moderation_note = ? WHERE id = 'photo'")
      .run(status, note);
    const path = (await list()).items.find((item) => item.id === "photo")?.review.path;
    expect(path?.map((step) => step.key)).toEqual(expected);
    expect(path?.find((step) => step.key === "ai")?.at).toBeNull();
  },
);

it("omits AI when automation explicitly bypasses AI review", async () => {
  database.sqlite.exec(`UPDATE ugc_submissions SET status = 'pending_audit' WHERE id = 'photo';
    INSERT INTO ugc_review_events
      (submission_id, snapshot_id, from_status, to_status, source, created_at, ai_reviewed)
      VALUES ('photo', 'current', 'pending_openai', 'pending_audit', 'auto_moderation', '2026-09-04', 0)`);
  expect(
    (await list()).items.find((item) => item.id === "photo")?.review.path.map((step) => step.key),
  ).toEqual(["uploaded", "manual"]);
});

it("keeps the latest restored publication time instead of the first approval", async () => {
  event("photo", "pending_openai", "active", "current", "2026-09-02T12:00:00Z");
  database.sqlite.exec(`INSERT INTO ugc_review_events
    (submission_id, snapshot_id, from_status, to_status, source, created_at)
    VALUES ('photo', 'current', 'pending_openai', 'active', 'auto_moderation', '2026-09-02T12:00:00Z'),
           ('photo', 'current', 'active', 'stale', 'user_action', '2026-09-03T12:00:00Z'),
           ('photo', 'current', 'stale', 'active', 'manual_moderation', '2026-09-04T12:00:00Z')`);
  expect((await list()).items.find((item) => item.id === "photo")?.review.times.public).toBe(
    "2026-09-04T12:00:00Z",
  );
});

it("reuses list file metadata for previews without bypassing owner checks", async () => {
  await list();
  const prepare = vi.spyOn(database.db, "prepare");
  expect(await getContributionImage(database.db, "author", "photo")).toMatchObject({
    file_path: "images/photo.webp",
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(await getContributionImage(database.db, "other", "photo")).toBeNull();
  expect(prepare).toHaveBeenCalledOnce();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  await getContributionImage(database.db, "author", "photo");
  expect(prepare).toHaveBeenCalledTimes(2);
  vi.restoreAllMocks();
});

it("does not share an unfinished preview lookup with another invocation", async () => {
  const prepare = database.db.prepare.bind(database.db);
  let rejectFirst!: (error: Error) => void;
  vi.spyOn(database.db, "prepare")
    .mockImplementationOnce(
      () =>
        ({
          bind() {
            return this;
          },
          first: () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            }),
        }) as unknown as D1PreparedStatement,
    )
    .mockImplementation(prepare);
  const first = getContributionImage(database.db, "author", "photo");
  const rejected = expect(first).rejects.toThrow("first request failed");
  expect(await getContributionImage(database.db, "author", "photo")).toMatchObject({
    file_path: "images/photo.webp",
  });
  rejectFirst(new Error("first request failed"));
  await rejected;
  expect(await getContributionImage(database.db, "author", "photo")).toMatchObject({
    file_path: "images/photo.webp",
  });
  vi.restoreAllMocks();
});
