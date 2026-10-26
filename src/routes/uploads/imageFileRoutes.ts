import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { UGC_PUBLIC_IMAGE_CACHE_CONTROL } from "@/services/ugc/contract/imageDelivery";
import { loadImageAsset } from "@/services/ugc/read/imageAssets";
import type { AppEnv } from "@/types/app";

import { parseObjectKeyFromRequestPath } from "./helpers";
import { requireActiveUser } from "./middleware";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get("/public-file/*", rateLimit("public"), async (c) => {
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

      return new Response(object.body, {
        status: 200,
        headers,
      });
    })
    .get("/file/*", requireActiveUser, rateLimit("auth"), async (c) => {
      const user = c.get("authUser");
      if (!user) {
        throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
      }
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

      return new Response(object.body, {
        status: 200,
        headers,
      });
    });
}
