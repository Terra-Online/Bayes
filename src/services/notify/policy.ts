import type { NotificationType } from "@/repositories/notifications";

import type { InboxDelivery, NotificationFact } from "./contract/events";

// Set a rule's effective date when introducing it so dormant users do not receive
// newly eligible historical activity. Source cutover separately excludes imported audits.
const effectiveFrom = {
  "system.submission.approved": "1970-01-01T00:00:00.000Z",
  "system.submission.needs_review": "1970-01-01T00:00:00.000Z",
  "community.comment.reply": "1970-01-01T00:00:00.000Z",
  "community.comment.vote": "1970-01-01T00:00:00.000Z",
};
export function deliveriesForFact(fact: NotificationFact, userId: string): InboxDelivery[] {
  let type: NotificationType;
  let dedupeKey: string;
  if (fact.source === "vote") {
    if (fact.ownerId !== userId || fact.next !== "1" || fact.actorId === userId) {
      return [];
    }
    type = "community.comment.vote";
    dedupeKey = `vote:${fact.id}`;
  } else if (
    fact.operation === "review" &&
    fact.ownerId === userId &&
    ["approved", "pending_audit"].includes(fact.next)
  ) {
    type =
      fact.next === "approved" ? "system.submission.approved" : "system.submission.needs_review";
    dedupeKey = `system:${fact.submissionId}:${fact.snapshotId}:${fact.previous}:${fact.next}`;
  } else if (
    fact.operation === "review" &&
    fact.firstPublication &&
    fact.parentOwnerId === userId &&
    fact.ownerId !== userId
  ) {
    type = "community.comment.reply";
    dedupeKey = `reply:${fact.submissionId}`;
  } else {
    return [];
  }
  if (fact.createdAt < effectiveFrom[type]) {
    return [];
  }
  return [
    {
      id: `${fact.source}:${fact.id}:${type.startsWith("system.") ? "author" : "community"}`,
      recipientUserId: userId,
      category: type.startsWith("system.") ? "system" : "community",
      type,
      actorUserId: type.startsWith("system.") ? null : fact.actorId,
      submissionId: fact.submissionId,
      parentSubmissionId: fact.parentId,
      markerId: fact.markerId,
      poiHash: fact.poiHash,
      poiType: fact.poiType,
      payload: { kind: fact.kind },
      dedupeKey,
      createdAt: fact.createdAt,
      readAt: null,
      source: fact.source,
      eventId: fact.id,
      purpose: type,
    },
  ];
}
