import { getEventUsers } from "@/repositories/notificationSources";
import type { UgcEventReference } from "@/services/ugc/contract/events";
import type { Bindings } from "@/types/app";

import { collectNotifications } from "./collect";
import { publishNotificationsCreated } from "./live";

/** Best effort after domain commit. Explicit sync repairs missed hints within the window. */
export async function hintUgcEvent(env: Bindings, event: UgcEventReference): Promise<void> {
  try {
    const users = await getEventUsers(env.DB, event);
    for (const userId of users) {
      try {
        await publishNotificationsCreated(env, await collectNotifications(env.DB, userId));
      } catch (error) {
        console.error("[notify] event collection failed", { event, userId, error });
      }
    }
  } catch (error) {
    console.error("[notify] event hint failed", { event, error });
  }
}
