import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";
import type { Bindings } from "../../types/app";
import { getRuntimeConfig } from "../config";
import { initResend, sendEmail } from "../email/sender";
import {
  createOtpEmailTemplate,
  createResetPasswordMagicLinkTemplate,
} from "../email/templates";
import { envOrThrow, readEnv } from "../utils";
import { toSerializableError } from "./errors";
import { pickRequestFromCtx, resolvePreferredEmailLocale } from "./locale";
import {
  DEFAULT_AUTH_BASE_URL,
  PARTITIONED_AUTH_COOKIE_PREFIX,
  isLocalBaseUrl,
  parseAuthTrustedOrigins,
  resolveCookieAttributes,
} from "./origins";
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

export function createAuth(env: Bindings) {
  initResend(env);
  const { sessionTtlSeconds } = getRuntimeConfig(env);

  return betterAuth({
    database: env.DB,
    baseURL: readEnv(env.BETTER_AUTH_URL) ?? DEFAULT_AUTH_BASE_URL,
    basePath: "/auth/v1",
    secret: envOrThrow(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
    trustedOrigins: parseAuthTrustedOrigins(env),
    emailAndPassword: {
      enabled: true,
      resetPasswordTokenExpiresIn: 15 * 60,
      sendResetPassword: async ({ user, url }, request) => {
        const locale = resolvePreferredEmailLocale(env, user, request);
        const content = createResetPasswordMagicLinkTemplate({ locale, url });
        await sendEmail({
          to: user.email,
          subject: content.subject,
          text: content.text,
          html: content.html,
        });
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
    onAPIError: {
      onError: (error, ctx) => {
        console.error("[better-auth][api-error]", {
          oauthStateStrategy: ctx.oauthConfig.storeStateStrategy,
          hasSession: Boolean(ctx.session),
          error: toSerializableError(error),
        });
      },
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
          const content = createOtpEmailTemplate({ locale, otp });
          await sendEmail({
            to: email,
            subject: content.subject,
            text: content.text,
            html: content.html,
          });
        },
      }),
    ],
    advanced: {
      cookiePrefix: isLocalBaseUrl(env.BETTER_AUTH_URL) ? undefined : PARTITIONED_AUTH_COOKIE_PREFIX,
      defaultCookieAttributes: resolveCookieAttributes(env.BETTER_AUTH_URL),
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
        ipv6Subnet: 64,
      },
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
  });
}
