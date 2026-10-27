import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, invokeBetterAuthHandler } from "@/lib/auth/betterAuth";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { Bindings } from "@/types/app";

vi.mock("@/lib/auth/betterAuth/createAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/betterAuth/createAuth")>()),
  createAuth: vi.fn(),
}));
// Specialist library boundary: the installed Better Auth version cannot naturally
// produce every supported throw/onError/opaque-response combination. Browser header
// handling and conflict classification execute normally (no cookie in these cases).

describe("authentication conflict boundaries", () => {
  let database: TestDatabase;
  let env: Bindings;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(createAuth).mockReset();
    database = createTestDatabase();
    env = createMockBindings({ DB: database.db }).bindings;
  });
  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });
  it.each(["throw", "response", "captured_throw"])(
    "classifies exact conflicts from an auth %s",
    async (mode) => {
      for (const [publicPath, authPath, constraint, status, code] of [
        ["/register", "/sign-in/email-otp", "auth_users.email", 409, "USER_ALREADY_EXISTS"],
        ["/register", "/sign-in/email-otp", "auth_verifications.identifier", 400, "INVALID_OTP"],
        [
          "/send",
          "/email-otp/send-verification-otp",
          "auth_verifications.identifier",
          429,
          "RATE_LIMITED",
        ],
      ] as const) {
        const error = new Error("query failed", {
          cause: new Error(`D1_ERROR: UNIQUE constraint failed: ${constraint}: SQLITE_CONSTRAINT`),
        });
        vi.mocked(createAuth).mockImplementation(
          (_env, options) =>
            ({
              handler: async () => {
                if (mode === "throw") {
                  throw error;
                }
                options?.onError?.(error);
                if (mode === "captured_throw") {
                  throw new Error("opaque server failure");
                }
                return new Response("opaque server failure", { status: 500 });
              },
            }) as unknown as ReturnType<typeof createAuth>,
        );
        const response = await invokeBetterAuthHandler(
          env,
          new Request(`https://auth.example.test/auth/v1${authPath}`, { method: "POST" }),
          { publicPath, authPath, requestId: "conflict-test" },
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
        expect(response.headers.get("retry-after")).toBe(status === 429 ? "1" : null);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    },
  );
  it.each([
    "UNIQUE constraint failed: auth_accounts.accountId",
    "UNIQUE constraint failed: auth_users.email, auth_users.name",
    "D1_ERROR: no such table: auth_users",
  ])("preserves other database failures: %s", async (message) => {
    vi.mocked(createAuth).mockImplementation(
      (_env, options) =>
        ({
          handler: async () => {
            options?.onError?.(new Error(message));
            return new Response("opaque", { status: 500 });
          },
        }) as unknown as ReturnType<typeof createAuth>,
    );
    const response = await invokeBetterAuthHandler(
      env,
      new Request("https://auth.example.test/auth/v1/sign-in/email-otp", { method: "POST" }),
      { publicPath: "/register", authPath: "/sign-in/email-otp", requestId: "conflict-test" },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("opaque");
  });
  it("keeps captured errors private to one invocation", async () => {
    let calls = 0;
    vi.mocked(createAuth).mockImplementation(
      (_env, options) =>
        ({
          handler: async () => {
            if (calls++ === 0) {
              options?.onError?.(new Error("UNIQUE constraint failed: auth_users.email"));
            }
            return new Response("opaque", { status: 500 });
          },
        }) as unknown as ReturnType<typeof createAuth>,
    );
    const invoke = () =>
      invokeBetterAuthHandler(
        env,
        new Request("https://auth.example.test/auth/v1/sign-in/email-otp", { method: "POST" }),
        { publicPath: "/register", authPath: "/sign-in/email-otp", requestId: "conflict-test" },
      );
    expect((await invoke()).status).toBe(409);
    expect((await invoke()).status).toBe(500);
  });
});
