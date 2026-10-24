import {
  AI_ACTIVE_MODERATION_NOTE_PREFIX,
  AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX,
  AI_STALE_MODERATION_NOTE_PREFIX,
  RECALL_MODERATION_NOTE_PREFIX,
} from "@/lib/moderation";
import type { SubmissionStatus } from "@/repositories/submission/types";

import type {
  ContributionReviewEvidence,
  ContributionReviewProjection,
  ReviewKey,
  ReviewStep,
} from "./contract/contributions";

function visibilityFor(status: SubmissionStatus): ContributionReviewProjection["visibility"] {
  if (status === "active" || status === "flagged" || status === "remove_request") {
    return "public";
  }
  if (status === "stale") {
    return "unavailable";
  }
  return "private";
}

function reviewPath(evidence: ContributionReviewEvidence): ReviewStep[] {
  const path: ReviewStep[] = [{ key: "uploaded", at: evidence.createdAt }];
  const add = (key: ReviewKey, at: string | null) => {
    const last = path.at(-1);
    if (last?.key === key) {
      last.at = at ?? last.at;
    } else {
      path.push({ key, at });
    }
  };
  const { events, legacy } = evidence;
  // Notifications retained only some older transitions. Seed known earlier
  // stages, but do not claim an interrupted AI review was completed.
  const firstTime = events[0]?.at;
  if (!events.length && !legacy.manualAt && !legacy.publicAt) {
    // Fixed prefixes were written by older moderation code; they can confirm
    // stages even when no notification timestamp survives.
    const note = legacy.moderationNote;
    if (note?.startsWith(AI_ACTIVE_MODERATION_NOTE_PREFIX)) {
      add("ai", null);
      add("public", null);
    } else if (note?.startsWith(AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX)) {
      add("ai", null);
      add("manual", null);
    } else if (note?.startsWith(AI_STALE_MODERATION_NOTE_PREFIX)) {
      add("ai", null);
      add("archived", evidence.status === "stale" ? evidence.updatedAt : null);
      if (evidence.status !== "stale") {
        add("manual", null);
      }
    }
  }
  if (legacy.manualAt && (!firstTime || Date.parse(legacy.manualAt) < Date.parse(firstTime))) {
    add("ai", legacy.manualAt);
    add("manual", legacy.manualAt);
  }
  if (legacy.publicAt && (!firstTime || Date.parse(legacy.publicAt) < Date.parse(firstTime))) {
    if (
      !path.some((step) => step.key === "manual") &&
      legacy.moderationNote?.startsWith(AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX)
    ) {
      add("ai", null);
      add("manual", legacy.publicAt);
    } else if (!path.some((step) => step.key === "manual") && !legacy.hasManualEvidence) {
      add("ai", legacy.publicAt);
    } else {
      add("manual", legacy.publicAt);
    }
    add("public", legacy.publicAt);
  }
  if (
    !events.length &&
    legacy.hasPublicationEvidence &&
    !path.some((step) => step.key === "public")
  ) {
    add("public", null);
  }
  for (const event of events) {
    // The first captured event may start after unrecorded historical stages.
    if (event.from === "pending_audit" && !path.some((step) => step.key === "manual")) {
      add("manual", null);
    }
    if (
      ["active", "flagged", "remove_request"].includes(event.from) &&
      path.at(-1)?.key !== "public"
    ) {
      add("public", null);
    }
    if (event.from === "stale" && path.at(-1)?.key !== "archived") {
      add("archived", null);
    }

    if (event.source === "auto_moderation" && event.aiReviewed && event.from === "pending_openai") {
      add("ai", event.at);
    }
    if (event.source === "manual_moderation") {
      add("manual", event.at);
    }
    if (event.source === "user_action" && event.to === "stale") {
      let interrupted = null;
      if (event.from === "pending_openai") {
        interrupted = "ai";
      } else if (event.from === "pending_audit") {
        interrupted = "manual";
      }
      if (path.at(-1)?.key === interrupted) {
        path.pop();
      }
    }
    if (event.to === "pending_audit") {
      add("manual", event.at);
    }
    if (event.to === "active") {
      add("public", event.at);
    }
    if (event.to === "stale") {
      add("archived", event.at);
    }
  }
  if (
    !events.length &&
    evidence.status === "stale" &&
    !legacy.hasPublicationEvidence &&
    legacy.moderationNote?.startsWith(RECALL_MODERATION_NOTE_PREFIX) &&
    path.at(-1)?.key === "manual"
  ) {
    path.pop();
  }
  // Preserve the latest event time when a submission has been restored/reviewed
  // more than once. The notification timestamp may describe its first approval.
  let current: ReviewStep;
  switch (evidence.status) {
    case "pending_openai":
      current = { key: "ai", at: evidence.updatedAt };
      break;
    case "pending_audit":
      current = { key: "manual", at: legacy.manualAt ?? evidence.updatedAt };
      break;
    case "stale":
      current = { key: "archived", at: evidence.updatedAt };
      break;
    default:
      current = { key: "public", at: legacy.publicAt };
  }
  const last = path.at(-1);
  if (last?.key !== current.key) {
    add(current.key, current.at);
  } else {
    last.at ??= current.at;
  }
  return path;
}

export function projectContributionReview(
  evidence: ContributionReviewEvidence,
): ContributionReviewProjection {
  const path = reviewPath(evidence);
  const times: ContributionReviewProjection["review"]["times"] = {
    uploaded: null,
    ai: null,
    manual: null,
    public: null,
    archived: null,
  };
  let manual = false;
  let published = false;
  for (const step of path) {
    times[step.key] = step.at;
    if (step.key === "manual") {
      manual = true;
    } else if (step.key === "public") {
      published = true;
    }
  }
  return {
    visibility: visibilityFor(evidence.status),
    review: {
      manual,
      published,
      times,
      path,
    },
  };
}
