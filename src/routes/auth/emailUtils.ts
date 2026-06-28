export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function deriveDisplayName(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  const normalized = local.replace(/[^A-Za-z0-9_-]/g, "");
  if (normalized.length >= 2) {
    return normalized.slice(0, 26);
  }
  return "Traveler";
}
