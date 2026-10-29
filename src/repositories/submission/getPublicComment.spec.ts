import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";

import { getPublicCommentContextById } from "./getPublicComment";

let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "author" });
});
afterEach(() => database.close());

describe("public comment context query plan", () => {
  it("uses the comment thread index to traverse descendants", async () => {
    insertSubmission(database.sqlite, { id: "target", userId: "author" });
    insertSubmission(database.sqlite, {
      id: "reply",
      userId: "author",
      parentId: "target",
      depth: 1,
    });

    importCurrentSubmissions(database);
    await getPublicCommentContextById(database.db, { id: "target", markerId: "marker-1" });

    // This is a SQL access-path guarantee; result ordering is covered through HTTP.
    const descendants = database.queries.find((query) => query.sql.includes("reply_context AS"));
    expect(descendants).toBeDefined();
    expect(database.explain(descendants!)).not.toMatch(
      /MATERIALIZE ugc_public_submissions|SCAN f\b/,
    );
    expect(database.explain(descendants!)).toMatch(
      /idx_ugc_(comment_parent|kind_poi_parent_created)/,
    );
  });
});
