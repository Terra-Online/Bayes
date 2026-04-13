import { Resend } from 'resend';
import { envOrThrow } from './utils';
import { Bindings } from '../types/app';

let resend: Resend | undefined = undefined;

let fromAddress = 'noreply@opendfieldmap.org';

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function initResend(env: Bindings) {
  resend = new Resend(envOrThrow(env.RESEND_AUTH_KEY, 'RESEND_AUTH_KEY'));
  if (env.RESEND_FROM_EMAIL && env.RESEND_FROM_EMAIL.trim().length > 0) {
    fromAddress = env.RESEND_FROM_EMAIL.trim();
  }
}

export function sendEmail(payload: EmailPayload) {
  if (!resend) {
    console.warn('[email] resend is not initialized, skipped sending email');
    return;
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
  }).catch((error: unknown) => {
    console.error('[email] send failed', {
      to: payload.to,
      subject: payload.subject,
      error,
    });
    throw error;
  });
}