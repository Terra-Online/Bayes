import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv, Role } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let sessions: Map<string, ReturnType<typeof insertSession>>;

function member(uid: string, role: Role = "n", createdAt = "2026-09-01T10:00:00.000Z") {
  insertUser(database.sqlite, { uid, role, created_at: createdAt });
  insertAuthUser(database.sqlite, { id: uid });
  sessions.set(uid, insertSession(database.sqlite, { userId: uid }));
}

beforeEach(() => {
  database = createTestDatabase();
  sessions = new Map();
  member("admin", "a");
});

afterEach(() => database.close());

function request(report: string, uid = "admin") {
  const app = new Hono<AppEnv>();
  app.onError(onAppError);
  app.route("/admin/v1/reports", createRoutes());
  return app.request(
    `http://localhost/admin/v1/reports/${report}`,
    { headers: sessions.get(uid)?.headers },
    {
      DB: database.db,
      ...testAuthConfig,
    } as AppEnv["Bindings"],
  );
}

describe("administrator reports HTTP", () => {
  it("returns zero translation totals and empty breakdowns before any translations exist", async () => {
    const response = await request("translations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(String),
      totalTranslations: 0,
      sourceTexts: 0,
      glossaryTranslations: 0,
      firstTranslationDate: null,
      lastTranslationDate: null,
      daily: [],
      sources: [],
      targets: [],
      flows: [],
    });
  });

  it("returns zero reaction totals and no featured image before any reactions exist", async () => {
    const response = await request("ugc-likes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(String),
      totalLikes: 0,
      imageLikes: 0,
      commentLikes: 0,
      commentDislikes: 0,
      uniqueReactors: 0,
      likedSubmissions: 0,
      firstReactionDate: null,
      lastReactionDate: null,
      topImage: null,
      daily: [],
      contributorLikes: [],
    });
  });

  it("allows administrators and root users to read reports while denying every other role and anonymous callers", async () => {
    for (const role of ["n", "p", "s", "r"] as const) {
      member(`role-${role}`, role);
    }
    for (const report of ["registrations", "translations", "ugc-likes"]) {
      const anonymous = await request(report, "");
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "SESSION_REQUIRED" });
      for (const role of ["n", "p", "s"]) {
        const response = await request(report, `role-${role}`);
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED" });
      }
      expect((await request(report)).status).toBe(200);
      expect((await request(report, "role-r")).status).toBe(200);
    }
  });

  it("counts registered people once and attributes linked logins to the earliest account", async () => {
    member("github-user", "n", "2026-09-02T10:00:00.000Z");
    member("email-user", "n", "2026-09-02T11:00:00.000Z");
    insertUser(database.sqlite, { uid: "legacy-user", created_at: "2026-09-03T10:00:00.000Z" });
    insertAuthUser(database.sqlite, { id: "auth-only" });
    for (const [id, uid, provider, at] of [
      ["github-first", "github-user", "github", "2026-09-02T10:00:00.000Z"],
      ["discord-later", "github-user", "discord", "2026-09-05T10:00:00.000Z"],
      ["a-email", "email-user", "credential", "2026-09-02T11:00:00.000Z"],
      ["z-google", "email-user", "google", "2026-09-02T11:00:00.000Z"],
      ["orphan-account", "auth-only", "discord", "2026-09-06T10:00:00.000Z"],
    ]) {
      database.sqlite
        .prepare(`INSERT INTO auth_accounts (id, accountId, providerId, userId, createdAt)
        VALUES (?, ?, ?, ?, ?)`)
        .run(id, id, provider, uid, at);
    }
    const response = await request("registrations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(String),
      totalUsers: 4,
      firstRegistrationDate: "2026-09-01",
      lastRegistrationDate: "2026-09-03",
      daily: [
        { date: "2026-09-01", count: 1 },
        { date: "2026-09-02", count: 2 },
        { date: "2026-09-03", count: 1 },
      ],
      sources: [
        { source: "unknown", count: 2 },
        { source: "credential", count: 1 },
        { source: "github", count: 1 },
      ],
    });
  });

  it("reports translation volume, distinct source texts, glossary use, and detected language flows", async () => {
    for (const [id, textHash, source, detected, target, glossary, at] of [
      ["en-zh", "same-text", "auto", "en", "zh-CN", 1, "2026-09-01T10:00:00.000Z"],
      ["en-ja", "same-text", "auto", "en", "ja", 0, "2026-09-01T11:00:00.000Z"],
      ["ja-en", "second-text", "auto", " ja ", "en", 0, "2026-09-02T10:00:00.000Z"],
      ["fr-en", "third-text", "fr", null, "en", 1, "2026-09-03T10:00:00.000Z"],
    ]) {
      database.sqlite
        .prepare(`INSERT INTO ugc_text_translations
        (cache_key, text_hash, flow_version, source_language, detected_source_language,
         target_language, provider, translated_content, glossary_applied, translated_at)
        VALUES (?, ?, 'v1', ?, ?, ?, 'google', 'Translated comment', ?, ?)`)
        .run(id, textHash, source, detected, target, glossary, at);
    }
    const response = await request("translations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(String),
      totalTranslations: 4,
      sourceTexts: 3,
      glossaryTranslations: 2,
      firstTranslationDate: "2026-09-01",
      lastTranslationDate: "2026-09-03",
      daily: [
        { date: "2026-09-01", count: 2 },
        { date: "2026-09-02", count: 1 },
        { date: "2026-09-03", count: 1 },
      ],
      sources: [
        { language: "en", count: 2 },
        { language: "fr", count: 1 },
        { language: "ja", count: 1 },
      ],
      targets: [
        { language: "en", count: 2 },
        { language: "ja", count: 1 },
        { language: "zh-CN", count: 1 },
      ],
      flows: [
        { sourceLanguage: "en", targetLanguage: "ja", count: 1 },
        { sourceLanguage: "en", targetLanguage: "zh-CN", count: 1 },
        { sourceLanguage: "fr", targetLanguage: "en", count: 1 },
        { sourceLanguage: "ja", targetLanguage: "en", count: 1 },
      ],
    });
  });

  it("counts active reactions and contributor likes while featuring only an eligible public image", async () => {
    for (const uid of ["artist", "writer", "reader-one", "reader-two", "reader-three"]) {
      insertUser(database.sqlite, { uid });
    }
    for (const [id, createdAt, status] of [
      ["older-image", "2026-08-01T10:00:00.000Z", "active"],
      ["newer-image", "2026-08-02T10:00:00.000Z", "active"],
      ["archived-image", "2026-08-03T10:00:00.000Z", "stale"],
    ]) {
      insertSubmission(database.sqlite, {
        id,
        userId: "artist",
        kind: "image",
        markerId: `marker-${id}`,
        createdAt,
        status,
      });
    }
    insertSubmission(database.sqlite, { id: "comment", userId: "writer" });
    insertSubmission(database.sqlite, { id: "disliked-comment", userId: "writer" });
    for (const [submission, reader, active, at] of [
      ["older-image", "reader-one", 1, "2026-09-01"],
      ["older-image", "reader-two", 1, "2026-09-01"],
      ["newer-image", "reader-one", 1, "2026-09-02"],
      ["newer-image", "reader-two", 1, "2026-09-02"],
      ["archived-image", "reader-one", 1, "2026-09-03"],
      ["archived-image", "reader-two", 1, "2026-09-03"],
      ["archived-image", "reader-three", 1, "2026-09-03"],
      ["older-image", "reader-three", 0, "2026-09-05"],
    ]) {
      database.sqlite
        .prepare(`INSERT INTO ugc_submission_upvotes (submission_id, user_id, active, created_at)
        VALUES (?, ?, ?, ?)`)
        .run(submission, reader, active, at);
    }
    for (const [submission, reader, value, active, at] of [
      ["comment", "reader-one", 1, 1, "2026-09-01"],
      ["comment", "reader-two", 1, 1, "2026-09-02"],
      ["comment", "reader-three", -1, 1, "2026-09-03"],
      ["disliked-comment", "reader-one", -1, 1, "2026-09-02"],
      ["disliked-comment", "reader-two", 1, 0, "2026-09-06"],
    ]) {
      database.sqlite
        .prepare(`INSERT INTO ugc_submission_votes (submission_id, user_id, value, active, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(submission, reader, value, active, at);
    }
    const response = await request("ugc-likes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(String),
      totalLikes: 9,
      imageLikes: 7,
      commentLikes: 2,
      commentDislikes: 2,
      uniqueReactors: 3,
      likedSubmissions: 4,
      firstReactionDate: "2026-09-01",
      lastReactionDate: "2026-09-03",
      topImage: expect.objectContaining({
        id: "newer-image",
        markerId: "marker-newer-image",
        poiType: "poi",
        filePath: "images/newer-image.webp",
        likeCount: 2,
        createdAt: "2026-08-02T10:00:00.000Z",
      }),
      daily: [
        { date: "2026-09-01", imageLikes: 2, commentLikes: 1, commentDislikes: 0 },
        { date: "2026-09-02", imageLikes: 2, commentLikes: 1, commentDislikes: 1 },
        { date: "2026-09-03", imageLikes: 3, commentLikes: 0, commentDislikes: 1 },
      ],
      contributorLikes: [
        { userId: "artist", likeCount: 7 },
        { userId: "writer", likeCount: 2 },
      ],
    });
  });
});
