import type { Role } from "../types/app";
import { pointsToKarma } from "../lib/karma/rules";

const UID_START = 100000;
const NICKNAME_PATTERN = /^[A-Za-z0-9_-]{2,26}$/;
const DEFAULT_UID_SUFFIX = "AA";
const UID_SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const USER_ACTIVITY_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export interface UserRecord {
  uid: string;
  uidNumber: number;
  uidSuffix: string;
  email: string;
  passwordHash: string;
  role: Role;
  avt: number;
  nickname: string;
  nicknameCustomized: boolean;
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

export interface EnsureUserProfilePayload {
  uid: string;
  email: string;
  displayName?: string;
  nickname?: string;
  avt?: number;
}

function normalizeUidSuffix(raw: string | undefined): string {
  const value = (raw ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();

  if (value.length >= 2) {
    return value.slice(-2);
  }
  if (value.length === 1) {
    return `${value}X`;
  }
  return DEFAULT_UID_SUFFIX;
}

function randomUpperLetters(count: number): string {
  if (count <= 0) {
    return "";
  }

  const bytes = crypto.getRandomValues(new Uint8Array(count));
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const mapped = bytes[index]! % UID_SUFFIX_ALPHABET.length;
    output += UID_SUFFIX_ALPHABET[mapped]!;
  }
  return output;
}

function buildUidSuffixFromNickname(nickname: string): string {
  const letters = nickname
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();

  if (letters.length >= 2) {
    return letters.slice(-2);
  }

  if (letters.length === 1) {
    return `${letters}${randomUpperLetters(1)}`;
  }

  return randomUpperLetters(2);
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

function normalizeEditableNickname(raw: string): string {
  const value = raw.trim();
  if (!NICKNAME_PATTERN.test(value)) {
    throw new Error("INVALID_NICKNAME_FORMAT");
  }
  return value;
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

async function allocateNextUidNumber(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare("INSERT INTO user_uid_sequence DEFAULT VALUES RETURNING id")
      .first<{ id: number | string }>();

    const sequenceValue = Number(row?.id ?? Number.NaN);
    if (Number.isFinite(sequenceValue) && sequenceValue > 0) {
      return UID_START + Math.floor(sequenceValue);
    }
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("user_uid_sequence") || message.includes("RETURNING")) {
      throw new Error("UID_SEQUENCE_NOT_READY_MIGRATION_REQUIRED");
    }
    throw error;
  }

  throw new Error("UID_SEQUENCE_NOT_READY_MIGRATION_REQUIRED");
}

function mapUser(row: Record<string, unknown>): UserRecord {
  const role = normalizeRole(row.role);
  const points = Number(row.points ?? 0);
  const karmaFromDb = Number(row.karma);
  const karma = Number.isFinite(karmaFromDb) ? karmaFromDb : pointsToKarma(points);

  return {
    uid: String(row.uid),
    uidNumber: Number(row.uid_number ?? 0),
    uidSuffix: normalizeUidSuffix(typeof row.uid_suffix === "string" ? row.uid_suffix : undefined),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role,
    avt: Number(row.avt ?? 0),
    nickname: String(row.nickname),
    nicknameCustomized: Number(row.nickname_customized ?? 0) === 1,
    progressVersion: Number(row.progress_version ?? 0),
    progressMarker: String(row.progress_marker ?? ""),
    progressChecksum: String(row.progress_checksum ?? ""),
    progressMarkerIndexHash: String(row.progress_marker_index_hash ?? ""),
    progressFormatVersion: Number(row.progress_format_version ?? 1),
    progressBitsPerPoint: Number(row.progress_bits_per_point ?? 1),
    progressPointCount: Number(row.progress_point_count ?? 0),
    progressRetainedPointIds: parseStringArrayJson(row.progress_retained_point_ids),
    progressUpdatedAt: row.progress_updated_at === null || row.progress_updated_at === undefined
      ? null
      : Number(row.progress_updated_at),
    progressLastMutationId: row.progress_last_mutation_id === null ? null : String(row.progress_last_mutation_id ?? ""),
    progressCloudSynced: Number(row.progress_cloud_synced ?? 0) === 1,
    progressSyncedAt: row.progress_synced_at === null || row.progress_synced_at === undefined
      ? null
      : Number(row.progress_synced_at),
    points,
    karma,
    createdAt: String(row.created_at),
    lastActive: String(row.last_active)
  };
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRecord | null> {
  const row = await db.prepare("SELECT * FROM users WHERE email = ?1 LIMIT 1").bind(email).first<Record<string, unknown>>();
  return row ? mapUser(row) : null;
}

export async function getUserByUid(db: D1Database, uid: string): Promise<UserRecord | null> {
  const row = await db.prepare("SELECT * FROM users WHERE uid = ?1 LIMIT 1").bind(uid).first<Record<string, unknown>>();
  return row ? mapUser(row) : null;
}

function normalizeNickname(raw: string | undefined, uid: string, email?: string): string[] {
  const source = (raw ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 26);
  const emailLocalPart = (email?.split("@")[0] ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 26);
  const compactUid = uid.replace(/[^A-Za-z0-9]/g, "");
  const fallback = `U${compactUid.slice(0, 7)}`;

  const candidates = [
    source,
    source ? `${source.slice(0, 20)}${compactUid.slice(0, 6)}` : "",
    emailLocalPart,
    emailLocalPart ? `${emailLocalPart.slice(0, 20)}${compactUid.slice(0, 6)}` : "",
    fallback,
    `U${compactUid.slice(-7)}`
  ].filter((item) => item.length > 0 && item.length <= 26);

  return Array.from(new Set(candidates));
}

export async function ensureUserProfile(db: D1Database, payload: EnsureUserProfilePayload): Promise<UserRecord> {
  const existing = await getUserByUid(db, payload.uid);
  if (existing) {
    return refreshUserActivity(db, existing, payload.email.toLowerCase());
  }

  const existingByEmail = await getUserByEmail(db, payload.email.toLowerCase());
  if (existingByEmail) {
    return refreshUserActivity(db, existingByEmail, existingByEmail.email);
  }

  const email = payload.email.toLowerCase();
  const nicknameCandidates = normalizeNickname(payload.nickname ?? payload.displayName, payload.uid, email);
  const avt = Number.isFinite(payload.avt) ? Number(payload.avt) : 0;
  const shouldMarkNicknameCustomized = Boolean(payload.nickname && payload.nickname.trim().length > 0);
  const fallbackNickname = nicknameCandidates[0] ?? payload.uid;
  const initialUidSuffix = shouldMarkNicknameCustomized
    ? buildUidSuffixFromNickname(payload.nickname as string)
    : buildUidSuffixFromNickname(fallbackNickname);

  for (let uidAttempt = 0; uidAttempt < 5; uidAttempt += 1) {
    const uidNumber = await allocateNextUidNumber(db);

    for (const nickname of nicknameCandidates) {
      const nextUidSuffix = shouldMarkNicknameCustomized
        ? initialUidSuffix
        : buildUidSuffixFromNickname(nickname);

      try {
        await db
          .prepare(
            `INSERT INTO users (uid, uid_number, uid_suffix, email, password_hash, role, avt, nickname, nickname_customized, email_verified)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
          )
          .bind(
            payload.uid,
            uidNumber,
            nextUidSuffix,
            email,
            "better-auth-managed",
            "n",
            avt,
            nickname,
            shouldMarkNicknameCustomized ? 1 : 0,
            "false"
          )
          .run();

        const created = await getUserByUid(db, payload.uid);
        if (created) {
          return created;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes("users.nickname")) {
          continue;
        }
        if (message.includes("users.uid") || message.includes("users.email")) {
          // Concurrent requests can race on first profile bootstrap. If another
          // request already inserted the same user, return that row instead of 500.
          const createdByUid = await getUserByUid(db, payload.uid);
          if (createdByUid) {
            return createdByUid;
          }

          const createdByEmail = await getUserByEmail(db, email);
          if (createdByEmail && createdByEmail.uid === payload.uid) {
            return createdByEmail;
          }

          if (createdByEmail && createdByEmail.uid !== payload.uid) {
            throw new Error("EMAIL_ALREADY_BOUND_TO_ANOTHER_USER");
          }

          continue;
        }
        if (message.includes("users.uid_number") || message.includes("idx_users_uid_number")) {
          break;
        }
        if (message.includes("UID_SEQUENCE_NOT_READY_MIGRATION_REQUIRED")) {
          throw new Error(message);
        }
        throw new Error(message);
      }
    }
  }

  const created = await getUserByUid(db, payload.uid);
  if (created) {
    return created;
  }

  throw new Error("Unable to create profile for authenticated user.");
}

async function refreshUserActivity(db: D1Database, user: UserRecord, email: string): Promise<UserRecord> {
  const lastActive = Date.parse(user.lastActive.includes("T")
    ? user.lastActive
    : `${user.lastActive.replace(" ", "T")}Z`);
  if (user.email === email && Number.isFinite(lastActive) && Date.now() - lastActive < USER_ACTIVITY_UPDATE_INTERVAL_MS) {
    return user;
  }

  const row = await db.prepare(
    `UPDATE users
     SET email = ?2, last_active = CURRENT_TIMESTAMP
     WHERE uid = ?1
       AND (email <> ?2 OR datetime(last_active) IS NULL OR datetime(last_active) <= datetime('now', '-1 hour'))
     RETURNING *`
  ).bind(user.uid, email).first<Record<string, unknown>>();
  return row ? mapUser(row) : user;
}

export async function updateUserNickname(
  db: D1Database,
  payload: {
    uid: string;
    nickname: string;
    avatar?: number;
  }
): Promise<UserRecord> {
  const current = await getUserByUid(db, payload.uid);
  if (!current) {
    throw new Error("USER_NOT_FOUND");
  }

  const normalizedNickname = normalizeEditableNickname(payload.nickname);
  const normalizedAvatar = payload.avatar === undefined
    ? undefined
    : Number.isFinite(payload.avatar)
      ? Math.floor(payload.avatar)
      : NaN;

  if (normalizedAvatar !== undefined && (!Number.isFinite(normalizedAvatar) || normalizedAvatar < 1 || normalizedAvatar > 99)) {
    throw new Error("INVALID_AVATAR");
  }

  const nextUidSuffix = current.nicknameCustomized
    ? current.uidSuffix
    : buildUidSuffixFromNickname(normalizedNickname);

  try {
    await db
      .prepare(
        `UPDATE users
         SET nickname = ?2,
             uid_suffix = ?3,
           avt = COALESCE(?4, avt),
             nickname_customized = 1,
             last_active = CURRENT_TIMESTAMP
         WHERE uid = ?1`
      )
        .bind(payload.uid, normalizedNickname, nextUidSuffix, normalizedAvatar ?? null)
      .run();
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("users.nickname")) {
      throw new Error("NICKNAME_CONFLICT");
    }
    throw new Error(message);
  }

  const updated = await getUserByUid(db, payload.uid);
  if (!updated) {
    throw new Error("USER_NOT_FOUND");
  }
  return updated;
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
  pointsDelta: number
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
       WHERE uid = ?1`
    )
    .bind(uid, delta)
    .run();
}
