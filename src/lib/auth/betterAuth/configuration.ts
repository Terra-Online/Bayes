import type { BetterAuthOptions } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";

import { pickRequestFromCtx, resolvePreferredEmailLocale } from "@/lib/auth/locale";
import { authCookieOptions, parseAuthTrustedOrigins } from "@/lib/auth/origins";
import { getSessionTtlSeconds } from "@/lib/config";
import { envOrThrow } from "@/lib/utils";
import { sendAuthOtpEmail, sendPasswordResetEmail } from "@/services/email";
import type { Bindings } from "@/types/app";

import { createAuthSocialProviders } from "./providers";

function generateNumericOtp(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let otp = "";

  for (let index = 0; index < bytes.length; index += 1) {
    otp += String(bytes[index]! % 10);
  }

  return otp;
}

export function createAuthConfiguration(env: Bindings) {
  const sessionTtlSeconds = getSessionTtlSeconds(env);

  const cookies = authCookieOptions(env);
  return {
    database: env.DB,
    baseURL: cookies.baseURL,
    basePath: "/auth/v1",
    secret: envOrThrow(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
    trustedOrigins: parseAuthTrustedOrigins(env),
    emailAndPassword: {
      enabled: true,
      resetPasswordTokenExpiresIn: 15 * 60,
      sendResetPassword: async ({ user, url }, request) => {
        const locale = resolvePreferredEmailLocale(env, user, request);
        await sendPasswordResetEmail(env, { to: user.email, locale, url });
      },
    },
    emailVerification: {
      sendOnSignUp: false,
      autoSignInAfterVerification: true,
    },
    socialProviders: createAuthSocialProviders(env),
    user: {
      modelName: "auth_users",
    },
    session: {
      modelName: "auth_sessions",
      expiresIn: sessionTtlSeconds,
      updateAge: Math.min(24 * 60 * 60, Math.floor(sessionTtlSeconds / 2)),
    },
    account: {
      modelName: "auth_accounts",
      storeStateStrategy: "database",
      skipStateCookieCheck: true,
    },
    verification: {
      modelName: "auth_verifications",
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/email-otp/send-verification-otp": {
          window: 60,
          max: 12,
        },
        "/sign-in/email-otp": {
          window: 60,
          max: 12,
        },
      },
    },
    plugins: [
      bearer(),
      emailOTP({
        overrideDefaultEmailVerification: true,
        sendVerificationOnSignUp: false,
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        resendStrategy: "rotate",
        storeOTP: "hashed",
        generateOTP: () => generateNumericOtp(6),
        async sendVerificationOTP({ email, otp }, ctx) {
          const request = pickRequestFromCtx(ctx);
          const locale = resolvePreferredEmailLocale(env, null, request);
          await sendAuthOtpEmail(env, { to: email, locale, otp });
        },
      }),
    ],
    advanced: {
      ...cookies.advanced,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
        ipv6Subnet: 64,
      },
      database: {
        generateId: () => crypto.randomUUID(),
        validateSchema: true,
      },
    },
  } satisfies BetterAuthOptions;
}
