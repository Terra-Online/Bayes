import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import type { Bindings } from '../types/app';
import { sendEmail } from './email';
import { envOrThrow, readEnv } from './utils';

const DEV_AUTH_SECRET = 'dev-only-better-auth-secret-change-in-production';

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
    stack: error.stack,
  };
}

function pickOptionalProvider(
  provider: string,
  clientId: string | undefined,
  clientSecret: string | undefined,
) {
  const id = readEnv(clientId);
  const secret = readEnv(clientSecret);

  if (!id && !secret) {
    return null;
  }

  if (!id || !secret) {
    throw new Error(
      `Incomplete OAuth config for ${provider}. Both clientId and clientSecret are required.`,
    );
  }

  return {
    clientId: id,
    clientSecret: secret,
  };
}

export function createAuth(env: Bindings) {
  const socialProviders: {
    discord: { clientId: string; clientSecret: string; prompt: 'consent' };
    google?: { clientId: string; clientSecret: string };
  } = {
    discord: {
      clientId: envOrThrow(env.DISCORD_CLIENT_ID, 'DISCORD_CLIENT_ID'),
      clientSecret: envOrThrow(env.DISCORD_CLIENT_SECRET, 'DISCORD_CLIENT_SECRET'),
      prompt: 'consent',
    },
  };

  const googleProvider = pickOptionalProvider(
    'google',
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
  );

  if (googleProvider) {
    socialProviders.google = googleProvider;
  }

  return betterAuth({
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL ?? 'http://127.0.0.1:8787',
    basePath: '/auth/v1',
    secret: env.BETTER_AUTH_SECRET ?? DEV_AUTH_SECRET,
    trustedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        void sendEmail(
          user.email, `Click the link to reset your password: ${url}`,
          'Reset your password',
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        void sendEmail(
          user.email, `Click the link to verify your email: ${url}`,
          'Verify your email address',
        );
      },
    },
    socialProviders,
    user: {
      modelName: 'auth_users',
    },
    session: {
      modelName: 'auth_sessions',
    },
    account: {
      modelName: 'auth_accounts',
    },
    verification: {
      modelName: 'auth_verifications',
    },
    onAPIError: {
      onError: (error, ctx) => {
        console.error('[better-auth][api-error]', {
          oauthStateStrategy: ctx.oauthConfig.storeStateStrategy,
          hasSession: Boolean(ctx.session),
          error: toSerializableError(error),
        });
      },
    },
    plugins: [bearer()],
    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
  });
}
