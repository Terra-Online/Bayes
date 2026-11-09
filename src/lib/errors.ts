export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error;
  }
  return (
    transientDependencyError(error) ?? new ApiError(500, "INTERNAL_ERROR", "Internal server error.")
  );
}

export function transientDependencyError(error: unknown): ApiError | undefined {
  const messages: string[] = [];
  let current = error;
  let overloaded = false;
  let retryable = false;
  let durableObjectReset = false;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const cause = current as {
      message?: unknown;
      cause?: unknown;
      overloaded?: unknown;
      retryable?: unknown;
      durableObjectReset?: unknown;
    };
    if (typeof cause.message === "string") {
      messages.push(cause.message);
    }
    overloaded ||= cause.overloaded === true;
    retryable ||= cause.retryable === true;
    durableObjectReset ||= cause.durableObjectReset === true;
    current = cause.cause;
  }
  const message = messages.join(" ");
  const d1Failure =
    /\bD1(?:_|\b)/i.test(message) &&
    /overloaded|queued for too long|internal error|reset|temporarily unavailable|network connection lost/i.test(
      message,
    );
  const durableObjectFailure =
    /durable object/i.test(message) &&
    /no longer active|reset|code was updated|overloaded|storage.*(?:inaccessible|timeout|timed out|internal error)/i.test(
      message,
    );
  if (!overloaded && !retryable && !durableObjectReset && !d1Failure && !durableObjectFailure) {
    return undefined;
  }
  return new ApiError(
    503,
    overloaded || /overloaded|queued for too long/i.test(message)
      ? "DEPENDENCY_OVERLOADED"
      : "DEPENDENCY_UNAVAILABLE",
    "A required service is temporarily unavailable. Please try again later.",
  );
}

export function toSerializableError(error: unknown, depth = 0, seen = new Set<unknown>()): unknown {
  if (depth >= 8 || seen.has(error)) {
    return "[cause omitted]";
  }
  if (!error || typeof error !== "object") {
    return error;
  }
  seen.add(error);
  const withCause = error as Error & {
    cause?: unknown;
    code?: unknown;
    status?: unknown;
    statusText?: unknown;
    overloaded?: unknown;
    retryable?: unknown;
    durableObjectReset?: unknown;
  };
  return {
    name: withCause.name,
    message: withCause.message,
    code: withCause.code,
    status: withCause.status,
    statusText: withCause.statusText,
    overloaded: withCause.overloaded,
    retryable: withCause.retryable,
    durableObjectReset: withCause.durableObjectReset,
    cause: withCause.cause ? toSerializableError(withCause.cause, depth + 1, seen) : undefined,
    stack: withCause.stack,
  };
}
