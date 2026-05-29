import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError } from "../lib/errors";
import { getJsonFromKv, putJsonToKv } from "../lib/kv-cache";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types/app";

const PROGRESS_STATS_KV_TTL_SECONDS = 10;
const PROGRESS_STATS_KV_KEY_PREFIX = "progress:stats:v1:";

function isProgressLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

async function proxyUserProgress(
  c: Context<AppEnv>,
  path: "state" | "sync" | "manifest"
): Promise<Response> {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }

  const id = c.env.OEM_USER_DO.idFromName(user.uid);
  const stub = c.env.OEM_USER_DO.get(id);
  const url = new URL(`https://progress-user/${path}`);
  url.searchParams.set("uid", user.uid);

  const request = path === "state"
    ? new Request(url, { method: "GET" })
    : new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await c.req.text()
    });

  return stub.fetch(request);
}

async function proxyStats(c: Context<AppEnv>): Promise<Response> {
  const markerIndexHash = c.req.query("markerIndexHash")?.trim().toLowerCase();
  if (!markerIndexHash) {
    throw new ApiError(422, "VALIDATION_ERROR", "markerIndexHash is required.");
  }

  const kvKey = `${PROGRESS_STATS_KV_KEY_PREFIX}${markerIndexHash}`;
  const cached = await getJsonFromKv<unknown>(c.env.OEM_KV, kvKey);
  if (cached) {
    const response = c.json(cached);
    response.headers.set("Cache-Control", `public, max-age=${PROGRESS_STATS_KV_TTL_SECONDS}`);
    response.headers.set("x-oem-kv-cache", "hit");
    return response;
  }

  const id = c.env.OEM_STATS_DO.idFromName(markerIndexHash);
  const stub = c.env.OEM_STATS_DO.get(id);
  const url = new URL("https://progress-stats/state");
  url.searchParams.set("markerIndexHash", markerIndexHash);
  const response = await stub.fetch(new Request(url, { method: "GET" }));
  if (!response.ok) {
    return response;
  }

  const payload = await response.clone().json().catch(() => null);
  if (payload) {
    await putJsonToKv(c.env.OEM_KV, kvKey, payload, {
      expirationTtl: PROGRESS_STATS_KV_TTL_SECONDS
    }).catch(() => undefined);
  }

  const nextResponse = c.json(payload);
  nextResponse.headers.set("Cache-Control", `public, max-age=${PROGRESS_STATS_KV_TTL_SECONDS}`);
  nextResponse.headers.set("x-oem-kv-cache", "miss");
  return nextResponse;
}

export function createProgressRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    if (isProgressLocked(c.env.LOCK_PROGRESS_ENDPOINTS)) {
      throw new ApiError(
        503,
        "PROGRESS_TEMPORARILY_DISABLED",
        "Progress endpoints are temporarily disabled during stabilization."
      );
    }
    await next();
  });

  app.get("/state", requireAuth, async (c) => proxyUserProgress(c, "state"));
  app.post("/manifest", requireAuth, async (c) => proxyUserProgress(c, "manifest"));
  app.post("/sync", requireAuth, async (c) => proxyUserProgress(c, "sync"));
  app.get("/stats", rateLimit("public"), async (c) => proxyStats(c));

  return app;
}
