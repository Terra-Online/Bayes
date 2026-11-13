import type { DatabaseSync } from "node:sqlite";

export type UserFixture = {
  uid: string;
  email?: string;
  nickname?: string;
  role?: string;
  karma?: number;
  points?: number;
  avt?: number;
  uid_number?: number | null;
  uid_suffix?: string;
  nickname_confirmed?: number;
  created_at?: string;
  last_active?: string;
};

export interface SeededUser {
  uid: string;
  email: string;
  nickname: string;
  role: string;
  karma: number;
  points: number;
  avt: number;
  uid_number: number | null;
  uid_suffix: string;
  nickname_confirmed: number;
  created_at: string;
  last_active: string;
}

export function insertUser(sqlite: DatabaseSync, input: UserFixture): SeededUser {
  const user: SeededUser = {
    email: `${input.uid}@example.test`,
    nickname: input.uid,
    role: "n",
    karma: 0,
    points: 0,
    avt: 0,
    uid_number:
      Number(
        sqlite.prepare("INSERT INTO user_uid_sequence DEFAULT VALUES RETURNING id").get()!.id,
      ) + 100000,
    uid_suffix: "AA",
    nickname_confirmed: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    last_active: new Date().toISOString(),
    ...input,
  };
  sqlite
    .prepare(`INSERT INTO users
    (id, email, name, nickname, role, karma, points, avt, uid_number,
     uid_suffix, nickname_confirmed, created_at, last_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      user.uid,
      user.email,
      user.nickname,
      user.nickname,
      user.role,
      user.karma,
      user.points,
      user.avt,
      user.uid_number,
      user.uid_suffix,
      user.nickname_confirmed,
      user.created_at,
      user.last_active,
    );
  return user;
}

/** Change selected persisted facts after a real registration in a lifecycle test. */
export function updateUser(sqlite: DatabaseSync, input: UserFixture): void {
  const { uid, ...fields } = input;
  const entries = Object.entries(fields);
  sqlite
    .prepare(
      `UPDATE users SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
    )
    .run(...entries.map(([, value]) => value ?? null), uid);
}
