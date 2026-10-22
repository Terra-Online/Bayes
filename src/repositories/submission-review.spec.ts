import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import { listAllImageFilePaths } from "./submission-review";

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "author" });
});
afterEach(() => database.close());

it("keeps every referenced image path across pages, including archived images, without duplicate or comment-only references", async () => {
  // Cross a full page so an archived reference must survive cursor pagination.
  const expectedPaths = Array.from(
    { length: 1001 },
    (_, index) => `images/${String(index).padStart(4, "0")}.webp`,
  );
  for (const [index, filePath] of expectedPaths.entries()) {
    insertSubmission(database.sqlite, {
      id: `image-${index}`,
      userId: "author",
      kind: "image",
      filePath,
      status: index === 1000 ? "stale" : "active",
    });
  }
  insertSubmission(database.sqlite, {
    id: "shared-path",
    userId: "author",
    kind: "image",
    filePath: expectedPaths[0],
  });
  insertSubmission(database.sqlite, {
    id: "comment",
    userId: "author",
    filePath: "comment-only.webp",
  });
  const before = database.sqlite.prepare("SELECT COUNT(*) AS count FROM ugc_submissions").get();
  const paths = await listAllImageFilePaths(database.db);
  expect(paths).toHaveLength(1001);
  expect(new Set(paths)).toEqual(new Set(expectedPaths));
  expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM ugc_submissions").get()).toEqual(
    before,
  );
});
