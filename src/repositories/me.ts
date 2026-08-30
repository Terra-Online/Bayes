import type { SubmissionKind, SubmissionStatus } from "./submission/types";

export type LoginMethod = {
  provider: string;
  linkedAt: string;
  verified?: boolean;
  unlinkable: boolean;
};

export type ContributionItem = {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiType: string;
  content: string | null;
  status: SubmissionStatus;
  visibility: "public" | "private" | "unavailable";
  createdAt: string;
};

type ContributionRow = {
  id: string;
  kind: SubmissionKind;
  poi_id: string;
  poi_type: string;
  content: string | null;
  status: SubmissionStatus;
  created_at: string;
};

type ContributionCursor = { createdAt: string; id: string };

function visibilityFor(status: SubmissionStatus): ContributionItem["visibility"] {
  if (status === "active" || status === "flagged" || status === "remove_request") return "public";
  if (status === "stale") return "unavailable";
  return "private";
}

function mapContribution(row: ContributionRow): ContributionItem {
  return {
    id: row.id,
    kind: row.kind,
    markerId: row.poi_id,
    poiType: row.poi_type,
    content: row.content,
    status: row.status,
    visibility: visibilityFor(row.status),
    createdAt: row.created_at,
  };
}

export function encodeContributionCursor(cursor: ContributionCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeContributionCursor(raw: string): ContributionCursor | null {
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ContributionCursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    if (!parsed.createdAt || !parsed.id) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function listLoginMethods(db: D1Database, uid: string): Promise<LoginMethod[]> {
  const result = await db.prepare(
    `SELECT providerId, createdAt
     FROM auth_accounts
     WHERE userId = ?1
     ORDER BY createdAt ASC, providerId ASC`,
  ).bind(uid).all<{ providerId: string; createdAt: string }>();
  const rows = result.results ?? [];
  return rows.map((row) => ({
    provider: row.providerId === "credential" ? "email" : row.providerId,
    linkedAt: row.createdAt,
    verified: row.providerId === "credential" ? true : undefined,
    unlinkable: rows.length > 1,
  }));
}

export async function getContributionCounts(db: D1Database, uid: string) {
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END) AS image_count,
       SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END) AS comment_count,
       SUM(CASE WHEN status IN ('pending_openai', 'pending_audit') THEN 1 ELSE 0 END) AS pending_count
     FROM ugc_submissions
     WHERE user_id = ?1`,
  ).bind(uid).first<{ image_count: number | string; comment_count: number | string; pending_count: number | string }>();
  return {
    imageCount: Number(row?.image_count ?? 0),
    commentCount: Number(row?.comment_count ?? 0),
    pendingCount: Number(row?.pending_count ?? 0),
  };
}

export async function listContributions(db: D1Database, payload: {
  uid: string;
  kind?: SubmissionKind;
  status?: SubmissionStatus;
  cursor?: ContributionCursor;
  limit: number;
}): Promise<{ items: ContributionItem[]; nextCursor: string | null }> {
  const filters = ["user_id = ?1"];
  const bindings: Array<string | number> = [payload.uid];
  if (payload.kind) {
    bindings.push(payload.kind);
    filters.push(`kind = ?${bindings.length}`);
  }
  if (payload.status) {
    bindings.push(payload.status);
    filters.push(`status = ?${bindings.length}`);
  }
  if (payload.cursor) {
    bindings.push(payload.cursor.createdAt, payload.cursor.id);
    filters.push(`(created_at < ?${bindings.length - 1} OR (created_at = ?${bindings.length - 1} AND id < ?${bindings.length}))`);
  }
  bindings.push(payload.limit + 1);

  const result = await db.prepare(
    `SELECT id, kind, poi_id, poi_type, SUBSTR(content, 1, 240) AS content, status, created_at
     FROM ugc_submissions
     WHERE ${filters.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ?${bindings.length}`,
  ).bind(...bindings).all<ContributionRow>();

  const rows = result.results ?? [];
  const hasMore = rows.length > payload.limit;
  const visibleRows = rows.slice(0, payload.limit);
  const last = visibleRows.at(-1);
  return {
    items: visibleRows.map(mapContribution),
    nextCursor: hasMore && last
      ? encodeContributionCursor({ createdAt: last.created_at, id: last.id })
      : null,
  };
}
