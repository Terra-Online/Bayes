import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types/app";

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

  const id = c.env.PROGRESS_USER_DO.idFromName(user.uid);
  const stub = c.env.PROGRESS_USER_DO.get(id);
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

  const id = c.env.PROGRESS_STATS_DO.idFromName(markerIndexHash);
  const stub = c.env.PROGRESS_STATS_DO.get(id);
  const url = new URL("https://progress-stats/state");
  url.searchParams.set("markerIndexHash", markerIndexHash);
  return stub.fetch(new Request(url, { method: "GET" }));
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
