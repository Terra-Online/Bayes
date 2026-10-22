import type { DatabaseSync } from "node:sqlite";

type UserFixture = {
  uid: string;
  email?: string;
  nickname?: string;
  role?: string;
  karma?: number;
  points?: number;
  avt?: number;
  uid_number?: number | null;
  uid_suffix?: string;
  nickname_customized?: number;
  created_at?: string;
  last_active?: string;
};

export function insertUser(sqlite: DatabaseSync, input: UserFixture) {
  const user = {
    email: `${input.uid}@example.test`,
    nickname: input.uid,
    role: "n",
    karma: 0,
    points: 0,
    avt: 0,
    uid_number: null,
    uid_suffix: "AA",
    nickname_customized: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    last_active: new Date().toISOString(),
    ...input,
  };
  sqlite
    .prepare(`INSERT INTO users
    (uid, email, password_hash, nickname, role, karma, points, avt, uid_number,
     uid_suffix, nickname_customized, created_at, last_active)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      user.uid,
      user.email,
      user.nickname,
      user.role,
      user.karma,
      user.points,
      user.avt,
      user.uid_number,
      user.uid_suffix,
      user.nickname_customized,
      user.created_at,
      user.last_active,
    );
  return user;
}
