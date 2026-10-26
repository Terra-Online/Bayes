import { Hono } from "hono";

import { normalizeEmail } from "@/lib/auth/contract/email";
import { registerViaOTP, requestRegistrationOtp } from "@/lib/auth/registerViaOTP";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { registerWithOtpSchema, sendTemplateOtpSchema } from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { forwardToAuthJsonPath } from "./forwarding";
import { authRequestInfo, authResponse } from "./honoAdapter";
import type { ForwardToAuthJsonPath } from "./types";

export function createRoutes(
  deps: {
    forwardToAuthJsonPath: ForwardToAuthJsonPath;
  } = { forwardToAuthJsonPath },
) {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/register", rateLimit("public"), async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
      }

      const parsed = registerWithOtpSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
      }

      return authResponse(
        c,
        await registerViaOTP(c.env, {
          ...parsed.data,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .post("/email-otp/send-verification-otp", rateLimit("otp-send"), async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
      }

      const parsed = sendTemplateOtpSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
      }

      return authResponse(
        c,
        await requestRegistrationOtp(c.env, {
          email: parsed.data.email,
          locale: parsed.data.locale,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .post("/sign-in/email", rateLimit("public"), async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.");
      }

      const payload = body as Record<string, unknown>;
      const rawEmail = payload.email;
      if (typeof rawEmail !== "string") {
        return deps.forwardToAuthJsonPath(c, "/sign-in/email", payload);
      }

      const email = normalizeEmail(rawEmail);
      payload.email = email;
      return deps.forwardToAuthJsonPath(c, "/sign-in/email", payload);
    });
}
