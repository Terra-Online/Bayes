import { Resend } from 'resend';
import { envOrThrow } from './utils';
import { Bindings } from '../types/app';

let resend: Resend | undefined = undefined;

const defaultEmailPayload = {
  from: 'noreply@opendfieldmap.org',
};

export function initResend(env: Bindings) {
  resend = new Resend(envOrThrow(env.RESEND_AUTH_KEY, 'RESEND_AUTH_KEY'));
}

export function sendEmail(to: string, content: string, subject: string) {
  void resend?.emails.send({
    ...defaultEmailPayload,
    to,
    subject,
    text: content,
  });
}