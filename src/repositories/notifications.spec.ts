import { describe, expect, it } from "vitest";
import {
  notificationTypeForTransition,
  prepareCommentVoteNotificationWrite,
  prepareImageUpvoteNotificationWrite,
  serializeNotificationItem,
  type NotificationMessageRecord,
  type NotificationRecord
} from "./notifications";

const target = {
  submissionId: "submission-1",
  parentSubmissionId: null,
  markerId: "marker-1",
  poiHash: "hash-1",
  poiType: "type-1"
};

const message = (
  id: string,
  overrides: Partial<NotificationMessageRecord> = {}
): NotificationMessageRecord => ({
  id,
  notificationId: "notification-1",
  actorUserId: null,
  ...target,
  payload: { kind: "image", source: "auto_moderation", snapshotId: "snapshot-1" },
  dedupeKey: `event:${id}`,
  createdAt: `2026-08-02T10:00:0${id}.000Z`,
  ...overrides
});

const notification = (
  messages: NotificationMessageRecord[],
  overrides: Partial<NotificationRecord> = {}
): NotificationRecord => ({
  id: "notification-1",
  recipientUserId: "user-1",
  category: "system",
  type: "system.submission.approved",
  actorUserId: null,
  ...target,
  payload: { kind: "image" },
  dedupeKey: "group:notification-1",
  readAt: null,
  createdAt: "2026-08-02T10:00:02.000Z",
  windowStartedAt: "2026-08-02T10:00:01.000Z",
  windowExpiresAt: "2026-08-02T10:01:01.000Z",
  messageCount: Math.max(1, messages.length),
  messages,
  ...overrides
});

describe("notification types", () => {
  it("keeps the five user-facing transition types and suppresses management rejection", () => {
    expect(notificationTypeForTransition("pending_openai", "active")).toBe("system.submission.approved");
    expect(notificationTypeForTransition("pending_openai", "pending_audit")).toBe("system.submission.needs_review");
    expect(notificationTypeForTransition("remove_request", "stale")).toBe("system.remove_request.resolved");
    expect(notificationTypeForTransition("remove_request", "active")).toBe("system.remove_request.resolved");
    expect(notificationTypeForTransition("pending_audit", "stale")).toBeNull();
    expect(notificationTypeForTransition("active", "stale", "user_action")).toBe("system.remove_request.resolved");
  });

  it("does not prepare a notification write for a downvote", () => {
    const statements = prepareCommentVoteNotificationWrite({} as D1Database, {
      submissionId: "submission-1",
      actor: {
        uid: "actor-1",
        publicUid: "10001",
        nickname: "Actor",
        avatar: 1,
        email: "actor@example.com",
        role: "n",
        karma: 0,
        needsProfileSetup: false
      },
      value: -1,
      changedAt: "2026-08-02T10:00:00.000Z"
    });
    expect(statements).toEqual([]);
  });

  it("uses the community vote type for image upvotes", () => {
    const statement = {
      bind: () => statement
    } as unknown as D1PreparedStatement;
    const statements = prepareImageUpvoteNotificationWrite({
      prepare: () => statement
    } as unknown as D1Database, {
      submissionId: "image-1",
      actor: {
        uid: "actor-1",
        publicUid: "10001",
        nickname: "Actor",
        avatar: 1,
        email: "actor@example.com",
        role: "n",
        karma: 0,
        needsProfileSetup: false
      },
      changedAt: "2026-08-02T10:00:00.000Z"
    });
    expect(statements).toHaveLength(4);
  });
});

describe("notification serialization", () => {
  it("returns only the frontend-required system payload", () => {
    const serialized = serializeNotificationItem(notification([message("1")]));
    expect(serialized.isMultiMsg).toBe(false);
    expect(serialized.messages).toEqual([]);
    expect(serialized.payload).toEqual({ kind: "image" });
    expect("category" in serialized).toBe(false);
    expect(serialized.target.markerId).toBe("marker-1");
  });

  it("returns a folded payload and preserves per-message targets", () => {
    const serialized = serializeNotificationItem(notification([
      message("1"),
      message("2", { submissionId: "submission-2", markerId: "marker-2" })
    ]));
    expect(serialized.isMultiMsg).toBe(true);
    expect(serialized.payload).toEqual({ kind: "image", messageCount: 2 });
    expect(serialized.target.submissionId).toBeNull();
    expect(serialized.target.markerId).toBeNull();
    expect(serialized.target.poiType).toBeNull();
    expect(serialized.messages.map((item) => item.target.markerId)).toEqual(["marker-1", "marker-2"]);
  });

  it("does not expose legacy actor or comment fields", () => {
    const serialized = serializeNotificationItem(notification([], {
      category: "community",
      type: "community.comment.reply",
      payload: {
        actor: { uid: "actor-1", nickname: "Actor", avatar: 3 },
        commentSnippet: "Reply",
        source: "manual_moderation"
      }
    }));
    expect(serialized.payload).toEqual({ kind: "comment" });
  });
});
