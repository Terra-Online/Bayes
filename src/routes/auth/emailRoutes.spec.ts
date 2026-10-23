import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { onAppError } from "@/middleware/error-handler";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes as createEmailRoutes } from "./emailRoutes";
import { createRoutes as createPasswordResetRoutes } from "./passwordResetRoutes";

vi.mock("@/lib/email/blacklist.json", () => ({ default: ["disposable.example.test"] }));

describe("email authentication HTTP behavior", () => {
  let database: TestDatabase;
  let env: Bindings;
  let app: Hono<AppEnv<{ requestId: string }>>;
  let delivery: MockBindings["idMails"]["send"];
  let testNumber = 0;
  let testIp: string;

  beforeEach(() => {
    database = createTestDatabase();
    vi.useFakeTimers({ toFake: ["Date"] });
    testIp = `198.51.100.${++testNumber}`;
    const external = createMockBindings({ DB: database.db });
    external.publicRateLimit.limit.mockResolvedValue({ success: true });
    delivery = external.idMails.send.mockResolvedValue({ messageId: "delivered" });
    env = {
      ...external.bindings,
      BETTER_AUTH_URL: "https://api.opendfieldmap.org",
      EMAIL_PROVIDER_MODE: "cloudflare_only",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    };
    // Only the external Redis endpoint is substituted. Rate limiting, auth,
    // templates, delivery orchestration and migrated SQLite remain real.
    const cooldowns = new Map<string, number>();
    const windows = new Map<string, Map<string, number>>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://redis.example.test/")) {
        throw new Error(`Unexpected external request: ${url}`);
      }
      const commands = JSON.parse(String(init?.body)) as [string, string, ...unknown[]][];
      return Response.json(
        commands.map(([command, key, ...args]) => {
          if (command === "set") {
            if ((cooldowns.get(key) ?? 0) > Date.now()) {
              return { result: null };
            }
            const ex = args.indexOf("ex");
            cooldowns.set(key, Date.now() + Number(args[ex + 1]) * 1000);
            return { result: "OK" };
          }
          if (command === "ttl") {
            return { result: Math.ceil(((cooldowns.get(key) ?? Date.now()) - Date.now()) / 1000) };
          }
          const entries = windows.get(key) ?? new Map<string, number>();
          windows.set(key, entries);
          if (command === "zremrangebyscore") {
            let removed = 0;
            for (const [member, score] of entries) {
              if (score >= Number(args[0]) && score <= Number(args[1])) {
                entries.delete(member);
                removed += 1;
              }
            }
            return { result: removed };
          }
          if (command === "zcard") {
            return { result: entries.size };
          }
          if (command === "zadd") {
            entries.set(String(args[1]), Number(args[0]));
            return { result: 1 };
          }
          if (command === "expire") {
            return { result: 1 };
          }
          throw new Error(`Unconfigured Redis command: ${command}`);
        }),
      );
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    app = new Hono<AppEnv<{ requestId: string }>>()
      .use("*", (_c, next) => runWithAuthRequest(next))
      .onError(onAppError);
    app.route("/auth/v1", createEmailRoutes());
    app.route("/auth/v1", createPasswordResetRoutes());
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function storedIdentity() {
    return {
      users: database.sqlite.prepare("SELECT * FROM auth_users ORDER BY id").all(),
      accounts: database.sqlite.prepare("SELECT * FROM auth_accounts ORDER BY id").all(),
      sessions: database.sqlite.prepare("SELECT * FROM auth_sessions ORDER BY id").all(),
    };
  }

  it("returns a validation response instead of forwarding a consumed email sign-in body", async () => {
    const response = await app.request(
      "https://api.opendfieldmap.org/auth/v1/sign-in/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": testIp },
        body: "{",
      },
      env,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(storedIdentity()).toEqual({ users: [], accounts: [], sessions: [] });
    expect(delivery).not.toHaveBeenCalled();
  });
});
