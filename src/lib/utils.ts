export function readEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const unquoted = trimmed.replace(/^(['"])(.*)\1$/, '$2').trim();
  const normalized = unquoted.length > 0 ? unquoted : trimmed;
  return normalized.length > 0 ? normalized : undefined;
}

export function envOrThrow(value: string | undefined, key: string): string {
  const normalized = readEnv(value);
  if (normalized) {
    return normalized;
  }
  throw new Error(`Missing required auth environment variable: ${key}`);
}