import { betterAuth } from 'better-auth';
import { bearer, emailOTP } from 'better-auth/plugins';
import type { Bindings } from '../types/app';
import { initResend, sendEmail } from './email';
import {
  createOtpEmailTemplate,
  createResetPasswordMagicLinkTemplate,
  resolveEmailLocale,
} from './email-templates';
import { envOrThrow, readEnv } from './utils';

const DEV_AUTH_SECRET = 'dev-only-better-auth-secret-change-in-production';
const OEM_LOCALE_HEADER = 'x-oem-locale';

function generateNumericOtp(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let otp = '';

  for (let index = 0; index < bytes.length; index += 1) {
    otp += String(bytes[index]! % 10);
  }

  return otp;
}

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

function pickLocaleFromRequest(request: Request | undefined): string | undefined {
  if (!request) {
    return undefined;
  }

  const localeHeader = request.headers.get(OEM_LOCALE_HEADER)?.trim();
  if (localeHeader) {
    return localeHeader;
  }

  const acceptLanguage = request.headers.get('accept-language')?.trim();
  if (acceptLanguage) {
    return acceptLanguage;
  }

  return undefined;
}

function pickRequestFromCtx(ctx: unknown): Request | undefined {
  if (!ctx || typeof ctx !== 'object') {
    return undefined;
  }

  const maybeRequest = (ctx as { request?: unknown }).request;
  if (maybeRequest instanceof Request) {
    return maybeRequest;
  }

  return undefined;
}

function resolvePreferredLocale(
  env: Bindings,
  user: unknown,
  request?: Request,
): ReturnType<typeof resolveEmailLocale> {
  const fromRequest = pickLocaleFromRequest(request);
  const fromUser = pickLocaleFromUser(user);
  return resolveEmailLocale(fromRequest ?? fromUser ?? env.EMAIL_TEMPLATE_DEFAULT_LOCALE);
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
      resetPasswordTokenExpiresIn: 300,
      sendResetPassword: async ({ user, url }, request) => {
        const locale = resolvePreferredLocale(env, user, request);
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
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/email-otp/send-verification-otp': {
          window: 60,
          max: 12,
        },
        '/sign-in/email-otp': {
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
        resendStrategy: 'rotate',
        storeOTP: 'hashed',
        generateOTP: () => generateNumericOtp(6),
        async sendVerificationOTP({ email, otp }, ctx) {
          const request = pickRequestFromCtx(ctx);
          const locale = resolvePreferredLocale(env, null, request);
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
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
        ipv6Subnet: 64,
      },
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
  });
}
