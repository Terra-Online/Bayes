import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import { createApp } from "./app";
import worker from "./index";

// This Node suite exercises HTTP/CORS/auth. Unused native service bindings fail loudly.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor() {
      throw new Error("Unexpected native entrypoint construction");
    }
  },
  DurableObject: class {
    constructor() {
      throw new Error("Unexpected native object construction");
    }
  },
  exports: new Proxy(
    {},
    {
      get: (_target, key) => {
        throw new Error(`Unexpected native binding: ${String(key)}`);
      },
    },
  ),
}));

let database: TestDatabase;
afterEach(() => {
  database?.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser cross-origin access", () => {
  it("allows a configured frontend and rejects untrusted origins on preflights and private errors", async () => {
    const backend = "https://api.example.test";
    const origin = "https://preview.example.test";
    database = createTestDatabase();
    const env = {
      ...createMockBindings({ DB: database.db }).bindings,
      BETTER_AUTH_URL: backend,
      CORS_ORIGINS: origin,
    };
    const app = createApp();
    const preflight = await app.request(
      `${backend}/auth/v1/profile`,
      {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "authorization,content-type",
        },
      },
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
    const rejected = await app.request(
      `${backend}/auth/v1/profile`,
      {
        method: "OPTIONS",
        headers: { origin: "https://attacker.example", "access-control-request-method": "PATCH" },
      },
      env,
    );
    expect(rejected.headers.get("access-control-allow-origin")).not.toBe(
      "https://attacker.example",
    );
    const privateResponse = await app.request(
      `${backend}/auth/v1/session`,
      { headers: { origin } },
      env,
    );
    expect(privateResponse.status).toBe(401);
    expect(privateResponse.headers.get("access-control-allow-origin")).toBe(origin);
    expect(privateResponse.headers.get("cache-control")).toBe("private, no-store");
    const directClient = await app.request(`${backend}/auth/v1/session`, {}, env);
    expect(directClient.status).toBe(401);
    expect(await directClient.json()).toMatchObject({ code: "SESSION_REQUIRED" });
  });
});

it("keeps the profile and session readable after a failed profile write and allows retry", async () => {
  database = createTestDatabase();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const owner = insertAuthenticatedUser(database.sqlite, {
    uid: "profile-owner",
    nickname: "ProfileOwner",
    uid_number: 123456,
    uid_suffix: "AB",
    avt: 7,
  });
  const external = createMockBindings({ DB: database.db });
  external.authRateLimit.limit.mockResolvedValue({ success: true });
  const app = createApp();
  const session = () =>
    app.request("http://localhost/auth/v1/session", { headers: owner.headers }, external.bindings);
  expect((await session()).status).toBe(200);
  const original = database.sqlite.prepare("SELECT * FROM users WHERE uid = ?").get(owner.user.uid);
  async function update(nickname: string, avatar: number): Promise<Response> {
    return app.request(
      "http://localhost/auth/v1/profile",
      {
        method: "PATCH",
        headers: { ...owner.headers, "content-type": "application/json" },
        body: JSON.stringify({ nickname, avatar }),
      },
      external.bindings,
    );
  }
  database.hooks.beforeQuery = (sql) => {
    if (/^UPDATE users\s+SET nickname/i.test(sql)) {
      throw new Error("profile storage unavailable");
    }
  };
  const failed = await update("ChangedName", 33);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({ code: "PROFILE_UPDATE_FAILED" });
  database.hooks.beforeQuery = undefined;
  expect(database.sqlite.prepare("SELECT * FROM users WHERE uid = ?").get(owner.user.uid)).toEqual(
    original,
  );
  expect(await (await session()).json()).toMatchObject({
    user: { nickname: "ProfileOwner", avatar: 7 },
  });
  const retried = await update("ChangedName", 33);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({
    user: { uid: "123456AB", nickname: "ChangedName", avatar: 33 },
  });
  expect(await (await session()).json()).toMatchObject({
    user: { nickname: "ChangedName", avatar: 33 },
  });
});

