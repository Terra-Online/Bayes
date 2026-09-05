import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/errors";
import { errorResponse } from "../services/progress/responses";
import type { AppEnv } from "../types/app";
import { onAppError, toApiError } from "./error-handler";

afterEach(() => vi.restoreAllMocks());

describe("dependency errors", () => {
  it.each([
    new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."),
    new Error("D1_ERROR", { cause: new Error("internal error; internal diagnostic") }),
    new Error("Connection closed: this Durable Object instance is no longer active."),
    new Error("Durable Object reset because its code was updated."),
    Object.assign(new Error("overloaded"), { overloaded: true })
  ])("returns an uncacheable 503 with backoff for %s", async (error) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.get("/", () => { throw error; });
    const response = await app.request("/");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain(error.message);
    const progressResponse = errorResponse(error);
    expect(progressResponse.status).toBe(503);
    expect(progressResponse.headers.get("retry-after")).toBe("5");
  });

  it("keeps business conflicts and programming errors distinct", async () => {
    const conflict = new ApiError(409, "PROGRESS_REVISION_CONFLICT", "stale", { current: { revision: "new" } });
    expect(toApiError(conflict)).toBe(conflict);
    expect(toApiError(new Error("D1_ERROR: UNIQUE constraint failed"))).toMatchObject({ status: 500 });
    const response = errorResponse(new Error("private SQL and internal identifiers"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private SQL");
    expect(await errorResponse(conflict).json()).toMatchObject({ details: { current: { revision: "new" } } });
  });
});
