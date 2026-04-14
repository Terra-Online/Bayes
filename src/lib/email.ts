import { Resend } from 'resend';
import { envOrThrow } from './utils';
import { Bindings } from '../types/app';

let resend: Resend | undefined = undefined;

let fromAddress = 'noreply@opendfieldmap.org';

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

  if (!match) {
    return normalized;
  }

  const displayName = stripOuterQuotes(match[1]?.trim() ?? '');
  const email = stripOuterQuotes(match[2]?.trim() ?? '');
  if (!email) {
    return normalized;
  }

  if (!displayName) {
    return email;
  }

  return `${displayName} <${email}>`;
}

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  id?: string;
}

export function initResend(env: Bindings) {
  resend = new Resend(envOrThrow(env.RESEND_AUTH_KEY, 'RESEND_AUTH_KEY'));
  if (env.RESEND_FROM_EMAIL && env.RESEND_FROM_EMAIL.trim().length > 0) {
    fromAddress = normalizeFromAddress(env.RESEND_FROM_EMAIL);
  }

  if (env.RESEND_FROM_NAME && env.RESEND_FROM_NAME.trim().length > 0 && !fromAddress.includes('<')) {
    fromAddress = `${env.RESEND_FROM_NAME.trim()} <${fromAddress}>`;
  }
}

export async function sendEmail(payload: EmailPayload): Promise<SendEmailResult> {
  if (!resend) {
    throw new Error('RESEND_NOT_INITIALIZED');
  }

  return resend.emails.send({
    from: fromAddress,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  }).then((result) => {
    if (result.error) {
      console.error('[email] send rejected by provider', {
        to: payload.to,
        subject: payload.subject,
        error: result.error,
      });
      throw new Error(result.error.message || 'Resend rejected email send request.');
    }

    console.warn('[email] send success', {
      id: result?.data?.id,
      to: payload.to,
      subject: payload.subject,
    });

    return {
      id: result?.data?.id,
    };
  }).catch((error: unknown) => {
    console.error('[email] send failed', {
      to: payload.to,
      subject: payload.subject,
      error,
    });
    throw error;
  });
}