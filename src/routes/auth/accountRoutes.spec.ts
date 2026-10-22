import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createTestDatabase } from "@/test/database/createTestDatabase";
import type { AppEnv, AuthUser, Bindings } from "@/types/app";

import { createRoutes as createAccountAuthRoutes } from "./accountRoutes";

vi.mock("@/middleware/auth", () => ({
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("@/middleware/rate-limit", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

describe("provider-based unlink compatibility", () => {
  let database: ReturnType<typeof createTestDatabase>;
  let app: Hono<AppEnv<{ authUser?: AuthUser; requestId: string }>>;
  const forward = vi.fn(async () => new Response("{}"));
  beforeEach(() => {
    forward.mockClear();
    database = createTestDatabase();
    database.sqlite.exec(
      "INSERT INTO auth_users(id,name,email) VALUES ('owner','Owner','owner@example.com'),('other','Other','other@example.com')",
    );
    app = new Hono<AppEnv<{ authUser?: AuthUser; requestId: string }>>();
    app.onError(onAppError);
    app.use("*", async (c, next) => {
      c.set("authUser", { uid: "owner" } as AuthUser);
      await next();
    });
    app.route("/", createAccountAuthRoutes({ forwardToAuthJsonPath: forward }));
  });
  afterEach(() => database.close());
  function request(provider: string) {
    return app.request(
      "/unlink-account",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      },
      { DB: database.db } as Bindings,
    );
  }
  it.each(["github", "google", "discord", "email"])(
    "resolves %s to the owner's local account ID",
    async (provider) => {
      const storedProvider = provider === "email" ? "credential" : provider;
      database.sqlite
        .prepare("INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES (?,?,?,?)")
        .run("local-id", "external-id", storedProvider, "owner");
      database.sqlite
        .prepare("INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES (?,?,?,?)")
        .run("other-local", "other-external", storedProvider, "other");
      expect((await request(provider)).status).toBe(200);
      expect(forward).toHaveBeenCalledWith(expect.anything(), "/unlink-account", {
        accountId: "local-id",
      });
    },
  );
  it("does not select another user's account", async () => {
    database.sqlite.exec(
      "INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES ('other-id','external','github','other')",
    );
    const response = await request("github");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
    expect(forward).not.toHaveBeenCalled();
  });
  it("rejects ambiguous provider bindings", async () => {
    database.sqlite.exec(
      "INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES ('a','external-a','github','owner'),('b','external-b','github','owner')",
    );
    const response = await request("github");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_CONFLICT" });
    expect(forward).not.toHaveBeenCalled();
  });
});
