import { Resend } from 'resend';
import type { Bindings } from '../../types/app';
import { createRedisClient } from '../redis';
import { envOrThrow, readEnv } from '../utils';

const DEFAULT_FROM_ADDRESS = 'noreply@opendfieldmap.org';
const DEFAULT_RESEND_DAILY_LIMIT = 100;
const USAGE_KEY_PREFIX = 'email:resend:daily:';
const USAGE_TTL_SECONDS = 3 * 24 * 60 * 60;

type EmailProviderName = 'resend' | 'cloudflare';
type EmailProviderMode = 'resend_only' | 'resend_then_cloudflare' | 'cloudflare_only';
type ResendFailureKind = 'quota' | 'temporary' | 'permanent' | 'ambiguous';

let resend: Resend | undefined;
let activeEnv: Bindings | undefined;
let fromAddress = DEFAULT_FROM_ADDRESS;
let fromName: string | undefined;
let providerMode: EmailProviderMode = 'resend_then_cloudflare';
let resendDailyLimit = DEFAULT_RESEND_DAILY_LIMIT;

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeFromAddress(rawValue: string): string {
  const normalized = stripOuterQuotes(rawValue);
  const match = normalized.match(/^(.*)<([^>]+)>$/);
  if (!match) return normalized;
  const displayName = stripOuterQuotes(match[1]?.trim() ?? '');
  const email = stripOuterQuotes(match[2]?.trim() ?? '');
  if (!email) return normalized;
  return displayName ? `${displayName} <${email}>` : email;
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (!domain) return '***';
  const safeLocal = local.length <= 2 ? `${local.slice(0, 1)}***` : `${local.slice(0, 2)}***`;
  return `${safeLocal}@${domain}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(readEnv(value) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = readEnv(value)?.toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return fallback;
}

function resolveProviderMode(env: Bindings): EmailProviderMode {
  const configuredMode = readEnv(env.EMAIL_PROVIDER_MODE)?.toLowerCase();
  if (
    configuredMode === 'resend_only'
    || configuredMode === 'resend_then_cloudflare'
    || configuredMode === 'cloudflare_only'
  ) {
    return configuredMode;
  }
  if (readEnv(env.EMAIL_PRIMARY_PROVIDER)?.toLowerCase() === 'cloudflare') {
    return 'cloudflare_only';
  }
  return parseBoolean(env.EMAIL_FALLBACK_ENABLED, true) ? 'resend_then_cloudflare' : 'resend_only';
}

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  provider: EmailProviderName;
  id?: string;
}

interface EmailProvider {
  readonly name: EmailProviderName;
  send(payload: EmailPayload): Promise<SendEmailResult>;
}

class EmailProviderError extends Error {
  readonly provider: EmailProviderName;
  readonly kind: ResendFailureKind;
  readonly statusCode?: number;
  readonly providerCode?: string;

  constructor(input: {
    provider: EmailProviderName;
    kind: ResendFailureKind;
    message: string;
    statusCode?: number;
    providerCode?: string;
  }) {
    super(input.message);
    this.name = 'EmailProviderError';
    this.provider = input.provider;
    this.kind = input.kind;
    this.statusCode = input.statusCode;
    this.providerCode = input.providerCode;
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;

  constructor(private readonly client: Resend) {}

  async send(payload: EmailPayload): Promise<SendEmailResult> {
    try {
      const result = await this.client.emails.send({
        from: getFromAddress(),
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      });
      if (result.error) throw toResendProviderError(result.error);
      return { provider: this.name, id: result.data?.id };
    } catch (error) {
      if (error instanceof EmailProviderError) throw error;
      throw classifyThrownResendError(error);
    }
  }
}

class CloudflareEmailProvider implements EmailProvider {
  readonly name = 'cloudflare' as const;

  constructor(private readonly binding: SendEmail) {}

  async send(payload: EmailPayload): Promise<SendEmailResult> {
    try {
      const result = await this.binding.send({
        to: payload.to,
        from: getFromAddress(),
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      });
      return { provider: this.name, id: result.messageId };
    } catch (error) {
      const providerCode = readErrorProperty(error, 'code');
      const message = error instanceof Error ? error.message : String(error);
      throw new EmailProviderError({
        provider: this.name,
        kind: 'permanent',
        message: `Cloudflare email send failed${providerCode ? ` (${providerCode})` : ''}: ${message}`,
        providerCode,
      });
    }
  }
}

function getFromAddress(): string {
  if (fromAddress.includes('<') || !fromName) return fromAddress;
  return `${fromName} <${fromAddress}>`;
}

function readErrorProperty(error: unknown, property: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>).statusCode;
  return typeof value === 'number' ? value : undefined;
}

function toResendProviderError(error: {
  name?: string;
  message?: string;
  statusCode?: number | null;
}): EmailProviderError {
  const providerCode = error.name ?? 'unknown_error';
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : undefined;
  return new EmailProviderError({
    provider: 'resend',
    kind: classifyResendFailure(providerCode, statusCode, error.message ?? ''),
    message: error.message || 'Resend rejected email send request.',
    statusCode,
    providerCode,
  });
}

function classifyResendFailure(
  providerCode: string,
  statusCode: number | undefined,
  message: string,
): ResendFailureKind {
  const normalizedCode = providerCode.toLowerCase();
  const normalizedMessage = message.toLowerCase();
  if (
    normalizedCode === 'daily_quota_exceeded'
    || normalizedCode === 'monthly_quota_exceeded'
    || normalizedMessage.includes('daily quota')
    || normalizedMessage.includes('daily limit')
  ) return 'quota';
  if (
    normalizedCode === 'rate_limit_exceeded'
    || (typeof statusCode === 'number' && statusCode >= 500)
    || normalizedCode === 'internal_server_error'
    || normalizedCode === 'application_error'
    || normalizedMessage.includes('service unavailable')
  ) return 'temporary';
  return 'permanent';
}

function classifyThrownResendError(error: unknown): EmailProviderError {
  const providerCode = readErrorProperty(error, 'name') ?? 'network_error';
  const statusCode = readErrorStatusCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  const kind: ResendFailureKind = normalizedMessage.includes('timeout') || normalizedMessage.includes('timed out')
    ? 'ambiguous'
    : 'temporary';
  return new EmailProviderError({
    provider: 'resend',
    kind,
    message: `Resend email send failed: ${message}`,
    statusCode,
    providerCode,
  });
}

function getUsageDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function reserveResendSlot(env: Bindings, usageDate: string): Promise<boolean> {
  const redis = createRedisClient(env);
  const usageKey = `${USAGE_KEY_PREFIX}${usageDate}:reserved`;
  const exhaustedKey = `${USAGE_KEY_PREFIX}${usageDate}:exhausted`;
  try {
    if (await redis.get(exhaustedKey)) return false;
    const count = Number(await redis.incr(usageKey));
    await redis.expire(usageKey, USAGE_TTL_SECONDS);
    if (Number.isFinite(count) && count <= resendDailyLimit) return true;
    await redis.set(exhaustedKey, '1', { ex: USAGE_TTL_SECONDS });
    return false;
  } catch (error) {
    console.error('[email] failed to reserve Resend quota slot; continuing with primary provider', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function recordResendSuccess(env: Bindings, usageDate: string): Promise<void> {
  await incrementUsageCounter(env, `${USAGE_KEY_PREFIX}${usageDate}:success`);
}

async function recordResendFailure(env: Bindings, usageDate: string, kind: ResendFailureKind): Promise<void> {
  if (kind === 'quota') {
    await markResendExhausted(env, usageDate);
  } else if (kind !== 'ambiguous') {
    try {
      const redis = createRedisClient(env);
      await redis.decr(`${USAGE_KEY_PREFIX}${usageDate}:reserved`);
    } catch (error) {
      console.error('[email] failed to release Resend quota reservation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function recordFallback(env: Bindings, usageDate: string): Promise<void> {
  await incrementUsageCounter(env, `${USAGE_KEY_PREFIX}${usageDate}:fallback`);
}

async function markResendExhausted(env: Bindings, usageDate: string): Promise<void> {
  try {
    const redis = createRedisClient(env);
    await redis.set(`${USAGE_KEY_PREFIX}${usageDate}:exhausted`, '1', { ex: USAGE_TTL_SECONDS });
  } catch (error) {
    console.error('[email] failed to mark Resend quota exhausted', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function incrementUsageCounter(env: Bindings, key: string): Promise<void> {
  try {
    const redis = createRedisClient(env);
    await redis.incr(key);
    await redis.expire(key, USAGE_TTL_SECONDS);
  } catch (error) {
    console.error('[email] failed to update provider usage metrics', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function logSendSuccess(payload: EmailPayload, result: SendEmailResult, reason: string): void {
  console.warn('[email] send success', {
    provider: result.provider,
    reason,
    id: result.id,
    to: maskEmail(payload.to),
    subject: payload.subject,
  });
}

function logProviderFailure(payload: EmailPayload, error: EmailProviderError): void {
  console.error('[email] provider send failed', {
    provider: error.provider,
    kind: error.kind,
    code: error.providerCode,
    statusCode: error.statusCode,
    to: maskEmail(payload.to),
    subject: payload.subject,
    error: error.message,
  });
}

export function initResend(env: Bindings): void {
  activeEnv = env;
  providerMode = resolveProviderMode(env);
  resendDailyLimit = parsePositiveInt(env.EMAIL_RESEND_DAILY_LIMIT, DEFAULT_RESEND_DAILY_LIMIT);
  fromAddress = normalizeFromAddress(
    readEnv(env.EMAIL_FROM_EMAIL) ?? readEnv(env.RESEND_FROM_EMAIL) ?? DEFAULT_FROM_ADDRESS,
  );
  fromName = readEnv(env.EMAIL_FROM_NAME) ?? readEnv(env.RESEND_FROM_NAME);
  if (providerMode === 'cloudflare_only') {
    resend = undefined;
    return;
  }
  resend = new Resend(envOrThrow(env.RESEND_AUTH_KEY, 'RESEND_AUTH_KEY'));
}

export async function sendEmail(payload: EmailPayload): Promise<SendEmailResult> {
  if (!activeEnv) throw new Error('EMAIL_NOT_INITIALIZED');
  const env = activeEnv;
  const usageDate = getUsageDate();
  const cloudflare = env.OEM_ID_MAILS ? new CloudflareEmailProvider(env.OEM_ID_MAILS) : undefined;

  if (providerMode === 'cloudflare_only') {
    if (!cloudflare) throw new Error('CLOUDFLARE_EMAIL_NOT_CONFIGURED');
    const result = await cloudflare.send(payload);
    logSendSuccess(payload, result, 'cloudflare_only');
    return result;
  }
  if (!resend) throw new Error('RESEND_NOT_INITIALIZED');

  const hasResendSlot = await reserveResendSlot(env, usageDate);
  if (!hasResendSlot) {
    if (providerMode !== 'resend_then_cloudflare' || !cloudflare) {
      throw new EmailProviderError({
        provider: 'resend',
        kind: 'quota',
        message: 'Resend daily email quota exhausted.',
        providerCode: 'daily_quota_exceeded',
      });
    }
    await recordFallback(env, usageDate);
    const result = await cloudflare.send(payload);
    logSendSuccess(payload, result, 'quota_exhausted');
    return result;
  }

  try {
    const result = await new ResendEmailProvider(resend).send(payload);
    await recordResendSuccess(env, usageDate);
    logSendSuccess(payload, result, 'primary');
    return result;
  } catch (error) {
    const providerError = error instanceof EmailProviderError ? error : classifyThrownResendError(error);
    logProviderFailure(payload, providerError);
    await recordResendFailure(env, usageDate, providerError.kind);
    if (
      providerMode !== 'resend_then_cloudflare'
      || !cloudflare
      || !['quota', 'temporary'].includes(providerError.kind)
    ) throw providerError;

    await recordFallback(env, usageDate);
    try {
      const result = await cloudflare.send(payload);
      logSendSuccess(payload, result, providerError.kind === 'quota' ? 'quota_exhausted' : 'temporary_failure');
      return result;
    } catch (fallbackError) {
      const normalizedFallbackError = fallbackError instanceof EmailProviderError
        ? fallbackError
        : new EmailProviderError({
            provider: 'cloudflare',
            kind: 'permanent',
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
      logProviderFailure(payload, normalizedFallbackError);
      throw new EmailProviderError({
        provider: 'cloudflare',
        kind: 'permanent',
        message: `Email delivery failed in both Resend and Cloudflare: ${normalizedFallbackError.message}`,
        providerCode: 'both_providers_failed',
      });
    }
  }
}
