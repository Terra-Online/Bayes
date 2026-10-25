// Public entrypoint for email delivery and business-specific messages.
export { sendAuthOtpEmail, sendPasswordResetEmail } from "./auth";
export { sendEmail, type EmailPayload, type SendEmailResult } from "./sender";
export {
  createModerationWarningEmailTemplate,
  resolveEmailLocale,
  type EmailLocale,
} from "./templates";
