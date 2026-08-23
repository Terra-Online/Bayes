import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError } from "../../lib/errors";
import { fetchProgressStatsFromWorkersCache } from "../../middleware/cache/publicReadClient";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import {
  isSha256Hex,
  normalizeManifestPayload,
  saveProgressManifest
} from "../../services/progress/manifest";
import {
  normalizeArchiveManifestPayload,
  saveArchiveProgressManifest
} from "../../services/progress/archiveManifest";
import { jsonResponse } from "../../services/progress/responses";
import type { AppEnv } from "../../types/app";

function isProgressLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

async function proxyUserProgress(
  c: Context<AppEnv>,
  path: "state" | "sync"
): Promise<Response> {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }

  const stub = c.env.OEM_USER_DO.getByName(user.uid);
  const url = new URL(`https://progress-user/${path}`);
  if (path === "state") {
    const markerIndexHash = c.req.query("markerIndexHash")?.trim().toLowerCase() ?? "";
    url.searchParams.set("markerIndexHash", markerIndexHash);
  }

  const request = path === "state"
    ? new Request(url, { method: "GET" })
    : new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await c.req.text()
    });

  return stub.fetch(request);
}

async function proxyUserArchiveProgress(
  c: Context<AppEnv>,
  path: "state" | "sync"
): Promise<Response> {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }

  const stub = c.env.OEM_USER_DO.getByName(user.uid);
  const url = new URL(`https://progress-user/archive/${path}`);
  if (path === "state") {
    const archiveIndexHash = c.req.query("archiveIndexHash")?.trim().toLowerCase() ?? "";
    url.searchParams.set("archiveIndexHash", archiveIndexHash);
  }
  return stub.fetch(path === "state"
    ? new Request(url, { method: "GET" })
    : new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await c.req.text()
    }));
}

async function registerManifest(c: Context<AppEnv>): Promise<Response> {
  const manifest = await normalizeManifestPayload(await c.req.json().catch(() => null));
  await saveProgressManifest(c.env, manifest);
  return jsonResponse({
    ok: true,
    manifest: { markerIndexHash: manifest.markerIndexHash }
  });
}

async function registerArchiveManifest(c: Context<AppEnv>): Promise<Response> {
  const manifest = await normalizeArchiveManifestPayload(await c.req.json().catch(() => null));
  await saveArchiveProgressManifest(c.env, manifest);
  return jsonResponse({
    ok: true,
    manifest: { archiveIndexHash: manifest.archiveIndexHash }
  });
}

async function proxyStats(c: Context<AppEnv>): Promise<Response> {
  const markerIndexHash = c.req.query("markerIndexHash")?.trim().toLowerCase();
  if (!markerIndexHash || !isSha256Hex(markerIndexHash)) {
    throw new ApiError(422, "VALIDATION_ERROR", "markerIndexHash must be a SHA-256 hash.");
  }
  return fetchProgressStatsFromWorkersCache(markerIndexHash);
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
  app.post("/manifest", requireAuth, registerManifest);
  app.post("/sync", requireAuth, async (c) => proxyUserProgress(c, "sync"));
  app.get("/stats", rateLimit("public"), async (c) => proxyStats(c));
  app.get("/archive/state", requireAuth, async (c) => proxyUserArchiveProgress(c, "state"));
  app.post("/archive/manifest", requireAuth, registerArchiveManifest);
  app.post("/archive/sync", requireAuth, async (c) => proxyUserArchiveProgress(c, "sync"));

  return app;
}
