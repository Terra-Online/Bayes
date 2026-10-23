import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import type { ContributionItem } from "@/repositories/me";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let sessions: Map<string, ReturnType<typeof insertSession>>;

beforeEach(() => {
  database = createTestDatabase();
  sessions = new Map();
  for (const [uid, uidNumber] of [
    ["author", 123456],
    ["other", 123457],
  ] as const) {
    insertUser(database.sqlite, { uid, uid_number: uidNumber, uid_suffix: "AB" });
    insertAuthUser(database.sqlite, { id: uid });
    sessions.set(uid, insertSession(database.sqlite, { userId: uid }));
  }
  for (const [id, kind, status, createdAt] of [
    ["photo", "image", "active", "2026-09-02T10:00:00.000Z"],
    ["pending-photo", "image", "pending_openai", "2026-09-03T10:00:00.000Z"],
    ["review-comment", "comment", "pending_audit", "2026-09-03T10:00:00.000Z"],
    ["archived-comment", "comment", "stale", "2026-09-01T10:00:00.000Z"],
  ] as const) {
    insertSubmission(database.sqlite, { id, userId: "author", kind, status, createdAt });
  }
  insertSubmission(database.sqlite, {
    id: "someone-elses-photo",
    userId: "other",
    kind: "image",
    status: "pending_audit",
    createdAt: "2026-09-04T10:00:00.000Z",
  });
});

afterEach(() => database.close());

function request(path: string, uid = "author") {
  const app = new Hono<AppEnv>();
  app.onError(onAppError);
  app.route("/me/v1", createRoutes());
  return app.request(`http://localhost/me/v1${path}`, { headers: sessions.get(uid)?.headers }, {
    DB: database.db,
    ...testAuthConfig,
  } as AppEnv["Bindings"]);
}

type ContributionPage = { items: ContributionItem[]; nextCursor: string | null };

async function contributions(query = "", uid = "author"): Promise<ContributionPage> {
  const response = await request(`/contributions${query}`, uid);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toMatch(/^private, max-age=\d+, must-revalidate$/);
  expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  return response.json();
}

describe("personal contributions HTTP", () => {
  it("requires a session before showing a personal overview or contribution history", async () => {
    for (const path of ["/overview", "/contributions"]) {
      const response = await request(path, "");
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
    }
  });

  it("summarizes all of the owner's images, comments, and pending reviews with their public identity", async () => {
    const response = await request("/overview");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(
      /^private, max-age=\d+, must-revalidate$/,
    );
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
    expect(await response.json()).toMatchObject({
      user: { uid: "123456AB", nickname: "author", email: "author@example.test" },
      contributions: { imageCount: 2, commentCount: 2, pendingCount: 2 },
    });
    const other = await request("/overview", "other");
    expect(await other.json()).toMatchObject({
      user: { uid: "123457AB" },
      contributions: { imageCount: 1, commentCount: 0, pendingCount: 1 },
    });
  });

  it("continues the owner's contribution history across equal timestamps without including another owner's work", async () => {
    const first = await contributions("?limit=1");
    expect(first.items.map((item) => item.id)).toEqual(["review-comment"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await contributions(`?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((item) => item.id)).toEqual(["pending-photo"]);
    expect(second.nextCursor).toEqual(expect.any(String));
    const last = await contributions(`?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`);
    expect(last.items.map((item) => item.id)).toEqual(["photo", "archived-comment"]);
    expect(last.nextCursor).toBeNull();
    expect(last.items[0]).toMatchObject({
      kind: "image",
      previewUrl: "/me/v1/contributions/photo/preview",
      visibility: "public",
    });
    expect(last.items[1]).toMatchObject({
      kind: "comment",
      content: "Content archived-comment",
      previewUrl: null,
      visibility: "unavailable",
    });
  });

  it("keeps kind and review-status filters separate from cached pages and other owners", async () => {
    await contributions();
    const pending = await contributions("?kind=comment&status=pending_audit");
    expect(pending.items).toEqual([
      expect.objectContaining({
        id: "review-comment",
        visibility: "private",
        review: expect.objectContaining({ manual: true, published: false }),
      }),
    ]);
    expect(pending.nextCursor).toBeNull();
    expect((await contributions("?kind=comment&status=active")).items).toEqual([]);
    expect((await contributions("?kind=image&status=active")).items.map((item) => item.id)).toEqual(
      ["photo"],
    );
    expect((await contributions("?kind=comment&status=pending_audit", "other")).items).toEqual([]);
    expect(
      (await contributions("?kind=image&status=pending_audit", "other")).items.map(
        (item) => item.id,
      ),
    ).toEqual(["someone-elses-photo"]);
    expect(
      (await contributions("?kind=comment&status=pending_audit")).items.map((item) => item.id),
    ).toEqual(["review-comment"]);
  });

  it("keeps cached preview metadata private after both owners load their contribution lists", async () => {
    await contributions("?kind=image");
    await contributions("?kind=image", "other");
    for (const [id, uid] of [
      ["photo", "other"],
      ["someone-elses-photo", "author"],
      ["review-comment", "author"],
      ["missing", "author"],
    ]) {
      const response = await request(`/contributions/${id}/preview`, uid);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ code: "IMAGE_NOT_FOUND" });
    }
  });
});
