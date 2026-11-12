import { Hono } from "hono";

import { rateLimit } from "@/middleware/rate-limit";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import { UGC_PUBLIC_IMAGE_CACHE_CONTROL } from "@/services/ugc/contract/imageDelivery";
import { loadImageAsset } from "@/services/ugc/read/imageAssets";
import type { AppEnv } from "@/types/app";

import { parseObjectKeyFromRequestPath } from "./helpers";
import { requireActiveUser } from "./middleware";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get(
      "/public-file/*",
      operation("getPublicImageFile", "Images", "Read a public image file", {
        errors: [404, 429, 503],
        parameters: [{ in: "header", name: "If-None-Match", schema: { type: "string" } }],
        description:
          "path is the complete object key, including slashes. Preserve the path returned by the API.",
        responses: {
          200: {
            description: "Image bytes",
            content: { "image/*": { schema: { type: "string", format: "binary" } } },
          },
          304: { description: "Not modified" },
        },
      }),
      rateLimit("public"),
      async (c) => {
        const objectKey = parseObjectKeyFromRequestPath(c.req.path);
        const { object, contentType } = await loadImageAsset(
          { db: c.env.DB, bucket: c.env.UGC_BUCKET },
          { objectKey, access: { kind: "public" } },
        );

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", UGC_PUBLIC_IMAGE_CACHE_CONTROL);
        headers.set("Content-Type", contentType);

        const validator = c.req.header("If-None-Match");
        if (
          validator
            ?.split(",")
            .some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === object.httpEtag)
        ) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(object.body, {
          status: 200,
          headers,
        });
      },
    )
    .get(
      "/file/*",
      operation("getPrivateImageFile", "Images", "Read an authorized private image file", {
        errors: [404, 429, 503],
        security: sessionSecurity,
        description: "Active user required. path is the complete object key, including slashes.",
        parameters: [{ in: "header", name: "If-None-Match", schema: { type: "string" } }],
        responses: {
          200: {
            description: "Private image bytes",
            content: { "image/*": { schema: { type: "string", format: "binary" } } },
          },
          304: { description: "Not modified" },
        },
      }),
      requireActiveUser,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const objectKey = parseObjectKeyFromRequestPath(c.req.path);
        const { object, contentType } = await loadImageAsset(
          { db: c.env.DB, bucket: c.env.UGC_BUCKET },
          { objectKey, access: { kind: "viewer", actor: user } },
        );

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "private, max-age=60");
        headers.set("Content-Type", contentType);

        const validator = c.req.header("If-None-Match");
        if (
          validator
            ?.split(",")
            .some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === object.httpEtag)
        ) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(object.body, {
          status: 200,
          headers,
        });
      },
    );
}
