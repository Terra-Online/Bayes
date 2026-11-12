import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { ApiError } from "@/lib/errors";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { fetchProgressStatsFromWorkersCache } from "@/publicRead/client/client";
import {
  apiErrorSchema,
  jsonResponse as documentedJsonResponse,
  operation,
  sessionSecurity,
} from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/progress";
import {
  normalizeArchiveManifestPayload,
  saveArchiveProgressManifest,
} from "@/services/progress/archiveManifest";
import {
  isSha256Hex,
  normalizeManifestPayload,
  saveProgressManifest,
} from "@/services/progress/manifest";
import { jsonResponse } from "@/services/progress/responses";
import type { AppEnv } from "@/types/app";

function isProgressLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

export function createRoutes() {
  const app = new Hono<AppEnv<{ requestId: string }>>().use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      if (isProgressLocked(c.env.LOCK_PROGRESS_ENDPOINTS)) {
        throw new ApiError(
          503,
          "PROGRESS_TEMPORARILY_DISABLED",
          "Progress endpoints are temporarily disabled during stabilization.",
        );
      }
      await next();
    }),
  );

  for (const path of ["state", "sync"] as const) {
    app.on(
      path === "state" ? "GET" : "POST",
      `/${path}`,
      operation(
        path === "state" ? "getMarkerProgress" : "syncMarkerProgress",
        "Progress",
        path === "state" ? "Read marker progress" : "Apply a marker mutation",
        {
          errors: [409, 429, 503],
          security: sessionSecurity,
          description:
            "Requires unlocked progress and a registered manifest. PROGRESS_MANIFEST_NOT_REGISTERED (409) requires registering the requested manifest before retrying.",
          ...(path === "state"
            ? { query: docs.markerStateQuerySchema, response: docs.markerStateResponseSchema }
            : {
                body: docs.markerSyncSchema,
                responses: {
                  200: {
                    ...documentedJsonResponse(
                      docs.markerSyncResponseSchema,
                      "Mutation accepted, unchanged, or replayed",
                    ),
                    headers: {
                      "X-Progress-Idempotent": {
                        description:
                          "Present with value true when replaying the stored response for an identical mutation. The replay may describe an earlier revision than the latest cloud state.",
                        schema: { type: "string", enum: ["true"] },
                      },
                    },
                  },
                  409: documentedJsonResponse(
                    apiErrorSchema,
                    "PROGRESS_MANIFEST_NOT_REGISTERED: register the manifest and retry. PROGRESS_REVISION_CONFLICT: details.current contains the current state projected onto the requested manifest; reconcile before creating a new mutation. IDEMPOTENCY_KEY_REUSED: this mutation ID was already used for a different request; do not retry the changed request with that ID.",
                  ),
                },
              }),
        },
      ),
      requireAuth,
      async (c) => {
        const user = c.get("authUser");

        const stub = c.env.OEM_USER_DO.getByName(user.uid);
        const url = new URL(`https://progress-user/${path}`);
        if (path === "state") {
          const markerIndexHash = c.req.query("markerIndexHash")?.trim().toLowerCase() ?? "";
          url.searchParams.set("markerIndexHash", markerIndexHash);
        }

        const request =
          path === "state"
            ? new Request(url, {
                method: "GET",
                headers: { "x-request-id": c.get("requestId") ?? "" },
              })
            : new Request(url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-request-id": c.get("requestId") ?? "",
                },
                body: await c.req.text(),
              });

        return stub.fetch(request);
      },
    );
  }
  app
    .post(
      "/manifest",
      operation("registerMarkerManifest", "Progress", "Register a marker index", {
        errors: [503],
        security: sessionSecurity,
        body: docs.markerManifestSchema,
        response: docs.markerManifestResponseSchema,
        description:
          "Hash the canonical ordered index described in the client integration guide. Requires unlocked progress.",
      }),
      requireAuth,
      async (c) => {
        const manifest = await normalizeManifestPayload(await c.req.json().catch(() => null));
        await saveProgressManifest(c.env, manifest);
        return jsonResponse({
          ok: true,
          manifest: { markerIndexHash: manifest.markerIndexHash },
        });
      },
    )
    .get(
      "/stats",
      operation("getProgressStats", "Progress", "Read aggregate marker statistics", {
        errors: [429, 503],
        query: docs.markerStateQuerySchema,
        response: docs.progressStatsResponseSchema,
        description: "Requires unlocked progress.",
      }),
      rateLimit("public"),
      async (c) => {
        const markerIndexHash = c.req.query("markerIndexHash")?.trim().toLowerCase();
        if (!markerIndexHash || !isSha256Hex(markerIndexHash)) {
          throw new ApiError(422, "VALIDATION_ERROR", "markerIndexHash must be a SHA-256 hash.");
        }
        return fetchProgressStatsFromWorkersCache(markerIndexHash);
      },
    );
  for (const path of ["state", "sync"] as const) {
    app.on(
      path === "state" ? "GET" : "POST",
      `/archive/${path}`,
      operation(
        path === "state" ? "getArchiveProgress" : "syncArchiveProgress",
        "Progress",
        path === "state" ? "Read archive progress" : "Apply an archive mutation",
        {
          errors: [409, 429, 503],
          security: sessionSecurity,
          description:
            "Requires unlocked progress and a registered archive manifest. ARCHIVE_PROGRESS_MANIFEST_NOT_REGISTERED (409) requires registering the requested manifest before retrying.",
          ...(path === "state"
            ? { query: docs.archiveStateQuerySchema, response: docs.archiveStateResponseSchema }
            : {
                body: docs.archiveSyncSchema,
                responses: {
                  200: {
                    ...documentedJsonResponse(
                      docs.archiveSyncResponseSchema,
                      "Mutation accepted, unchanged, or replayed",
                    ),
                    headers: {
                      "X-Progress-Idempotent": {
                        description:
                          "Present with value true when replaying the stored response for an identical mutation. The replay may describe an earlier revision than the latest cloud state.",
                        schema: { type: "string", enum: ["true"] },
                      },
                    },
                  },
                  409: documentedJsonResponse(
                    apiErrorSchema,
                    "ARCHIVE_PROGRESS_MANIFEST_NOT_REGISTERED: register the manifest and retry. ARCHIVE_PROGRESS_REVISION_CONFLICT: details.current contains the current state projected onto the requested manifest; reconcile before creating a new mutation. IDEMPOTENCY_KEY_REUSED: this mutation ID was already used for a different request; do not retry the changed request with that ID.",
                  ),
                },
              }),
        },
      ),
      requireAuth,
      async (c) => {
        const user = c.get("authUser");

        const stub = c.env.OEM_USER_DO.getByName(user.uid);
        const url = new URL(`https://progress-user/archive/${path}`);
        if (path === "state") {
          const archiveIndexHash = c.req.query("archiveIndexHash")?.trim().toLowerCase() ?? "";
          url.searchParams.set("archiveIndexHash", archiveIndexHash);
        }
        return stub.fetch(
          path === "state"
            ? new Request(url, {
                method: "GET",
                headers: { "x-request-id": c.get("requestId") ?? "" },
              })
            : new Request(url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-request-id": c.get("requestId") ?? "",
                },
                body: await c.req.text(),
              }),
        );
      },
    );
  }
  return app.post(
    "/archive/manifest",
    operation("registerArchiveManifest", "Progress", "Register an archive index", {
      errors: [503],
      security: sessionSecurity,
      body: docs.archiveManifestSchema,
      response: docs.archiveManifestResponseSchema,
      description:
        "Register a sorted unique archive index and its canonical hash. Requires unlocked progress.",
    }),
    requireAuth,
    async (c) => {
      const manifest = await normalizeArchiveManifestPayload(await c.req.json().catch(() => null));
      await saveArchiveProgressManifest(c.env, manifest);
      return jsonResponse({
        ok: true,
        manifest: { archiveIndexHash: manifest.archiveIndexHash },
      });
    },
  );
}
