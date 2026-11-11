import type { NotificationRecord, NotificationType } from "@/repositories/notifications";
import type { UgcEventReference } from "@/services/ugc/contract/events";

export type EventSource = UgcEventReference["source"];

export interface CollectionPosition {
  source: EventSource;
  after: number;
  upper: number;
  enabledFrom: string;
}

export interface NotificationFact {
  source: EventSource;
  sequence: number;
  id: string;
  ownerId: string;
  parentOwnerId: string | null;
  actorId: string | null;
  kind: "comment" | "image";
  submissionId: string;
  snapshotId: string | null;
  parentId: string | null;
  markerId: string;
  poiHash: string;
  poiType: string;
  createdAt: string;
  previous: string;
  next: string;
  operation: string;
  firstPublication: number;
}

export interface InboxDelivery extends NotificationRecord {
  source: EventSource;
  eventId: string;
  purpose: NotificationType;
}
