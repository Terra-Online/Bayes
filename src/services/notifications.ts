import type { AuthUser, Bindings } from "../types/app";
import type { SubmissionKind, SubmissionRecord, SubmissionStatus } from "../repositories/submissions";

const DEFAULT_DISCORD_MODERATION_WEBHOOK_URL =
  "https://discord.com/api/webhooks/1503720535593451663/a6HnfmXj5UfV_5Mpcbkt13e6YvTt5jR9RM9w-82Sps30dWwdiGcaRcAc-Jxrb-4Weo_X";
const DISCORD_WEBHOOK_TIMEOUT_MS = 5_000;

type ModerationNotificationEvent =
  | {
      type: "pending_openai_completed";
      mode: "queue" | "selected";
      requested: number;
      processed: number;
      pendingAudit: number;
      stale: number;
    }
  | {
      type: "flag_created" | "flag_removed";
      submission: SubmissionRecord;
      actor: AuthUser;
      changed: boolean;
      flagCount: number;
      previousStatus: SubmissionStatus;
      nextStatus: SubmissionStatus;
    }
  | {
      type: "remove_request_created" | "remove_request_cancelled";
      submission: SubmissionRecord;
      actor: AuthUser;
      previousStatus: SubmissionStatus;
      nextStatus: SubmissionStatus;
      flagCount?: number;
      source: "remove_request" | "recall";
    };

export interface PendingOpenAICompletionStats {
  processed: number;
  pendingAudit: number;
  stale: number;
}

export function createEmptyPendingOpenAICompletionStats(): PendingOpenAICompletionStats {
  return {
    processed: 0,
    pendingAudit: 0,
    stale: 0
  };
}

export function recordPendingOpenAICompletionStatus(
  stats: PendingOpenAICompletionStats,
  status: SubmissionStatus
): void {
  stats.processed += 1;
  if (status === "pending_audit") {
    stats.pendingAudit += 1;
  } else if (status === "stale") {
    stats.stale += 1;
  }
}

export async function notifyPendingOpenAICompleted(
  env: Bindings,
  payload: {
    mode: "queue" | "selected";
    requested: number;
    stats: PendingOpenAICompletionStats;
  }
): Promise<void> {
  if (payload.stats.processed === 0) {
    return;
  }

  await sendModerationNotification(env, {
    type: "pending_openai_completed",
    mode: payload.mode,
    requested: payload.requested,
    processed: payload.stats.processed,
    pendingAudit: payload.stats.pendingAudit,
    stale: payload.stats.stale
  });
}

export async function notifyFlagCreated(
  env: Bindings,
  payload: {
    submission: SubmissionRecord;
    actor: AuthUser;
    changed: boolean;
    flagCount: number;
    nextStatus: SubmissionStatus;
  }
): Promise<void> {
  await sendModerationNotification(env, {
    type: "flag_created",
    submission: payload.submission,
    actor: payload.actor,
    changed: payload.changed,
    flagCount: payload.flagCount,
    previousStatus: payload.submission.status,
    nextStatus: payload.nextStatus
  });
}

export async function notifyFlagRemoved(
  env: Bindings,
  payload: {
    submission: SubmissionRecord;
    actor: AuthUser;
    changed: boolean;
    flagCount: number;
    nextStatus: SubmissionStatus;
  }
): Promise<void> {
  await sendModerationNotification(env, {
    type: "flag_removed",
    submission: payload.submission,
    actor: payload.actor,
    changed: payload.changed,
    flagCount: payload.flagCount,
    previousStatus: payload.submission.status,
    nextStatus: payload.nextStatus
  });
}

export async function notifyRemoveRequestCreated(
  env: Bindings,
  payload: {
    submission: SubmissionRecord;
    actor: AuthUser;
    nextStatus: SubmissionStatus;
    source: "remove_request" | "recall";
  }
): Promise<void> {
  await sendModerationNotification(env, {
    type: "remove_request_created",
    submission: payload.submission,
    actor: payload.actor,
    previousStatus: payload.submission.status,
    nextStatus: payload.nextStatus,
    source: payload.source
  });
}

