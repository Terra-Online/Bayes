import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";

import { createApp } from "./app";

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
