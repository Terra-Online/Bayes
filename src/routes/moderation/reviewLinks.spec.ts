import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/betterAuth";
import { onAppError } from "@/middleware/error-handler";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));

describe("direct moderation review links", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
    insertUser(database.sqlite, { uid: "owner" });
  });
  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  async function request(submissionId: string, role = "a", authenticated = true) {
    const { headers } = insertAuthenticatedUser(database.sqlite, {
      uid: "reviewer",
      role,
      uid_number: 900001,
    });
    const mocks = createMockBindings({ DB: database.db });
    mocks.bindings.LOCK_MODERATION_ENDPOINTS = "false";
    mocks.authRateLimit.limit.mockResolvedValue({ success: true });
    const app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.route("/moderation/v1", createRoutes());
    return runWithAuthRequest(() =>
      app.request(
        `http://localhost/moderation/v1/pending?submissionId=${encodeURIComponent(submissionId)}&limit=1`,
        { headers: authenticated ? headers : undefined },
        mocks.bindings,
      ),
    );
  }

  it.each([
    ["image", "flagged"],
    ["image", "stale"],
    ["comment", "pending_audit"],
  ] as const)(
    "selects an old %s with current status %s beyond the queue limit",
    async (kind, status) => {
      insertSubmission(database.sqlite, {
        id: "earlier",
        userId: "owner",
        status: "pending_audit",
        createdAt: "2020-01-01 00:00:00",
      });
      insertSubmission(database.sqlite, {
        id: "target",
        userId: "owner",
        kind,
        status,
        createdAt: "2020-02-01 00:00:00",
      });
      const response = await request("target");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [{ id: "target", kind, status }],
        stats: { total: 1, byStatus: [{ status, count: 1 }] },
        limit: 1,
      });
    },
  );

  it("returns an empty result when the linked submission is missing", async () => {
    insertSubmission(database.sqlite, { id: "other", userId: "owner" });
    const response = await request("missing");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], stats: { total: 0 } });
  });

  it.each([
    ["a", false, 401],
    ["n", true, 403],
  ])(
    "retains moderation access checks for role %s and authenticated=%s",
    async (role, authenticated, status) => {
      const response = await request("target", role, authenticated);
      expect(response.status).toBe(status);
    },
  );
});
