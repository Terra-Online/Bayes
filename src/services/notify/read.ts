import type { NotificationCategory } from "@/repositories/notifications";
import type { Bindings } from "@/types/app";

export interface NotificationReadChange {
  category: NotificationCategory;
  ids: string[] | null;
  readAt: string;
}

// A live-delivery failure must not turn a committed read into a failed request.
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
    console.error("[notify] read sync failed; read remains persisted", { userId, error });
  }
}
