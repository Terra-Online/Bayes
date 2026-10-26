import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/betterAuth";
import { onAppError } from "@/middleware/error-handler";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type AuthenticatedUserFixture } from "@/test/fixtures/auth";
import type { AppEnv } from "@/types/app";

import { createRoutes as createAccountAuthRoutes } from "./accountRoutes";

describe("provider-based unlink compatibility", () => {
  let database: TestDatabase;
  let app: Hono<AppEnv<{ requestId: string }>>;
  let external: MockBindings;
  let owner: AuthenticatedUserFixture;
  beforeEach(() => {
    database = createTestDatabase();
    external = createMockBindings({ DB: database.db });
    external.authRateLimit.limit.mockResolvedValue({ success: true });
    owner = insertAuthenticatedUser(database.sqlite, { uid: crypto.randomUUID() });
    insertAuthenticatedUser(database.sqlite, { uid: "other" });
    app = new Hono<AppEnv<{ requestId: string }>>();
    app.onError(onAppError);
    app.route("/auth/v1", createAccountAuthRoutes());
  });
  afterEach(() => database.close());
  function request(provider: string) {
    return runWithAuthRequest(() =>
      app.request(
        "/auth/v1/unlink-account",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...owner.headers },
          body: JSON.stringify({ provider }),
        },
        external.bindings,
      ),
    );
  }
  it.each(["github", "google", "discord", "email"])(
    "resolves %s to the owner's local account ID",
    async (provider) => {
      const storedProvider = provider === "email" ? "credential" : provider;
      database.sqlite
        .prepare("INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES (?,?,?,?)")
        .run("local-id", "external-id", storedProvider, owner.user.uid);
      database.sqlite
        .prepare("INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES (?,?,?,?)")
        .run("other-local", "other-external", storedProvider, "other");
      // Better Auth refuses the final login method, so retain a different provider.
      database.sqlite
        .prepare("INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES (?,?,?,?)")
        .run(
          "alternate",
          "alternate-external",
          provider === "github" ? "google" : "github",
          owner.user.uid,
        );
      const response = await request(provider);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: true });
      expect(database.sqlite.prepare("SELECT id FROM auth_accounts ORDER BY id").all()).toEqual([
        { id: "alternate" },
        { id: "other-local" },
      ]);
    },
  );
  it("does not select another user's account", async () => {
    database.sqlite.exec(
      "INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES ('other-id','external','github','other')",
    );
    const response = await request("github");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
    expect(database.sqlite.prepare("SELECT id FROM auth_accounts ORDER BY id").all()).toEqual([
      { id: "other-id" },
    ]);
  });
  it("rejects ambiguous provider bindings", async () => {
    database.sqlite
      .prepare(
        "INSERT INTO auth_accounts(id,accountId,providerId,userId) VALUES ('a','external-a','github',?),('b','external-b','github',?)",
      )
      .run(owner.user.uid, owner.user.uid);
    const response = await request("github");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_CONFLICT" });
    expect(database.sqlite.prepare("SELECT id FROM auth_accounts ORDER BY id").all()).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });
});
