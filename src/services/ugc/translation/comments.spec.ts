import { createHash, generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings } from "@/types/app";

import { translateVisibleComments } from "./comments";

const glossaryKey = "projects/test/locations/us-central1/glossaries/comments";
const provider = "google_cloud_translation_v3";
const currentVersion = "g2026-10-19";
const content = "测试 评论";
const textHash = createHash("sha256").update(content).digest("hex");
let database: TestDatabase;
let env: Bindings;
let kv: Map<string, string>;
let providerFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(() => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "author" });
  insertSubmission(database.sqlite, {
    id: "comment",
    userId: "author",
    content: "  测试\n 评论  ",
  });

  kv = new Map();
  env = {
    ...createMockBindings({ DB: database.db }).bindings,
    OEM_KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
    } as unknown as KVNamespace,
    GOOGLE_TRANSLATE_GLOSSARY: glossaryKey,
    GOOGLE_TRANSLATE_GLOSSARY_VERSION: currentVersion,
    GOOGLE_TRANSLATE_GLOSSARY_LANGUAGES: "zh-CN,en,ja",
    GOOGLE_TRANSLATE_ALLOWED_LANGUAGES: "zh-CN,en,ja",
  };
  providerFetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error("Unexpected translation request"));
  vi.stubGlobal("fetch", providerFetch);
});

