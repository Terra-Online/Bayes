import type { Bindings } from "../../types/app";
import {
  listDispatchableProgressStatsEvents,
  markProgressStatsEventFailed,
  markProgressStatsEventProcessed,
  type ProgressStatsOutboxRecord
} from "./repository";

const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const BASE_RETRY_DELAY_MS = 60_000;

export function progressStatsRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(16, attempts - 1));
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** exponent));
}

async function deliverProgressStatsEvent(
  env: Bindings,
  event: ProgressStatsOutboxRecord
): Promise<void> {
  const stub = env.OEM_STATS_DO.getByName(event.markerIndexHash);
  const response = await stub.fetch("https://progress-stats/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...event.payload, eventId: event.eventId }),
    signal: AbortSignal.timeout(10_000)
  });
  if (response.ok) return;

  const body = await response.text().catch(() => "");
  const error = new Error(`Stats DO returned ${response.status}: ${body.slice(0, 500)}`);
  Object.assign(error, { status: response.status });
  throw error;
}

async function dispatchProgressStatsEvent(
  env: Bindings,
  event: ProgressStatsOutboxRecord
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    await deliverProgressStatsEvent(env, event);
    await markProgressStatsEventProcessed(env.DB, event.eventId, Date.now());
    console.warn("[progress][outbox] delivered", {
      eventId: event.eventId,
      uid: event.uid,
      attempts: event.attempts,
      latencyMs: Date.now() - startedAt
    });
    return true;
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
    const blocked = status >= 400 && status < 500 && status !== 408 && status !== 429;
    const attempts = event.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    await markProgressStatsEventFailed(env.DB, {
      eventId: event.eventId,
      blocked,
      attempts,
      nextAttemptAt: Date.now() + progressStatsRetryDelayMs(attempts),
      error: message
    });

    const log = blocked ? console.error : console.warn;
    log("[progress][outbox] delivery failed", {
      eventId: event.eventId,
      uid: event.uid,
      markerIndexHash: event.markerIndexHash,
      attempts,
      blocked,
      error: message
    });
    return false;
  }
}

export async function drainUserProgressStatsOutbox(
  env: Bindings,
  uid: string,
  maxEvents = 25
): Promise<void> {
  let processed = 0;
  while (processed < maxEvents) {
    const [event] = await listDispatchableProgressStatsEvents(env.DB, Date.now(), 1, uid);
    if (!event) return;
    const delivered = await dispatchProgressStatsEvent(env, event);
    if (!delivered) return;
    processed += 1;
  }
}

export async function drainProgressStatsOutbox(
  env: Bindings,
  maxEvents = 100
): Promise<void> {
  let processed = 0;
  while (processed < maxEvents) {
    const batchSize = Math.min(20, maxEvents - processed);
    const events = await listDispatchableProgressStatsEvents(env.DB, Date.now(), batchSize);
    if (events.length === 0) return;
    await Promise.all(events.map((event) => dispatchProgressStatsEvent(env, event)));
    processed += events.length;
  }
}
