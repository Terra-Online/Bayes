import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "@/lib/auth/createAuth";
import { onAppError } from "@/middleware/error-handler";
import type { AppEnv, Bindings } from "@/types/app";

import { forwardToAuthJsonPath } from "./forwarding";

vi.mock("@/lib/auth/createAuth", () => ({ createAuth: vi.fn() }));
vi.mock("@/lib/auth/browserSession", () => ({
  resolveBrowserSessionHeaders: (_auth: unknown, headers: Headers) => ({ headers }),
}));

describe("authentication conflict boundaries", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());
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
        const app = new Hono<AppEnv>();
        app.onError(onAppError);
        app.post(publicPath, (c) => forwardToAuthJsonPath(c, authPath, {}));
        const response = await app.request(publicPath, { method: "POST" }, {} as Bindings);
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
    const app = new Hono<AppEnv>();
    app.post("/register", (c) => forwardToAuthJsonPath(c, "/sign-in/email-otp", {}));
    const response = await app.request("/register", { method: "POST" }, {} as Bindings);
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
    const app = new Hono<AppEnv>();
    app.post("/register", (c) => forwardToAuthJsonPath(c, "/sign-in/email-otp", {}));
    expect((await app.request("/register", { method: "POST" }, {} as Bindings)).status).toBe(409);
    expect((await app.request("/register", { method: "POST" }, {} as Bindings)).status).toBe(500);
  });
});
