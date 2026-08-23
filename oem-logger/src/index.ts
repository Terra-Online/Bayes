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
  if (!event) return "unknown";
  if ("request" in event) return "fetch";
  if ("queue" in event) return "queue";
  if ("cron" in event) return "scheduled";
  if ("scheduledTime" in event) return "scheduled";
  return "other";
}

export function isErrorTrace(item: TraceItem): boolean {
  const fetchEvent = getFetchEvent(item);
  const status = fetchEvent?.response?.status;
  return Boolean(
    (typeof status === "number" && status >= 500) ||
    item.outcome !== "ok" ||
    item.exceptions.length > 0 ||
    item.logs.some((log) => log.level === "error")
  );
}

function makeErrorId(item: TraceItem, fetchEvent: FetchEventInfo | null, index: number): string {
  const rayId = fetchEvent?.request.headers["cf-ray"] ?? "no-ray";
  const suffix = rayId === "no-ray" ? crypto.randomUUID() : rayId;
  return `${item.eventTimestamp ?? Date.now()}-${suffix}-${index}`;
}

function writeErrors(
  items: TraceItem[],
  db: D1Database,
  receivedAtMs: number
): Promise<void> {
  const statements = items.map((item, index) => {
    const fetchEvent = getFetchEvent(item);
    const status = fetchEvent?.response?.status ?? null;
    const errorLogCount = item.logs.reduce(
      (count, log) => count + (log.level === "error" ? 1 : 0),
      0
    );
    const requestHeaders = fetchEvent?.request.headers;
    const rayId = requestHeaders?.["cf-ray"] ?? null;
    const requestId = requestHeaders?.["x-request-id"] ?? null;

    return db.prepare(`
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
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
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
      JSON.stringify(item)
    );
  });

  return db.batch(statements).then(() => undefined);
}

export default {
  tail(events: TraceItem[], env: LoggerEnv, ctx: ExecutionContext): void {
    // Keep the hot path to a few scalar checks; serialize and write only failures.
    let errors: TraceItem[] | undefined;
    for (const item of events) {
      if (isErrorTrace(item)) {
        (errors ??= []).push(item);
      }
    }
    if (!errors) return;

    ctx.waitUntil(
      writeErrors(errors, env.OEM_ERR, Date.now()).catch((error) => {
        console.error("[oem-errogger] failed to persist worker errors", {
          error: error instanceof Error ? error.message : String(error)
        });
      })
    );
  },

  scheduled(_controller: ScheduledController, env: LoggerEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(
      env.OEM_ERR.prepare(`
        DELETE FROM worker_errors
        WHERE event_timestamp_ms < (unixepoch('now', '-120 days') * 1000)
      `).run().catch((error) => {
        console.error("[oem-errogger] failed to clean expired worker errors", {
          error: error instanceof Error ? error.message : String(error)
        });
      })
    );
  }
};
