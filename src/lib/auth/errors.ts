export function toSerializableError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const withCause = error as Error & { cause?: unknown; code?: unknown; status?: unknown; statusText?: unknown };
  return {
    name: error.name,
    message: error.message,
    code: withCause.code,
    status: withCause.status,
    statusText: withCause.statusText,
    cause: withCause.cause ? toSerializableError(withCause.cause) : undefined,
    stack: error.stack,
  };
}
