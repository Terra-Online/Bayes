import type { ModerationNotificationEvent } from "@/services/moderation/messages";
import type { Bindings } from "@/types/app";

export async function enqueueModerationNotification(
  env: Bindings,
  event: ModerationNotificationEvent,
): Promise<void> {
  await env.OEM_WEBHOOK_Q.send({
    type: "discord_notification",
    event,
    queuedAt: new Date().toISOString(),
  });
}
