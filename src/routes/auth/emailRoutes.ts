import { Hono } from "hono";

import { normalizeEmail } from "@/lib/auth/contract/email";
import { registerViaOTP, requestRegistrationOtp } from "@/lib/auth/registerViaOTP";
import { rateLimit } from "@/middleware/rate-limit";
import { registerWithOtpSchema, sendTemplateOtpSchema } from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { forwardToAuthJsonPath } from "./forwarding";
import { authRequestInfo, authResponse } from "./honoAdapter";
import { parseAuthInput, readJsonBody, readJsonObject } from "./input";
import type { ForwardToAuthJsonPath } from "./types";

export function createRoutes(
  deps: {
    forwardToAuthJsonPath: ForwardToAuthJsonPath;
  } = { forwardToAuthJsonPath },
) {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/register", rateLimit("public"), async (c) => {
      const input = parseAuthInput(registerWithOtpSchema, await readJsonBody(c.req));

      return authResponse(
        c,
        await registerViaOTP(c.env, {
          ...input,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .post("/email-otp/send-verification-otp", rateLimit("otp-send"), async (c) => {
      const input = parseAuthInput(sendTemplateOtpSchema, await readJsonBody(c.req));

      return authResponse(
        c,
        await requestRegistrationOtp(c.env, {
          email: input.email,
          locale: input.locale,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .post("/sign-in/email", rateLimit("public"), async (c) => {
      const payload = await readJsonObject(c.req);
      const rawEmail = payload.email;
      if (typeof rawEmail !== "string") {
        return deps.forwardToAuthJsonPath(c, "/sign-in/email", payload);
      }

      const email = normalizeEmail(rawEmail);
      payload.email = email;
      return deps.forwardToAuthJsonPath(c, "/sign-in/email", payload);
    });
}
