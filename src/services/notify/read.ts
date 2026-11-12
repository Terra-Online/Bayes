import type { NotificationCategory } from "@/repositories/notifications";
import type { Bindings } from "@/types/app";

export interface NotificationReadChange {
  category: NotificationCategory;
  ids: string[] | null;
  readAt: string;
}

// Called through waitUntil only after the read is persisted.
// Live delivery is best effort; failure must not undo the committed read.
export async function publishNotificationRead(
  env: Bindings,
  userId: string,
  change: NotificationReadChange,
): Promise<void> {
  try {
    const stub = env.OEM_NOTIFICATION_DO.get(env.OEM_NOTIFICATION_DO.idFromName(userId));
    const response = await stub.fetch("https://notify.internal/read", {
      method: "POST",
      headers: { "content-type": "application/json", "x-oem-notify-user": userId },
      body: JSON.stringify(change),
    });
    if (!response.ok) {
      throw new Error(`read fanout failed: ${response.status}`);
    }
  } catch (error) {
    // Leave eligible transport retries to the runtime; log the final failure here.
    console.error("[notify] read sync failed; read remains persisted", { userId, error });
  }
}
