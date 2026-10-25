import type { Bindings } from "@/types/app";

import { sendEmail, type SendEmailResult } from "./sender";
import {
  createOtpEmailTemplate,
  createResetPasswordMagicLinkTemplate,
  type EmailLocale,
} from "./templates";

export async function sendAuthOtpEmail(
  env: Bindings,
  input: { to: string; locale: EmailLocale; otp: string },
): Promise<SendEmailResult> {
  const content = createOtpEmailTemplate(input);
  return sendEmail({ to: input.to, ...content }, env);
}

export async function sendPasswordResetEmail(
  env: Bindings,
  input: { to: string; locale: EmailLocale; url: string },
): Promise<SendEmailResult> {
  const content = createResetPasswordMagicLinkTemplate(input);
  return sendEmail({ to: input.to, ...content }, env);
}
