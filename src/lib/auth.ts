import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { Bindings } from "../types/app";

const DEV_AUTH_SECRET = "dev-only-better-auth-secret-change-in-production";

function toSerializableError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const withCause = error as Error & { cause?: unknown; code?: unknown; status?: unknown; statusText?: unknown };
  return {
    name: error.name,
    message: error.message,
    code: withCause.code,
    status: withCause.status,
    statusText: withCause.statusText,
    cause: withCause.cause ? toSerializableError(withCause.cause) : undefined,
    stack: error.stack
  };
}

function readEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const unquoted = trimmed.replace(/^(['"])(.*)\1$/, "$2").trim();
  const normalized = unquoted.length > 0 ? unquoted : trimmed;
  return normalized.length > 0 ? normalized : undefined;
}

function envOrThrow(value: string | undefined, key: string): string {
  const normalized = readEnv(value);
  if (normalized) {
    return normalized;
  }
  throw new Error(`Missing required auth environment variable: ${key}`);
}

function pickOptionalProvider(
  provider: string,
  clientId: string | undefined,
  clientSecret: string | undefined
) {
  const id = readEnv(clientId);
  const secret = readEnv(clientSecret);

  if (!id && !secret) {
    return null;
  }

  if (!id || !secret) {
    throw new Error(
      `Incomplete OAuth config for ${provider}. Both clientId and clientSecret are required.`
    );
  }

  return {
    clientId: id,
    clientSecret: secret
  };
}

export function createAuth(env: Bindings) {
  const socialProviders: {
    discord: { clientId: string; clientSecret: string; prompt: "consent" };
    google?: { clientId: string; clientSecret: string };
  } = {
    discord: {
      clientId: envOrThrow(env.DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID"),
      clientSecret: envOrThrow(env.DISCORD_CLIENT_SECRET, "DISCORD_CLIENT_SECRET"),
      prompt: "consent"
    }
  };

  const googleProvider = pickOptionalProvider(
    "google",
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET
  );

  if (googleProvider) {
    socialProviders.google = googleProvider;
  }

  return betterAuth({
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL ?? "http://127.0.0.1:8787",
    basePath: "/auth/v1",
    secret: env.BETTER_AUTH_SECRET ?? DEV_AUTH_SECRET,
    trustedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    emailAndPassword: {
      enabled: false
    },
    socialProviders,
    user: {
      modelName: "auth_users"
    },
    session: {
      modelName: "auth_sessions"
    },
    account: {
      modelName: "auth_accounts"
    },
    verification: {
      modelName: "auth_verifications"
    },
    onAPIError: {
      onError: (error, ctx) => {
        console.error("[better-auth][api-error]", {
          oauthStateStrategy: ctx.oauthConfig.storeStateStrategy,
          hasSession: Boolean(ctx.session),
          error: toSerializableError(error)
        });
      }
    },
    plugins: [bearer()],
    advanced: {
      database: {
        generateId: () => crypto.randomUUID()
      }
    }
  });
}
