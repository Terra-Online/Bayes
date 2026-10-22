import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { onAppError } from "@/middleware/error-handler";
import { createRoutes } from "@/routes/me/createRoutes";
import { createMockBindings, createMockR2Object } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import type { AppEnv } from "@/types/app";

let database: TestDatabase;

afterEach(() => {
  database?.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps thumbnail traffic separate from auth reads and isolates authenticated users", async () => {
  // Keep the entire request sequence in one window without freezing async timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
  database = createTestDatabase();
  // The limiter's module-level windows survive database cleanup and test retries.
  const owner = insertAuthenticatedUser(database.sqlite, { uid: crypto.randomUUID() });
  const other = insertAuthenticatedUser(database.sqlite, { uid: crypto.randomUUID() });
  insertSubmission(database.sqlite, { id: "photo", userId: owner.user.uid, kind: "image" });

  const mocks = createMockBindings({ DB: database.db });
  mocks.ugcBucket.get.mockImplementation(async () => {
    const metadata = createMockR2Object({
      key: "images/photo.webp",
      size: 4,
      httpMetadata: { contentType: "image/webp" },
    });
    metadata.writeHttpMetadata.mockImplementation((headers) =>
      headers.set("Content-Type", "image/webp"),
    );
    // Each R2 read owns a fresh stream, as it does in production.
    const response = new Response(new Uint8Array([82, 73, 70, 70]));
    return {
      ...metadata,
      body: response.body!,
      get bodyUsed() {
        return response.bodyUsed;
      },
      arrayBuffer: () => response.arrayBuffer(),
      bytes: () => response.bytes(),
      text: () => response.text(),
      json: () => response.json(),
      blob: () => response.blob(),
    } satisfies R2ObjectBody;
  });
  const app = new Hono<AppEnv>();
  app.onError(onAppError);
  app.route("/me/v1", createRoutes());
  const request = async (
    path: string,
    headers: SessionHeaders = owner.headers,
  ): Promise<Response> =>
    runWithAuthRequest(() =>
      app.request(`http://localhost/me/v1${path}`, { headers }, mocks.bindings),
    );
  for (let i = 0; i < 300; i++) {
    expect((await request("/contributions/photo/preview")).status).toBe(200);
  }
  expect((await request("/contributions/photo/preview")).status).toBe(429);
  const overview = await request("/overview");
  expect(overview.status).toBe(200);
  expect(overview.headers.get("x-ratelimit-remaining")).toBe("119");
  for (let i = 1; i < 120; i++) {
    await request("/overview");
  }
  expect((await request("/overview")).status).toBe(429);
  expect((await request("/overview", other.headers)).status).toBe(200);
});
