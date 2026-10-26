import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import {
  insertAuthenticatedUser,
  insertAuthUser,
  insertSession,
  type SeededSession,
} from "@/test/fixtures/auth";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

let database: TestDatabase;
let mocks: MockBindings;
let app: ReturnType<typeof createApp>;
let activeSession: SeededSession;
let suspendedSession: SeededSession;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
  insertAuthUser(database.sqlite, { id: "author" });
  activeSession = insertSession(database.sqlite, { userId: "author" });
  suspendedSession = insertAuthenticatedUser(database.sqlite, { uid: "suspended-user", role: "s" });
  mocks = createMockBindings({ DB: database.db });
  mocks.publicRateLimit.limit.mockResolvedValue({ success: true });
  app = createApp();
});

afterEach(() => {
  database.close();
  vi.restoreAllMocks();
});

function request(path: string, options: RequestInit = {}) {
  return app.request("http://localhost/uploads/v1" + path, options, {
    ...mocks.bindings,
    LOCK_UPLOAD_ENDPOINTS: "true",
    UGC_UPLOAD_TEST_PREFIX: "",
    UGC_ASSET_BASE_URL: "https://assets.example.com",
  });
}

describe("upload route policies", () => {
  it('keeps "/images/mine" authenticated even when an image has ID "mine"', async () => {
    expect((await request("/images/mine")).status).toBe(401);
    const response = await request("/images/mine?markerId=42", {
      headers: activeSession.headers,
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { items: Array<{ id: string }> };
    expect(payload).not.toHaveProperty("item");
    expect(payload.items.map((item) => item.id)).toContain("photo");
  });

  it.each([
    ["POST", "/images"],
    ["POST", "/comments"],
    ["POST", "/comments/comment/upvote"],
    ["POST", "/comments/comment/downvote"],
    ["POST", "/comments/comment/flag"],
    ["POST", "/comments/comment/unflag"],
    ["POST", "/comments/comment/edit"],
    ["POST", "/comments/comment/remove-request"],
    ["POST", "/comments/comment/recall"],
    ["POST", "/images/photo/upvote"],
    ["POST", "/images/photo/unvote"],
    ["POST", "/images/photo/flag"],
    ["POST", "/images/photo/unflag"],
    ["POST", "/images/photo/remove-request"],
    ["POST", "/images/photo/unrecall"],
    ["POST", "/images/photo/recall"],
    ["GET", "/images/photo/extra"],
  ])("applies explicit middleware to %s %s", async (method, path) => {
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all();
    const anonymous = await request(path, { method });
    expect(anonymous.status).toBe(method === "GET" ? 404 : 401);
    const active = await request(path, { method, headers: activeSession.headers });
    expect(active.status).toBe(method === "GET" ? 404 : 503);
    const suspended = await request(path, { method, headers: suspendedSession.headers });
    expect(suspended.status).toBe(method === "GET" ? 404 : 403);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all()).toEqual(
      before,
    );
    expect(mocks.autoModerationQueue.send).not.toHaveBeenCalled();
    expect(mocks.ugcBucket.put).not.toHaveBeenCalled();
  });

  it("allows public reads for a suspended user while uploads are locked", async () => {
    expect(
      (await request("/images/photo?markerId=42", { headers: suspendedSession.headers })).status,
    ).toBe(200);
  });

  it("registers direct comment context as a public no-store read", async () => {
    const response = await request("/comments/target?markerId=42");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "COMMENT_NOT_FOUND" });
  });

  it.each(["/images/mine", "/images?includeMine=1", "/comments/mine", "/file/private.webp"])(
    "protects private read %s",
    async (path) => {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, { headers: suspendedSession.headers })).status).toBe(403);
    },
  );

  it("returns a normal 404 for unknown upload paths while locked", async () => {
    expect((await request("/unknown")).status).toBe(404);
    expect((await request("/point-images?markerId=42")).status).toBe(404);
    expect((await request("/images/photo/extra")).status).toBe(404);
  });

  it("keeps cached translation public and protects live translation", async () => {
    // No matching comment is seeded: exercise real translation policy without a provider call.
    const body = JSON.stringify({ commentIds: ["comment"], targetLanguage: "en-US" });
    const cached = await request("/comments/translations", {
      method: "POST",
      body: JSON.stringify({ commentIds: ["comment"], targetLanguage: "en-US", cachedOnly: true }),
      headers: { "content-type": "application/json" },
    });
    expect(cached.status).toBe(200);

    const anonymousLive = await request("/comments/translations", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(anonymousLive.status).toBe(401);
    expect(
      (
        await request("/comments/translations", {
          method: "POST",
          body,
          headers: { ...suspendedSession.headers, "content-type": "application/json" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/comments/translations", {
          method: "POST",
          body,
          headers: { ...activeSession.headers, "content-type": "application/json" },
        })
      ).status,
    ).toBe(200);
  });
});
