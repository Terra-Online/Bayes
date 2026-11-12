import { Hono } from "hono";
import { z } from "zod";

import { rateLimit } from "@/middleware/rate-limit";
import { parseInput, readJsonBody, readJsonObject } from "@/routes/input";
import { operation } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/auth";
import { registerWithOtpSchema, sendTemplateOtpSchema } from "@/routes/schema/auth";
import { loginViaPassword } from "@/services/auth/loginViaPassword";
import { registerViaOTP, requestRegistrationOtp } from "@/services/auth/registerViaOTP";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post(
      "/register",
      operation("registerWithOtp", "Accounts", "Register using an email OTP", {
        errors: [400, 409, 429, 503],
        body: docs.registerWithOtpSchema,
        response: docs.registrationResponseSchema,
        description:
          "Creates the existing user and a session; profile setup is a later update. Returns the Better Auth user model.",
      }),
      rateLimit("public"),
      async (c) => {
        const input = parseInput(registerWithOtpSchema, await readJsonBody(c.req));

        return registerViaOTP(c.env, {
          ...input,
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    )
    .post(
      "/email-otp/send-verification-otp",
      operation("sendRegistrationOtp", "Accounts", "Send a registration OTP", {
        errors: [400, 429, 503],
        body: docs.sendTemplateOtpSchema,
        response: z.object({ success: z.boolean() }),
      }),
      rateLimit("otp-send"),
      async (c) => {
        const input = parseInput(sendTemplateOtpSchema, await readJsonBody(c.req));

        return requestRegistrationOtp(c.env, {
          email: input.email,
          locale: input.locale,
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    )
    .post(
      "/sign-in/email",
      operation("signInWithEmail", "Accounts", "Sign in using email and password", {
        errors: [400, 401, 429, 503],
        body: docs.passwordLoginSchema,
        response: docs.passwordLoginResponseSchema,
      }),
      rateLimit("public"),
      async (c) => {
        const payload = await readJsonObject(c.req);
        return loginViaPassword(c.env, {
          payload,
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    );
}
