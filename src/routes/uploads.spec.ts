import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/errors";
import { onAppError } from "../middleware/error-handler";
import type { AppEnv, AuthUser } from "../types/app";
import { createUGCImageDatabase } from "../test/ugcImageDatabase";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("../lib/auth/createAuth", () => ({
  createAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => (
        headers.get("authorization") === "Bearer viewer"
          ? { user: { id: "viewer", email: "viewer@example.com", name: "Viewer" } }
          : null
      )
    }
  })
}));
vi.mock("../middleware/auth", async () => {
  const { ApiError } = await import("../lib/errors");
  return {
    resolveContextAuthUser: async (c: { get: (key: string) => unknown }) => {
      const user = c.get("authUser") as AuthUser | undefined;
      if (!user) {
        throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
      }
      return user;
    }
  };
});
vi.mock("../services/upload/commentTranslation", () => ({
  translateVisibleComments: vi.fn(async () => ({ items: [] }))
}));

import { createUploadRoutes } from "./uploads";

const activeUser: AuthUser = {
  uid: "author",
  publicUid: "000001AA",
  role: "n",
  karma: 0,
  avatar: 0,
  email: "active@example.com",
  nickname: "Active",
  needsProfileSetup: false
};

const suspendedUser: AuthUser = {
  ...activeUser,
  uid: "suspended-user",
  role: "s"
};

let sqlite: ReturnType<typeof createUGCImageDatabase>["sqlite"];
let db: D1Database;

beforeEach(() => {
  const database = createUGCImageDatabase();
  sqlite = database.sqlite;
  db = database.db;
});

afterEach(() => sqlite.close());

function request(path: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  prefix?: string;
  user?: AuthUser;
  locked?: string;
  productionErrors?: boolean;
} = {}) {
  const app = new Hono<AppEnv>();
  app.onError(options.productionErrors
    ? onAppError
    : (error, _c) => {
      if (error instanceof ApiError) {
        return new Response(JSON.stringify({ code: error.code }), { status: error.status });
      }
      throw error;
    });
  if (options.user) {
    app.use("*", async (c, next) => {
      c.set("authUser", options.user!);
      await next();
    });
  }
  app.route("/uploads/v1", createUploadRoutes());
  return app.request(
    "http://localhost/uploads/v1" + path,
    {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body
    },
    {
      DB: db,
      LOCK_UPLOAD_ENDPOINTS: options.locked ?? "true",
      UGC_UPLOAD_TEST_PREFIX: options.prefix ?? "",
      UGC_ASSET_BASE_URL: "https://assets.example.com",
      BETTER_AUTH_URL: "https://api.example.com",
      OEM_PUBLIC_RATE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as AppEnv["Bindings"]
  );
}

describe("upload route policies", () => {
  it('keeps "/images/mine" authenticated even when an image has ID "mine"', async () => {
    expect((await request("/images/mine")).status).toBe(401);
    const response = await request("/images/mine?markerId=42", {
      headers: { authorization: "Bearer owner" },
      user: activeUser
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { items: Array<{ id: string }> };
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
    ["GET", "/images/photo/extra"]
  ])("applies explicit middleware to %s %s", async (method, path) => {
    const anonymous = await request(path, { method });
    expect(anonymous.status).toBe(method === "GET" ? 404 : 401);
    const active = await request(path, { method, user: activeUser });
    expect(active.status).toBe(method === "GET" ? 404 : 503);
    const suspended = await request(path, { method, user: suspendedUser });
    expect(suspended.status).toBe(method === "GET" ? 404 : 403);
  });

  it("allows public reads for a suspended user while uploads are locked", async () => {
    expect((await request("/images/photo?markerId=42", { user: suspendedUser })).status).toBe(200);
  });

  it("registers direct comment context as a public no-store read", async () => {
    const response = await request("/comments/target", { productionErrors: true });

    expect(response.status).toBe(422);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.each(["/images/mine", "/comments/mine", "/file/private.webp"])(
    "protects private read %s",
    async (path) => {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, { user: suspendedUser })).status).toBe(403);
    }
  );

  it("returns a normal 404 for unknown upload paths while locked", async () => {
    expect((await request("/unknown")).status).toBe(404);
    expect((await request("/images/photo/extra")).status).toBe(404);
  });

  it("keeps cached translation public and protects live translation", async () => {
    const body = JSON.stringify({ commentIds: ["comment"], targetLanguage: "en-US" });
    const cached = await request("/comments/translations", {
      method: "POST",
      body: JSON.stringify({ commentIds: ["comment"], targetLanguage: "en-US", cachedOnly: true }),
      headers: { "content-type": "application/json" }
    });
    expect(cached.status).toBe(200);

    const anonymousLive = await request("/comments/translations", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" }
    });
    expect(anonymousLive.status).toBe(401);
    expect((await request("/comments/translations", {
      method: "POST",
      user: suspendedUser,
      body,
      headers: { "content-type": "application/json" }
    })).status).toBe(403);
    expect((await request("/comments/translations", {
      method: "POST",
      user: activeUser,
      body,
      headers: { "content-type": "application/json" }
    })).status).toBe(200);
  });

  it("validates translation payloads before requiring live-translation access", async () => {
    const response = await request("/comments/translations", {
      method: "POST",
      body: JSON.stringify({ commentIds: [] }),
      headers: { "content-type": "application/json" }
    });
    expect(response.status).toBe(422);
    expect((await request("/comments/translations", {
      method: "POST",
      user: suspendedUser,
      body: JSON.stringify({ commentIds: [] }),
      headers: { "content-type": "application/json" }
    })).status).toBe(422);
  });
});
