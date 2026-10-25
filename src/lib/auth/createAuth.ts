import { AsyncLocalStorage } from "node:async_hooks";

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getSchema } from "better-auth/db";
import { bearer, emailOTP } from "better-auth/plugins";

import { getSessionTtlSeconds } from "@/lib/config";
import { envOrThrow } from "@/lib/utils";
import { sendAuthOtpEmail, sendPasswordResetEmail } from "@/services/email";
import type { Bindings } from "@/types/app";

import { sameAuthEnvironment } from "./environment";
import { toSerializableError } from "./errors";
import { pickRequestFromCtx, resolvePreferredEmailLocale } from "./locale";
import { authCookieOptions, parseAuthTrustedOrigins } from "./origins";
import { createAuthSocialProviders } from "./providers";
import { authSchemaDatabase } from "./schemaMetadata";

type AuthInvocation = { onError?: (error: unknown) => void };
const authInvocation = new AsyncLocalStorage<AuthInvocation>();

function generateNumericOtp(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let otp = "";

  for (let index = 0; index < bytes.length; index += 1) {
    otp += String(bytes[index]! % 10);
  }

  return otp;
}

function buildAuth(env: Bindings, metadata?: ReturnType<typeof authSchemaDatabase>["metadata"]) {
  const sessionTtlSeconds = getSessionTtlSeconds(env);

  const cookies = authCookieOptions(env);
  const options = {
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
    onAPIError: {
      onError: (error, ctx) => {
        authInvocation.getStore()?.onError?.(error);
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
  const schema = authSchemaDatabase(
    env.DB,
    metadata,
    () => new Set(Object.keys(getSchema(options))),
  );
  return { auth: betterAuth({ ...options, database: schema.db }), schema };
}

type Auth = ReturnType<typeof buildAuth>["auth"];
type Context = Awaited<Auth["$context"]>;
type SchemaSlot = { metadata?: ReturnType<typeof authSchemaDatabase>["metadata"] };
type RequestAuth = { env: Bindings; auth: Auth; ready: Promise<Context>; defaultFacade?: Auth };
const validatedSchemas = new WeakMap<D1Database, SchemaSlot>();
const authRequests = new AsyncLocalStorage<WeakMap<D1Database, RequestAuth>>();

export function runWithAuthRequest<T>(handler: () => T): T {
  return authRequests.run(new WeakMap(), handler);
}

export function createAuth(env: Bindings, options?: AuthInvocation): Auth {
  const requests = authRequests.getStore();
  let request = requests?.get(env.DB);
  if (!request || !sameAuthEnvironment(request.env, env)) {
    let slot = validatedSchemas.get(env.DB);
    if (!slot) {
      slot = {};
      validatedSchemas.set(env.DB, slot);
    }
    const currentSlot = slot;
    const requestEnv = { ...env };
    const { auth, schema } = buildAuth(requestEnv, slot.metadata);
    const ready = auth.$context.then(async (context) => {
      await context.checkSchema?.();
      if (!currentSlot.metadata) {
        currentSlot.metadata = new Map(schema.metadata);
      }
      return context;
    });
    request = { env: requestEnv, auth, ready };
    requests?.set(env.DB, request);
    void ready.catch(() => {
      if (requests && requests.get(env.DB) === request) {
        requests.delete(env.DB);
      }
    });
  }
  if (!options && request.defaultFacade) {
    return request.defaultFacade;
  }
  const { auth, ready } = request;
  // Each request owns its Kysely connection/lock and pending checks. Only plain,
  // successfully validated schema results are shared across requests.
  const handler: Auth["handler"] = (request) =>
    ready.then(() => authInvocation.run(options ?? {}, () => auth.handler(request)));
  const api = new Proxy(auth.api, {
    get(target, key, receiver) {
      const endpoint = Reflect.get(target, key, receiver);
      if (typeof endpoint !== "function") {
        return endpoint;
      }
      return new Proxy(endpoint, {
        apply(fn, thisArg, args) {
          return ready.then(() =>
            authInvocation.run(options ?? {}, () => Reflect.apply(fn, thisArg, args)),
          );
        },
      });
    },
  });
  const facade = { ...auth, handler, fetch: handler, api, $context: ready };
  if (!options) {
    request.defaultFacade = facade;
  }
  return facade;
}
