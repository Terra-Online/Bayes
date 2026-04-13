import { betterAuth } from 'better-auth';
import { bearer, emailOTP } from 'better-auth/plugins';
import type { Bindings } from '../types/app';
import { initResend, sendEmail } from './email';
import {
  createOtpEmailTemplate,
  createResetPasswordMagicLinkTemplate,
  createVerifyEmailMagicLinkTemplate,
  resolveEmailLocale,
} from './email-templates';
import { envOrThrow, readEnv } from './utils';

const DEV_AUTH_SECRET = 'dev-only-better-auth-secret-change-in-production';

function pickLocaleFromUser(user: unknown): string | undefined {
  if (!user || typeof user !== 'object') {
    return undefined;
  }

  const userAsRecord = user as Record<string, unknown>;
  const locale = userAsRecord.locale;
  if (typeof locale === 'string' && locale.trim().length > 0) {
    return locale;
  }

  return undefined;
}

function resolvePreferredLocale(env: Bindings, user: unknown): ReturnType<typeof resolveEmailLocale> {
  const fromUser = pickLocaleFromUser(user);
  return resolveEmailLocale(fromUser ?? env.EMAIL_TEMPLATE_DEFAULT_LOCALE);
}

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
  initResend(env);

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
        const locale = resolvePreferredLocale(env, user);
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
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        // Fallback link email; OTP delivery is handled by emailOTP override flow.
        const locale = resolvePreferredLocale(env, user);
        const content = createVerifyEmailMagicLinkTemplate({ locale, url });
        await sendEmail({
          to: user.email,
          subject: content.subject,
          text: content.text,
          html: content.html,
        });
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
    plugins: [
      bearer(),
      emailOTP({
        overrideDefaultEmailVerification: true,
        sendVerificationOnSignUp: true,
        otpLength: 6,
        expiresIn: 300,
        async sendVerificationOTP({ email, otp, type }) {
          const locale = resolveEmailLocale(env.EMAIL_TEMPLATE_DEFAULT_LOCALE);
          const mappedType = type === 'change-email' ? 'email-verification' : type;
          const content = createOtpEmailTemplate({ locale, type: mappedType, otp });
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
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
  });
}
