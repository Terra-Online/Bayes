import { expect, it } from "vitest";

import { serializeNotificationItem, type NotificationRecord } from "./notifications";

it("serializes one destination and strips internal or historical payload metadata", () => {
  const record: NotificationRecord = {
    id: "one",
    recipientUserId: "owner",
    category: "community",
    type: "community.comment.reply",
    actorUserId: "actor",
    submissionId: "reply",
    parentSubmissionId: "parent",
    markerId: "point",
    poiHash: "hash",
    poiType: "poi",
    payload: { kind: "comment", note: "private", actor: { email: "private" } },
    dedupeKey: "reply:one",
    createdAt: "2026-11-11T00:00:00.000Z",
    readAt: null,
  };
  expect(serializeNotificationItem(record)).toEqual({
    id: "one",
    type: "community.comment.reply",
    payload: { kind: "comment" },
    target: {
      submissionId: "reply",
      parentSubmissionId: "parent",
      markerId: "point",
      poiHash: "hash",
      poiType: "poi",
    },
    createdAt: "2026-11-11T00:00:00.000Z",
    readAt: null,
    isMultiMsg: false,
    messages: [],
  });
});
