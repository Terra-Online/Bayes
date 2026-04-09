import type { Role } from "../types/app";

const UID_START = 100000;
const NICKNAME_PATTERN = /^[A-Za-z0-9_-]{2,26}$/;
const DEFAULT_UID_SUFFIX = "AA";

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
  efPass: string | null;
  progressVersion: number;
  progressMarker: string;
  points: number;
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

function buildUidSuffixFromNickname(nickname: string): string {
  return normalizeUidSuffix(nickname);
}

function normalizeEditableNickname(raw: string): string {
  const value = raw.trim();
  if (!NICKNAME_PATTERN.test(value)) {
    throw new Error("INVALID_NICKNAME_FORMAT");
  }
  return value;
}

export function formatPublicUid(uidNumber: number, uidSuffix: string): string {
  const normalizedNumber = Number.isFinite(uidNumber) && uidNumber > 0 ? Math.floor(uidNumber) : 0;
  const normalizedSuffix = normalizeUidSuffix(uidSuffix);
  if (normalizedNumber <= 0) {
    return `000000${normalizedSuffix}`;
  }
  return `${normalizedNumber}${normalizedSuffix}`;
}

async function getNextUidNumber(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(uid_number), ?1) + 1 AS next_uid_number FROM users")
    .bind(UID_START)
    .first<Record<string, unknown>>();

  const nextValue = Number(row?.next_uid_number ?? UID_START + 1);
  if (Number.isFinite(nextValue) && nextValue > UID_START) {
    return Math.floor(nextValue);
  }
  return UID_START + 1;
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    uid: String(row.uid),
    uidNumber: Number(row.uid_number ?? 0),
    uidSuffix: normalizeUidSuffix(typeof row.uid_suffix === "string" ? row.uid_suffix : undefined),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role: (row.role as Role) ?? "normal",
    avt: Number(row.avt ?? 0),
    nickname: String(row.nickname),
    nicknameCustomized: Number(row.nickname_customized ?? 0) === 1,
    efPass: row.ef_pass === null ? null : String(row.ef_pass ?? ""),
    progressVersion: Number(row.progress_version ?? 0),
    progressMarker: String(row.progress_marker ?? ""),
    points: Number(row.points ?? 0),
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

function normalizeNickname(raw: string | undefined, uid: string): string[] {
  const source = (raw ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 26);
  const fallback = `U${uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;

  const candidates = [
    source,
    source ? `${source.slice(0, 20)}${uid.slice(0, 6)}` : "",
    fallback,
    `U${uid.slice(-12).replace(/[^A-Za-z0-9]/g, "")}`
  ].filter((item) => item.length > 0 && item.length <= 26);

  return Array.from(new Set(candidates));
}

export async function ensureUserProfile(db: D1Database, payload: EnsureUserProfilePayload): Promise<UserRecord> {
  const existing = await getUserByUid(db, payload.uid);
  if (existing) {
    await db
      .prepare("UPDATE users SET email = ?2, last_active = CURRENT_TIMESTAMP WHERE uid = ?1")
      .bind(payload.uid, payload.email.toLowerCase())
      .run();
    return {
      ...existing,
      email: payload.email.toLowerCase()
    };
  }

  const nicknameCandidates = normalizeNickname(payload.nickname ?? payload.displayName, payload.uid);
  const email = payload.email.toLowerCase();
  const avt = Number.isFinite(payload.avt) ? Number(payload.avt) : 0;
  const shouldMarkNicknameCustomized = Boolean(payload.nickname && payload.nickname.trim().length > 0);
  const initialUidSuffix = shouldMarkNicknameCustomized
    ? buildUidSuffixFromNickname(payload.nickname as string)
    : DEFAULT_UID_SUFFIX;

  for (let uidAttempt = 0; uidAttempt < 5; uidAttempt += 1) {
    const uidNumber = await getNextUidNumber(db);

    for (const nickname of nicknameCandidates) {
      try {
        await db
          .prepare(
            `INSERT INTO users (uid, uid_number, uid_suffix, email, password_hash, role, avt, nickname, nickname_customized, email_verified)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
          )
          .bind(
            payload.uid,
            uidNumber,
            initialUidSuffix,
            email,
            "better-auth-managed",
            "normal",
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
        const message = String(error);
        if (message.includes("users.nickname")) {
          continue;
        }
        if (message.includes("users.uid_number") || message.includes("idx_users_uid_number")) {
          break;
        }
        throw error;
      }
    }
  }

  throw new Error("Unable to create profile for authenticated user.");
}

export async function updateUserNickname(
  db: D1Database,
  payload: {
    uid: string;
    nickname: string;
  }
): Promise<UserRecord> {
  const current = await getUserByUid(db, payload.uid);
  if (!current) {
    throw new Error("USER_NOT_FOUND");
  }

  const normalizedNickname = normalizeEditableNickname(payload.nickname);
  const nextUidSuffix = current.nicknameCustomized
    ? current.uidSuffix
    : buildUidSuffixFromNickname(normalizedNickname);

  try {
    await db
      .prepare(
        `UPDATE users
         SET nickname = ?2,
             uid_suffix = ?3,
             nickname_customized = 1,
             last_active = CURRENT_TIMESTAMP
         WHERE uid = ?1`
      )
      .bind(payload.uid, normalizedNickname, nextUidSuffix)
      .run();
  } catch (error) {
    const message = String(error);
    if (message.includes("users.nickname")) {
      throw new Error("NICKNAME_CONFLICT");
    }
    throw error;
  }

  const updated = await getUserByUid(db, payload.uid);
  if (!updated) {
    throw new Error("USER_NOT_FOUND");
  }
  return updated;
}

export async function updateProgressInD1(
  db: D1Database,
  uid: string,
  version: number,
  marker: string,
  pointsDelta: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET progress_version = ?2,
           progress_marker = ?3,
           points = points + ?4,
           last_active = CURRENT_TIMESTAMP
       WHERE uid = ?1`
    )
    .bind(uid, version, marker, pointsDelta)
    .run();
}
