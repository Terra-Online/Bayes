import { createModerationWarningEmailTemplate } from "../../lib/email/templates";
import { sendEmail, type SendEmailResult } from "../../lib/email/sender";
import { getUserByPublicUid, formatPublicUid } from "../../repositories/users";
import type { Bindings } from "../../types/app";

export interface ModerationWarningResult {
  publicUid: string;
  delivery: SendEmailResult;
}

export async function sendModerationWarning(
  env: Bindings,
  input: {
    publicUid: string;
  },
): Promise<ModerationWarningResult | null> {
  const user = await getUserByPublicUid(env.DB, input.publicUid);
  if (!user) return null;

  const publicUid = formatPublicUid(user.uidNumber, user.uidSuffix);
  const content = createModerationWarningEmailTemplate({
    displayName: user.nickname,
    publicUid,
  });
  const delivery = await sendEmail({
    to: user.email,
    from: "OEM Moderation <moderation@opendfieldmap.org>",
    subject: content.subject,
    text: content.text,
    html: content.html,
  }, env);

  return {
    publicUid,
    delivery,
  };
}
