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

export function transientDependencyError(error: unknown): ApiError | undefined {
  const messages: string[] = [];
  let current = error;
  let overloaded = false;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const cause = current as { message?: unknown; cause?: unknown; overloaded?: unknown };
    if (typeof cause.message === "string") messages.push(cause.message);
    overloaded ||= cause.overloaded === true;
    current = cause.cause;
  }
  const message = messages.join(" ");
  const d1Failure = /\bD1(?:_|\b)/i.test(message)
    && /overloaded|queued for too long|internal error|reset|temporarily unavailable/i.test(message);
  const durableObjectFailure = /durable object/i.test(message)
    && /no longer active|reset|code was updated|overloaded/i.test(message);
  if (!overloaded && !d1Failure && !durableObjectFailure) return undefined;
  return new ApiError(
    503,
    overloaded || /overloaded|queued for too long/i.test(message) ? "DEPENDENCY_OVERLOADED" : "DEPENDENCY_UNAVAILABLE",
    "A required service is temporarily unavailable. Please try again later."
  );
}
