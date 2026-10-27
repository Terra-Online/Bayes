import { Hono } from "hono";

import { rateLimit } from "@/middleware/rate-limit";
import { parseInput, readJsonBody, readJsonObject } from "@/routes/input";
import { registerWithOtpSchema, sendTemplateOtpSchema } from "@/routes/schema/auth";
import { loginViaPassword } from "@/services/auth/loginViaPassword";
import { registerViaOTP, requestRegistrationOtp } from "@/services/auth/registerViaOTP";
import type { AppEnv } from "@/types/app";

import { authRequestInfo, authResponse } from "./honoAdapter";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/register", rateLimit("public"), async (c) => {
      const input = parseInput(registerWithOtpSchema, await readJsonBody(c.req));

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
      const input = parseInput(sendTemplateOtpSchema, await readJsonBody(c.req));

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
      return authResponse(
        c,
        await loginViaPassword(c.env, {
          email: payload.email,
          password: payload.password,
          rememberMe: payload.rememberMe,
          callbackURL: payload.callbackURL,
          redirectTo: payload.redirectTo,
          errorCallbackURL: payload.errorCallbackURL,
          newUserCallbackURL: payload.newUserCallbackURL,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    });
}