afterEach(() => {
  database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type CachedTranslationInput = {
  version?: string;
  source?: string;
  glossary?: string;
  provider?: string;
  translated?: string;
  date?: string;
};

function insertCachedTranslation(options: CachedTranslationInput = {}): string {
  const version = options.version ?? "g2026-07-19";
  const source = options.source ?? "zh-CN";
  // Persist the established key format explicitly so fixtures can represent old revisions.
  const flow = `translate:v1:${version}:google-v3:${source}:en`;
  const key = `${flow}:${textHash}`;
  database.sqlite
    .prepare(`INSERT INTO ugc_text_translations (
    cache_key, text_hash, flow_version, source_language, detected_source_language,
    target_language, provider, glossary_version, glossary_key, translated_content,
    glossary_applied, translated_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'en', ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      key,
      textHash,
      flow,
      source,
      source,
      options.provider ?? provider,
      version,
      options.glossary ?? glossaryKey,
      options.translated ?? "Historical translation",
      options.glossary === "" ? 0 : 1,
      options.date ?? "2026-07-19 12:00:00",
      options.date ?? "2026-07-19 12:00:00",
    );
  return key;
}

function translate(
  sourceLanguage?: string,
  cachedOnly = false,
): ReturnType<typeof translateVisibleComments> {
  return translateVisibleComments(env, {
    commentIds: ["comment"],
    targetLanguage: "en-US",
    sourceLanguage,
    cachedOnly,
  });
}

describe("translation reuse across glossary revisions", () => {
  it.each([
    [undefined, false],
    [undefined, true],
    ["zh-CN", false],
    ["zh-CN", true],
  ])(
    "reuses an old revision for source %s and cachedOnly=%s without translating or rewriting it",
    async (source, cachedOnly) => {
      const key = insertCachedTranslation();
      const before = database.sqlite.prepare("SELECT * FROM ugc_text_translations").all();
      expect((await translate(source, cachedOnly)).items[0]).toMatchObject({
        translatedContent: "Historical translation",
        cached: true,
        sourceLanguage: "zh-CN",
        targetLanguage: "en-US",
        glossaryApplied: true,
      });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(database.queries.every((query) => query.changes === 0)).toBe(true);
      expect(database.sqlite.prepare("SELECT * FROM ugc_text_translations").all()).toEqual(before);
      expect(JSON.parse(kv.get(key)!)).toMatchObject({
        glossaryVersion: "g2026-07-19",
        translatedAt: "2026-07-19 12:00:00",
      });
    },
  );

  it.each([undefined, "zh-CN"])(
    "prefers the configured revision for source %s even when a different revision is newer",
    async (source) => {
      insertCachedTranslation({ version: currentVersion, translated: "Current translation" });
      insertCachedTranslation({ date: "2026-10-22 00:00:00" });
      expect((await translate(source)).items[0]?.translatedContent).toBe("Current translation");
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it("uses the most recent historical revision when the configured revision is absent", async () => {
    insertCachedTranslation({
      version: "g2026-07-01",
      translated: "Older",
      date: "2026-07-01 00:00:00",
    });
    insertCachedTranslation();
    expect((await translate()).items[0]?.translatedContent).toBe("Historical translation");
  });

  it("repairs the auto-detection pointer so later requests reuse KV without rereading stored translations", async () => {
    const key = insertCachedTranslation();
    await translate();
    const pointer = [...kv.values()]
      .map((value) => JSON.parse(value))
      .find((value) => value.cacheKey);
    expect(pointer).toMatchObject({
      cacheKey: key,
      glossaryVersion: currentVersion,
      translationGlossaryVersion: "g2026-07-19",
    });
    database.queries.length = 0;
    expect((await translate()).items[0]?.cached).toBe(true);
    expect(database.queries).toHaveLength(1); // The visible comment is still read from D1.
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("prefers current KV data when a historical pointer was repaired during a mixed rollout", async () => {
    insertCachedTranslation();
    await translate();
    insertCachedTranslation({ version: currentVersion, translated: "Current translation" });
    await translate("zh-CN"); // Repair the current translation KV entry without replacing the pointer.
    database.queries.length = 0;
    expect((await translate()).items[0]?.translatedContent).toBe("Current translation");
    expect(database.queries).toHaveLength(1); // The visible comment is still read from D1.
  });

  it("continues reading detection pointers written before historical-version support", async () => {
    insertCachedTranslation({ version: currentVersion });
    await translate();
    for (const [key, value] of kv) {
      const record = JSON.parse(value);
      if (record.cacheKey) {
        delete record.translationGlossaryVersion;
        kv.set(key, JSON.stringify(record));
      }
    }
    database.queries.length = 0;
    expect((await translate()).items[0]?.cached).toBe(true);
    expect(database.queries).toHaveLength(1); // The visible comment is still read from D1.
  });

  it.each(
    ["g2026-07-19", currentVersion].flatMap((version) => [
      { version, source: "ja" },
      { version, glossary: "projects/test/locations/us-central1/glossaries/other" },
      { version, provider: "other-provider" },
    ]),
  )(
    "does not reuse a translation from an incompatible source, provider or glossary: %j",
    async (options) => {
      insertCachedTranslation(options);
      expect((await translate("zh-CN", true)).items[0]).toMatchObject({
        cached: false,
        error: "TRANSLATION_CACHE_MISS",
      });
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "zh-CN"])(
    "ignores empty current translations for source %s",
    async (source) => {
      insertCachedTranslation({ version: currentVersion, translated: " " });
      insertCachedTranslation();
      expect((await translate(source)).items[0]?.translatedContent).toBe("Historical translation");
    },
  );

  it("does not present a cached same-language detection as a translation", async () => {
    insertCachedTranslation({ version: currentVersion });
    await translate("zh-CN", true);
    const before = database.sqlite.prepare("SELECT * FROM ugc_text_translations").all();
    // A stale/corrupt KV record is reachable even though migration 0028 rejects
    // same-language SQL rows. Do not bypass that migration to construct this case.
    for (const [key, value] of kv) {
      const record = JSON.parse(value);
      if (record.translatedText) {
        kv.set(key, JSON.stringify({ ...record, detectedSourceLanguage: "en" }));
      }
    }
    const result = await translate("zh-CN", true);
    expect(result.items).toEqual([
      expect.objectContaining({
        sourceLanguage: "en",
        cached: true,
        error: "Target language cannot be equal to source language.",
      }),
    ]);
    expect(result.items[0]).not.toHaveProperty("translatedContent");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(database.sqlite.prepare("SELECT * FROM ugc_text_translations").all()).toEqual(before);
  });

  it("preserves the no-glossary fallback", async () => {
    insertCachedTranslation({ version: "g0", glossary: "" });
    expect((await translate()).items[0]).toMatchObject({
      cached: true,
      glossaryApplied: false,
      translatedContent: "Historical translation",
    });
  });

  it("returns the stored translation even when KV repair fails", async () => {
    insertCachedTranslation();
    vi.mocked(env.OEM_KV!.put).mockRejectedValue(new Error("KV unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await translate()).items[0]?.cached).toBe(true);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("translates changed text and stores it under the configured version", async () => {
    insertCachedTranslation();
    database.sqlite.exec(`INSERT INTO ugc_snapshots
      (id,submission_id,kind,revision,content,review_status,creator_user_id)
      VALUES ('new-body','comment','comment',2,'不同的评论','approved','author');
      UPDATE ugc_submissions SET revision=2 WHERE id='comment';`);
    env.GOOGLE_TRANSLATE_PROJECT_ID = "test";
    env.GOOGLE_TRANSLATE_CLIENT_EMAIL = "translate@example.test";
    env.GOOGLE_TRANSLATE_PRIVATE_KEY = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    providerFetch.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("oauth2.googleapis.com")
              ? { access_token: "test-token", expires_in: 3600 }
              : { glossaryTranslations: [{ translatedText: "New translation" }] },
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    expect((await translate("zh-CN")).items[0]).toMatchObject({
      cached: false,
      translatedContent: "New translation",
    });
    // A changed text needs one OAuth exchange and one paid translation request.
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(
      database.sqlite
        .prepare(
          "SELECT glossary_version FROM ugc_text_translations WHERE translated_content = 'New translation'",
        )
        .get(),
    ).toMatchObject({ glossary_version: currentVersion });
  });
});
