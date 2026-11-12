import { commitCollection } from "@/repositories/notificationCollection";
import type { NotificationRecord } from "@/repositories/notifications";
import { getCollectionPositions, readNotificationFacts } from "@/repositories/notificationSources";

import type { EventSource } from "./contract/events";
import { deliveriesForFact } from "./policy";

const COLLECTION_LIMIT = 200;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function collectNotifications(
  db: D1Database,
  userId: string,
): Promise<NotificationRecord[]> {
  const notifications: NotificationRecord[] = [];
  const completed = new Set<EventSource>();
  // Capture heads before time: later commits remain beyond these heads for the next run.
  const heads = await getCollectionPositions(db, userId);
  const now = new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - WINDOW_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const positions =
      attempt === 0
        ? heads
        : (await getCollectionPositions(db, userId)).map((position) => ({
            ...position,
            upper: heads.find((head) => head.source === position.source)!.upper,
          }));
    const pending = positions.filter(
      (position) => !completed.has(position.source) && position.after < position.upper,
    );
    const pages = await readNotificationFacts(
      db,
      userId,
      pending,
      cutoff,
      now,
      COLLECTION_LIMIT + 1,
    );
    let conflict = false;
    for (const [index, position] of pending.entries()) {
      const facts = pages[index];
      const page = facts.slice(0, COLLECTION_LIMIT);
      const next =
        facts.length > COLLECTION_LIMIT ? page[page.length - 1].sequence : position.upper;
      const deliveries = page.flatMap((fact) => deliveriesForFact(fact, userId));
      const result = await commitCollection(db, userId, position, next, deliveries, now);
      notifications.push(...result.notifications);
      if (!result.committed) {
        conflict = true;
      } else {
        completed.add(position.source);
      }
    }
    if (!conflict) {
      break;
    }
  }
  return notifications;
}
