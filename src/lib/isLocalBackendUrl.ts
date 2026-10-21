export function isLocalBackendUrl(raw: string | undefined): boolean {
  if (!raw || raw.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(raw.trim());
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
