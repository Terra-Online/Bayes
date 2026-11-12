import { pointsToKarma } from "@/lib/karma/rules";
import type { Role } from "@/types/app";

const UID_START = 100000;
const DEFAULT_UID_SUFFIX = "AA";
const USER_ACTIVITY_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export interface UserRecord {
  uid: string;
  uidNumber: number;
  uidSuffix: string;
  email: string;
  role: Role;
  avt: number;
  nickname: string;
  nicknameConfirmed: boolean;
  progressVersion: number;
  progressMarker: string;
  progressChecksum: string;
  progressMarkerIndexHash: string;
  progressFormatVersion: number;
  progressBitsPerPoint: number;
  progressPointCount: number;
  progressRetainedPointIds: string[];
  progressUpdatedAt: number | null;
  progressLastMutationId: string | null;
  progressCloudSynced: boolean;
  progressSyncedAt: number | null;
  points: number;
  karma: number;
  createdAt: string;
  lastActive: string;
}

export interface CreateUserInput {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  profileCandidates: readonly { nickname: string; uidSuffix: string }[];
}

function normalizeUidSuffix(raw: string | undefined): string {
  const value = (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  if (value.length >= 2) {
    return value.slice(-2);
  }
  if (value.length === 1) {
    return `${value}X`;
  }
  return DEFAULT_UID_SUFFIX;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

function normalizeRole(raw: unknown): Role {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  switch (value) {
    case "n":
    case "normal":
      return "n";
    case "p":
    case "pioneer":
    case "moderator":
      return "p";
    case "a":
    case "admin":
      return "a";
    case "s":
    case "suspend":
    case "suspended":
      return "s";
    case "r":
    case "robot":
      return "r";
    default:
      return "n";
  }
}

function parseStringArrayJson(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

export function formatPublicUid(uidNumber: number, uidSuffix: string): string {
  const normalizedNumber = Number.isFinite(uidNumber) && uidNumber > 0 ? Math.floor(uidNumber) : 0;
  const normalizedSuffix = normalizeUidSuffix(uidSuffix);
  if (normalizedNumber <= 0) {
    return `000000${normalizedSuffix}`;
  }
  return `${normalizedNumber}${normalizedSuffix}`;
}

function mapUser(row: Record<string, unknown>): UserRecord {
  const role = normalizeRole(row.role);
  const points = Number(row.points ?? 0);
  const karmaFromDb = Number(row.karma);
  const karma = Number.isFinite(karmaFromDb) ? karmaFromDb : pointsToKarma(points);

  return {
    uid: String(row.id),
    uidNumber: Number(row.uid_number ?? 0),
    uidSuffix: normalizeUidSuffix(typeof row.uid_suffix === "string" ? row.uid_suffix : undefined),
    email: String(row.email),
    role,
    avt: Number(row.avt ?? 0),
    nickname: String(row.nickname),
    nicknameConfirmed: Number(row.nickname_confirmed ?? 0) === 1,
    progressVersion: Number(row.progress_version ?? 0),
    progressMarker: String(row.progress_marker ?? ""),
    progressChecksum: String(row.progress_checksum ?? ""),
    progressMarkerIndexHash: String(row.progress_marker_index_hash ?? ""),
    progressFormatVersion: Number(row.progress_format_version ?? 1),
    progressBitsPerPoint: Number(row.progress_bits_per_point ?? 1),
    progressPointCount: Number(row.progress_point_count ?? 0),
    progressRetainedPointIds: parseStringArrayJson(row.progress_retained_point_ids),
    progressUpdatedAt:
      row.progress_updated_at === null || row.progress_updated_at === undefined
        ? null
        : Number(row.progress_updated_at),
    progressLastMutationId:
      row.progress_last_mutation_id === null ? null : String(row.progress_last_mutation_id ?? ""),
    progressCloudSynced: Number(row.progress_cloud_synced ?? 0) === 1,
    progressSyncedAt:
      row.progress_synced_at === null || row.progress_synced_at === undefined
        ? null
        : Number(row.progress_synced_at),
    points,
    karma,
    createdAt: String(row.created_at),
    lastActive: String(row.last_active),
  };
}

export async function getUserByUid(db: D1Database, uid: string): Promise<UserRecord | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE id = ?1 LIMIT 1")
    .bind(uid)
    .first<Record<string, unknown>>();
  return row ? mapUser(row) : null;
}

export async function getUserByPublicUid(
  db: D1Database,
  publicUid: string,
): Promise<UserRecord | null> {
  const match = /^(\d+)([A-Za-z0-9]{2})$/.exec(publicUid.trim());
  if (!match) {
    return null;
  }

  const uidNumber = Number(match[1]);
  if (!Number.isSafeInteger(uidNumber) || uidNumber <= 0) {
    return null;
  }

  const row = await db
    .prepare("SELECT * FROM users WHERE uid_number = ?1 AND UPPER(uid_suffix) = ?2 LIMIT 1")
    .bind(uidNumber, match[2]!.toUpperCase())
    .first<Record<string, unknown>>();
  return row ? mapUser(row) : null;
}

/** The sequence allocation and complete user row commit or roll back together. */
export async function createUser(db: D1Database, input: CreateUserInput): Promise<void> {
  for (const profile of input.profileCandidates) {
    try {
      await db.batch([
        db.prepare("INSERT INTO user_uid_sequence DEFAULT VALUES"),
        db
          .prepare(`INSERT INTO users
          (id, email, name, email_verified, image, created_at, updated_at,
           uid_number, uid_suffix, nickname, nickname_confirmed)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
            ?8 + (SELECT MAX(id) FROM user_uid_sequence), ?9, ?10, 0)`)
          .bind(
            input.id,
            input.email,
            input.name,
            input.emailVerified ? 1 : 0,
            input.image,
            input.createdAt.toISOString(),
            input.updatedAt.toISOString(),
            UID_START,
            profile.uidSuffix,
            profile.nickname,
          ),
      ]);
      return;
    } catch (error) {
      // A nickname conflict rolls back the entire batch, including its allocation.
      // Try the next prepared candidate without consuming another public number.
      if (!getErrorMessage(error).includes("users.nickname")) {
        throw error;
      }
    }
  }
  throw new Error("Unable to allocate a unique default nickname.");
}

export async function readSessionUser(db: D1Database, id: string): Promise<UserRecord> {
  const user = await getUserByUid(db, id);
  if (!user) {
    throw new Error("Authenticated user is missing from users.");
  }
  return refreshUserActivity(db, user);
}

async function refreshUserActivity(db: D1Database, user: UserRecord): Promise<UserRecord> {
  const lastActive = Date.parse(
    user.lastActive.includes("T") ? user.lastActive : `${user.lastActive.replace(" ", "T")}Z`,
  );
  if (Number.isFinite(lastActive) && Date.now() - lastActive < USER_ACTIVITY_UPDATE_INTERVAL_MS) {
    return user;
  }
  const row = await db
    .prepare(`UPDATE users SET last_active = CURRENT_TIMESTAMP
    WHERE id = ?1 AND (datetime(last_active) IS NULL OR datetime(last_active) <= datetime('now', '-1 hour'))
    RETURNING *`)
    .bind(user.uid)
    .first<Record<string, unknown>>();
  return row ? mapUser(row) : user;
}

export async function saveUserProfile(
  db: D1Database,
  payload: { uid: string; nickname: string; avatar?: number; uidSuffix: string },
): Promise<UserRecord | null> {
  try {
    // Finalize against the stored confirmation state in the same write, so a
    // concurrent profile edit cannot overwrite the first confirmed suffix.
    const row = await db
      .prepare(`UPDATE users
      SET nickname = ?2, avt = COALESCE(?3, avt), nickname_confirmed = 1,
          uid_suffix = CASE WHEN nickname_confirmed = 0 THEN ?4 ELSE uid_suffix END,
          updated_at = CURRENT_TIMESTAMP, last_active = CURRENT_TIMESTAMP
      WHERE id = ?1 RETURNING *`)
      .bind(payload.uid, payload.nickname, payload.avatar ?? null, payload.uidSuffix)
      .first<Record<string, unknown>>();
    return row ? mapUser(row) : null;
  } catch (error) {
    if (getErrorMessage(error).includes("users.nickname")) {
      throw new Error("NICKNAME_CONFLICT");
    }
    throw error;
  }
}

export interface UserProgressWrite {
  version: number;
  marker: string;
  checksum: string;
  markerIndexHash: string;
  formatVersion: number;
  bitsPerPoint: number;
  pointCount: number;
  retainedPointIds: string[];
  updatedAt: number;
  clientMutationId: string | null;
  cloudSynced: boolean;
  syncedAt: number | null;
}

export async function applyUserPointsDelta(
  db: D1Database,
  uid: string,
  pointsDelta: number,
): Promise<void> {
  if (!Number.isFinite(pointsDelta)) {
    return;
  }

  const delta = Math.floor(pointsDelta);
  if (delta === 0) {
    return;
  }

  await db
    .prepare(
      `UPDATE users
       SET points = MAX(0, points + ?2)
       WHERE id = ?1`,
    )
    .bind(uid, delta)
    .run();
}