it("fails privately for missing auth configuration and resumes the existing session after configuration recovery", async () => {
  database = createTestDatabase();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const owner = insertAuthenticatedUser(database.sqlite, { uid: "configured-owner" });
  const env = createMockBindings({ DB: database.db }).bindings;
  const secret = env.BETTER_AUTH_SECRET;
  const before = database.sqlite.prepare("SELECT * FROM users").all();
  const app = createApp();
  for (const invalid of [undefined, "   "]) {
    env.BETTER_AUTH_SECRET = invalid;
    const response = await app.request(
      "http://localhost/auth/v1/session",
      { headers: owner.headers },
      env,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(body).not.toContain("BETTER_AUTH_SECRET");
    expect(database.sqlite.prepare("SELECT * FROM users").all()).toEqual(before);
  }
  env.BETTER_AUTH_SECRET = secret;
  const recovered = await app.request(
    "http://localhost/auth/v1/session",
    { headers: owner.headers },
    env,
  );
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ user: { nickname: owner.user.nickname } });
});

it("keeps progress delivery and moderation backfill independent through job locks and read failures", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-23T12:01:00Z");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "explorer" });
  const mocks = createMockBindings({ DB: database.db });
  const delivered: unknown[] = [];
  mocks.statsObjects.getByName.mockImplementation(
    (name) =>
      ({
        name,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          delivered.push(await new Request(input, init).json());
          return Response.json({ ok: true });
        },
      }) as DurableObjectStub,
  );
  const hash = "a".repeat(64);
  const event = {
    eventId: "pending-event",
    markerIndexHash: hash,
    pointCount: 2,
    increments: [0],
    decrements: [],
    firstSync: true,
  };
  database.sqlite
    .prepare(`INSERT INTO progress_stats_outbox
    (event_id,uid,mutation_id,marker_index_hash,payload,status,next_attempt_at,created_at)
    VALUES ('pending-event','explorer','offline-write',?,?,'pending',?,?)`)
    .run(hash, JSON.stringify(event), Date.now(), Date.now());
  const env = { ...mocks.bindings, LOCK_SCHEDULED_JOBS: "true" };
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledEvent, env, {
    waitUntil: (work: Promise<unknown>) => waits.push(work),
  } as unknown as ExecutionContext);
  await Promise.all(waits);
  expect(delivered).toEqual([event]);
  expect(database.sqlite.prepare("SELECT status FROM progress_stats_outbox").all()).toEqual([
    { status: "processed" },
  ]);
  expect(mocks.autoModerationQueue.send).not.toHaveBeenCalled();

  // Optional jobs resume independently when a progress read fails. Redis reports
  // a future evaluation cycle; the real moderation backfill still runs.
  env.LOCK_SCHEDULED_JOBS = "false";
  mocks.bindings.UPSTASH_REDIS_REST_URL = "https://redis.example.test";
  env.UPSTASH_REDIS_REST_URL = mocks.bindings.UPSTASH_REDIS_REST_URL;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/redis\.example\.test\//);
    const commands = JSON.parse(String(init?.body)) as string[][];
    return Response.json(
      commands.map(([command]) => {
        if (command !== "get") {
          throw new Error(`Unexpected Redis command: ${command}`);
        }
        return { result: JSON.stringify({ cursor: null, nextRunAt: Date.now() + 86_400_000 }) };
      }),
    );
  });
  mocks.autoModerationQueue.send.mockResolvedValue({
    metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } },
  });
  insertSubmission(database.sqlite, {
    id: "awaiting-review",
    userId: "explorer",
    status: "pending_openai",
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  database.hooks.beforeQuery = (sql) => {
    if (sql.includes("progress_stats_outbox")) {
      throw new Error("temporary progress read outage");
    }
  };
  waits.length = 0;
  await worker.scheduled({} as ScheduledEvent, env, {
    waitUntil: (work: Promise<unknown>) => waits.push(work),
  } as unknown as ExecutionContext);
  await Promise.allSettled(waits);
  expect(mocks.autoModerationQueue.send).toHaveBeenCalledWith(
    expect.objectContaining({ submissionId: "awaiting-review", source: "scheduled_backfill" }),
  );
  database.hooks.beforeQuery = undefined;
  waits.length = 0;
  await worker.scheduled({} as ScheduledEvent, env, {
    waitUntil: (work: Promise<unknown>) => waits.push(work),
  } as unknown as ExecutionContext);
  await Promise.all(waits);
  expect(mocks.autoModerationQueue.send).toHaveBeenCalledTimes(1);
});
