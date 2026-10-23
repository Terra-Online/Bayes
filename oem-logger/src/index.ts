type LoggerEnv = {
  OEM_ERR: D1Database;
};

type FetchEventInfo = {
  request: {
    headers: Record<string, string>;
    method: string;
    url: string;
  };
  response?: {
    status: number;
  };
};

function getFetchEvent(item: TraceItem): FetchEventInfo | null {
  const event = item.event;
  if (!event || !("request" in event)) {
    return null;
  }

  return event as FetchEventInfo;
}

function getEventType(item: TraceItem): string {
  const event = item.event;
  if (!event) {
    return "unknown";
  }
  if ("request" in event) {
    return "fetch";
  }
  if ("queue" in event) {
    return "queue";
  }
  if ("cron" in event) {
    return "scheduled";
  }
  if ("scheduledTime" in event) {
    return "scheduled";
  }
  return "other";
}

export type ErrorReason = "http_5xx" | "runtime_exception" | "console_error" | "outcome_failure";

export function getErrorReasons(item: TraceItem): ErrorReason[] | null {
  const fetchEvent = getFetchEvent(item);
  const status = fetchEvent?.response?.status;
  const hasServerError = typeof status === "number" && status >= 500;
  const hasErrorLog = item.logs.some((log) => log.level === "error");
  if (
    item.scriptName === "oem-backend" &&
    item.outcome === "exception" &&
    item.wallTime >= 5 * 60_000 &&
    fetchEvent?.request.method === "GET" &&
    fetchEvent.request.headers.upgrade?.toLowerCase() === "websocket" &&
    URL.canParse(fetchEvent.request.url) &&
    new URL(fetchEvent.request.url).pathname === "/locator/position-stream" &&
    (status === undefined || status < 500) &&
    item.exceptions.length === 1 &&
    item.exceptions[0]?.message === "Network connection lost." &&
    !hasErrorLog
  ) {
    return null;
  }

  // Cancellation alone (including its routine transport exception) is not an error.
  const hasException = item.exceptions.some(
    (exception) => item.outcome !== "canceled" || exception.message !== "Network connection lost.",
  );
  const hasRuntimeException = item.outcome === "exception" || hasException;
  const hasFailedOutcome =
    item.outcome !== "ok" && item.outcome !== "canceled" && item.outcome !== "exception";
  if (!hasServerError && !hasRuntimeException && !hasErrorLog && !hasFailedOutcome) {
    return null;
  }

  const reasons: ErrorReason[] = [];
  if (hasServerError) {
    reasons.push("http_5xx");
  }
  if (hasRuntimeException) {
    reasons.push("runtime_exception");
  }
  if (hasErrorLog) {
    reasons.push("console_error");
  }
  if (hasFailedOutcome) {
    reasons.push("outcome_failure");
  }
  return reasons;
}

export function isErrorTrace(item: TraceItem): boolean {
  return getErrorReasons(item) !== null;
}

function makeErrorId(item: TraceItem, fetchEvent: FetchEventInfo | null, index: number): string {
  const rayId = fetchEvent?.request.headers["cf-ray"] ?? "no-ray";
  const suffix = rayId === "no-ray" ? crypto.randomUUID() : rayId;
  return `${item.eventTimestamp ?? Date.now()}-${suffix}-${index}`;
}

function writeErrors(
  items: { item: TraceItem; reasons: ErrorReason[] }[],
  db: D1Database,
  receivedAtMs: number,
): Promise<void> {
  const statements = items.map(({ item, reasons }, index) => {
    const fetchEvent = getFetchEvent(item);
    const status = fetchEvent?.response?.status ?? null;
    const errorLogCount = item.logs.reduce(
      (count, log) => count + (log.level === "error" ? 1 : 0),
      0,
    );
    const requestHeaders = fetchEvent?.request.headers;
    const rayId = requestHeaders?.["cf-ray"] ?? null;
    const requestId = requestHeaders?.["x-request-id"] ?? null;

    return db
      .prepare(`
      INSERT OR IGNORE INTO worker_errors (
        id,
        event_timestamp_ms,
        received_at_ms,
        script_name,
        event_type,
        method,
        url,
        status,
        outcome,
        ray_id,
        request_id,
        exception_count,
        error_log_count,
        cpu_time_ms,
        wall_time_ms,
        truncated,
        payload_json,
        error_reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        makeErrorId(item, fetchEvent, index),
        item.eventTimestamp ?? receivedAtMs,
        receivedAtMs,
        item.scriptName,
        getEventType(item),
        fetchEvent?.request.method ?? null,
        fetchEvent?.request.url ?? null,
        status,
        item.outcome,
        rayId,
        requestId,
        item.exceptions.length,
        errorLogCount,
        item.cpuTime,
        item.wallTime,
        item.truncated ? 1 : 0,
        JSON.stringify(item),
        JSON.stringify(reasons),
      );
  });

  return db.batch(statements).then(() => undefined);
}

export default {
  tail(events: TraceItem[], env: LoggerEnv, ctx: ExecutionContext): void {
    // Keep the hot path to a few scalar checks; serialize and write only failures.
    let errors: { item: TraceItem; reasons: ErrorReason[] }[] | undefined;
    for (const item of events) {
      const reasons = getErrorReasons(item);
      if (reasons) {
        (errors ??= []).push({ item, reasons });
      }
    }
    if (!errors) {
      return;
    }

    ctx.waitUntil(
      writeErrors(errors, env.OEM_ERR, Date.now()).catch((error) => {
        console.error("[oem-errogger] failed to persist worker errors", {
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  },

  scheduled(_controller: ScheduledController, env: LoggerEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(
      env.OEM_ERR.prepare(`
        DELETE FROM worker_errors
        WHERE event_timestamp_ms < (unixepoch('now', '-120 days') * 1000)
      `)
        .run()
        .catch((error) => {
          console.error("[oem-errogger] failed to clean expired worker errors", {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  },
};
