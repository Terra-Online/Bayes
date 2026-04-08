import type { Role } from "../types/app";

export interface UserRecord {
  uid: string;
  email: string;
  passwordHash: string;
  role: Role;
  avt: number;
  nickname: string;
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

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    uid: String(row.uid),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role: (row.role as Role) ?? "normal",
    avt: Number(row.avt ?? 0),
    nickname: String(row.nickname),
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

  for (const nickname of nicknameCandidates) {
    try {
      await db
        .prepare(
          `INSERT INTO users (uid, email, password_hash, role, avt, nickname, email_verified)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(payload.uid, email, "better-auth-managed", "normal", avt, nickname, "false")
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
      throw error;
    }
  }

  throw new Error("Unable to create profile for authenticated user.");
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
