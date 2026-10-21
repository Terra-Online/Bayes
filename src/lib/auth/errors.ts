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