export async function notifyRemoveRequestCancelled(
  env: Bindings,
  payload: {
    submission: SubmissionRecord;
    actor: AuthUser;
    nextStatus: SubmissionStatus;
    flagCount: number;
  }
): Promise<void> {
  await sendModerationNotification(env, {
    type: "remove_request_cancelled",
    submission: payload.submission,
    actor: payload.actor,
    previousStatus: payload.submission.status,
    nextStatus: payload.nextStatus,
    flagCount: payload.flagCount,
    source: "remove_request"
  });
}

async function sendModerationNotification(env: Bindings, event: ModerationNotificationEvent): Promise<void> {
  const webhookUrl = resolveModerationWebhookUrl(env);
  if (!webhookUrl) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify(formatDiscordWebhookPayload(event))
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn("Discord moderation notification failed", {
        status: response.status,
        detail: detail.slice(0, 240)
      });
    }
  } catch (error) {
    console.warn("Discord moderation notification failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timeout);
  }
}

function resolveModerationWebhookUrl(env: Bindings): string {
  return (env.DISCORD_MODERATION_WEBHOOK_URL ?? DEFAULT_DISCORD_MODERATION_WEBHOOK_URL).trim();
}

function formatDiscordWebhookPayload(event: ModerationNotificationEvent): Record<string, unknown> {
  if (event.type === "pending_openai_completed") {
    return {
      username: "OEM Moderation",
      embeds: [
        {
          title: "OpenAI moderation completed",
          color: event.stale > 0 ? 0xd83c3e : 0x2f855a,
          fields: [
            { name: "mode", value: event.mode, inline: true },
            { name: "requested", value: String(event.requested), inline: true },
            { name: "processed", value: String(event.processed), inline: true },
            { name: "pending_audit", value: String(event.pendingAudit), inline: true },
            { name: "stale", value: String(event.stale), inline: true }
          ],
          timestamp: new Date().toISOString()
        }
      ]
    };
  }

  const actionTitle = {
    flag_created: "Flag created",
    flag_removed: "Flag removed",
    remove_request_created: "Remove request created",
    remove_request_cancelled: "Remove request cancelled"
  }[event.type];

  const fields = [
    ...submissionFields(event.submission),
    ...actorFields(event.actor),
    { name: "status", value: `${event.previousStatus} -> ${event.nextStatus}`, inline: true }
  ];

  if (isFlagNotificationEvent(event)) {
    fields.push(
      { name: "flag_changed", value: String(event.changed), inline: true },
      { name: "flag_count", value: String(event.flagCount), inline: true }
    );
  } else {
    fields.push({ name: "source", value: event.source, inline: true });
    if (typeof event.flagCount === "number") {
      fields.push({ name: "flag_count", value: String(event.flagCount), inline: true });
    }
  }

  return {
    username: "OEM Moderation",
    embeds: [
      {
        title: actionTitle,
        color: event.type === "flag_removed" || event.type === "remove_request_cancelled" ? 0x3182ce : 0xdd6b20,
        fields,
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function submissionFields(submission: SubmissionRecord): Array<{ name: string; value: string; inline: boolean }> {
  return [
    { name: "submission", value: submission.id, inline: true },
    { name: "kind", value: formatKind(submission.kind), inline: true },
    { name: "marker", value: truncateFieldValue(submission.markerId), inline: true },
    { name: "uploader", value: formatSubmitter(submission), inline: true }
  ];
}

function isFlagNotificationEvent(
  event: ModerationNotificationEvent
): event is Extract<ModerationNotificationEvent, { type: "flag_created" | "flag_removed" }> {
  return event.type === "flag_created" || event.type === "flag_removed";
}

function actorFields(actor: AuthUser): Array<{ name: string; value: string; inline: boolean }> {
  return [
    { name: "actor", value: `${actor.nickname} (${actor.publicUid})`, inline: true },
    { name: "actor_role", value: actor.role, inline: true }
  ];
}

function formatKind(kind: SubmissionKind): string {
  return kind;
}

function formatSubmitter(submission: SubmissionRecord): string {
  if (submission.submitter?.nickname && submission.submitter.publicUid) {
    return `${submission.submitter.nickname} (${submission.submitter.publicUid})`;
  }
  return submission.userId;
}

function truncateFieldValue(value: string): string {
  return value.length > 512 ? `${value.slice(0, 509)}...` : value;
}
