import { Hono } from "hono";
import type { z } from "zod";

import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { operation, sessionSecurity, jsonBody } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/profile";
import { getRequestAuthCredentials } from "@/services/auth/requestCredentials";
import { invalidateSessionCache } from "@/services/auth/session";
import { updateProfile } from "@/services/profile";
import type { AppEnv } from "@/types/app";

import { readProfileUpdateInput } from "./input";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().patch(
    "/profile",
    operation("updateProfile", "Accounts", "Update nickname and avatar", {
      errors: [404, 409, 415, 429, 503],
      security: sessionSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": jsonBody(docs.profileUpdateSchema).content["application/json"],
          "application/x-www-form-urlencoded": jsonBody(docs.profileUpdateSchema).content[
            "application/json"
          ],
          "multipart/form-data": jsonBody(docs.profileUpdateSchema).content["application/json"],
        },
      },
      response: docs.profileResponseSchema,
      description:
        "Updates the existing user. Legacy avt is accepted as an alias for avatar. JSON without Content-Type remains accepted; form avatar values are converted to numbers.",
    }),
    requireAuth,
    rateLimit("auth"),
    async (c) => {
      const input = await readProfileUpdateInput(c.req);
      const user = await updateProfile(c.env.DB, {
        userId: c.get("authUser").uid,
        ...input,
      });
      invalidateSessionCache(c.env, getRequestAuthCredentials(c.req.raw));
      return c.json({ user } satisfies z.output<typeof docs.profileResponseSchema>);
    },
  );
}
