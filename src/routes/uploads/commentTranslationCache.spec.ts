import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommentTranslationItem } from "@/services/commentTranslation/commentTranslation";
import {
  createCommentTranslationFixture,
  createTranslationSigningKey,
  type CommentTranslationFixture,
  type TranslationProvider,
} from "@/test/fixtures/commentTranslation";
import { insertSubmission } from "@/test/fixtures/submissions";

let database: CommentTranslationFixture["database"];
let env: CommentTranslationFixture["env"];
let kv: CommentTranslationFixture["kv"];
let translationRequests: CommentTranslationFixture["translationRequests"];
let providerFetch: CommentTranslationFixture["providerFetch"];
let request: CommentTranslationFixture["request"];
let storedTranslations: CommentTranslationFixture["storedTranslations"];
let provider: TranslationProvider;
let privateKey: string;
let clock = Date.now();
const originalText = "入口在东边。";
const translatedText = "The entrance is on the east side.";

beforeAll(async () => {
  privateKey = await createTranslationSigningKey();
});

beforeEach(() => {
  // Expire the process-local OAuth token between cases without resetting internal modules.
  clock += 2 * 60 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
  ({
    database,
    env,
    kv,
    translationRequests,
    provider,
    providerFetch,
    request,
    storedTranslations,
  } = createCommentTranslationFixture({ privateKey, translatedText }));
  vi.stubGlobal("fetch", providerFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  database.close();
});

async function translations(body: object, user: string | null = "reader") {
  const response = await request(
    { commentIds: ["comment"], targetLanguage: "en-US", ...body },
    user,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: CommentTranslationItem[] }).items;
}

describe("comment translation cache", () => {
  it("keeps translations separate for different comment text and target languages", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    insertSubmission(database.sqlite, {
      id: "other-comment",
      userId: "author",
      content: "出口在西边。",
    });
    await translations({});
    expect(await translations({ commentIds: ["other-comment"], cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ commentId: "other-comment", error: "TRANSLATION_CACHE_MISS" }),
    ]);
    expect(await translations({ targetLanguage: "ja-JP", cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ targetLanguage: "ja-JP", error: "TRANSLATION_CACHE_MISS" }),
    ]);
    provider.translationResponse = () =>
      Response.json({
        translations: [
          { translatedText: "The exit is on the west side.", detectedLanguageCode: "zh-CN" },
        ],
      });
    expect(await translations({ commentIds: ["other-comment"] })).toEqual([
      expect.objectContaining({
        commentId: "other-comment",
        translatedContent: "The exit is on the west side.",
        cached: false,
      }),
    ]);
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: true }),
    ]);
    expect(translationRequests.map((payload) => payload.contents)).toEqual([
      [originalText],
      ["出口在西边。"],
    ]);
    expect(
      storedTranslations()
        .map((row) => row.translated_content)
        .sort(),
    ).toEqual([translatedText, "The exit is on the west side."].sort());
  });

  it("isolates explicit source languages in KV and SQLite when the provider omits language detection", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    provider.translationResponse = (payload) =>
      Response.json({
        translations: [
          {
            translatedText:
              payload.sourceLanguageCode === "ja" ? "Japanese interpretation" : translatedText,
          },
        ],
      });
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({
        translatedContent: translatedText,
        sourceLanguage: "zh-CN",
        cached: false,
      }),
    ]);
    expect(await translations({ sourceLanguage: "ja-JP", cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ error: "TRANSLATION_CACHE_MISS" }),
    ]);
    expect(await translations({ sourceLanguage: "ja-JP" })).toEqual([
      expect.objectContaining({
        translatedContent: "Japanese interpretation",
        sourceLanguage: "ja-JP",
        cached: false,
      }),
    ]);
    for (const evictKv of [false, true]) {
      if (evictKv) {
        kv.clear();
      }
      expect(await translations({ sourceLanguage: "zh-CN", cachedOnly: true }, null)).toEqual([
        expect.objectContaining({
          translatedContent: translatedText,
          sourceLanguage: "zh-CN",
          cached: true,
        }),
      ]);
      expect(await translations({ sourceLanguage: "ja-JP", cachedOnly: true }, null)).toEqual([
        expect.objectContaining({
          translatedContent: "Japanese interpretation",
          sourceLanguage: "ja",
          cached: true,
        }),
      ]);
    }
    expect(translationRequests.map((payload) => payload.sourceLanguageCode)).toEqual([
      "zh-CN",
      "ja",
    ]);
    expect(storedTranslations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_language: "zh-CN",
          detected_source_language: null,
          translated_content: translatedText,
        }),
        expect.objectContaining({
          source_language: "ja",
          detected_source_language: null,
          translated_content: "Japanese interpretation",
        }),
      ]),
    );
    expect(storedTranslations()).toHaveLength(2);
  });

  it.each([
    "invalid JSON",
    "incompatible translation",
    "invalid detection pointer",
    "KV unavailable",
  ])(
    "recovers from %s using persisted translations without contacting Google again",
    async (failure) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
      await translations({});
      const before = storedTranslations();
      const unavailableRead =
        failure === "KV unavailable"
          ? vi.spyOn(env.OEM_KV!, "get").mockRejectedValue(new Error("KV unavailable"))
          : undefined;
      if (!unavailableRead) {
        for (const [key, value] of kv) {
          const record = JSON.parse(value);
          if (failure === "invalid detection pointer" && record.cacheKey) {
            kv.set(key, JSON.stringify({ ...record, textHash: "outdated-text-hash" }));
          } else if (failure !== "invalid detection pointer" && record.translatedText) {
            kv.set(
              key,
              failure === "invalid JSON"
                ? "{broken"
                : JSON.stringify({
                    ...record,
                    flowVersion: "stale-flow",
                    translatedText: "Wrong translation",
                  }),
            );
          }
        }
      }
      expect(await translations({ cachedOnly: true }, null)).toEqual([
        expect.objectContaining({
          translatedContent: translatedText,
          sourceLanguage: "zh-CN",
          cached: true,
        }),
      ]);
      unavailableRead?.mockRestore();
      expect(await translations({ cachedOnly: true }, null)).toEqual([
        expect.objectContaining({ translatedContent: translatedText, cached: true }),
      ]);
      expect(translationRequests).toHaveLength(1);
      expect(storedTranslations()).toEqual(before);
      expect(database.sqlite.prepare("SELECT content, status FROM ugc_submissions").all()).toEqual([
        { content: originalText, status: "active" },
      ]);
    },
  );

  it("reuses one translation for equal visible text while keeping pending, withdrawn, missing and image items untranslated", async () => {
    for (const [id, status] of [
      ["comment", "active"],
      ["flagged", "flagged"],
      ["removal", "remove_request"],
      ["pending", "pending_openai"],
      ["audit", "pending_audit"],
      ["withdrawn", "stale"],
    ]) {
      insertSubmission(database.sqlite, { id, userId: "author", content: originalText, status });
    }
    insertSubmission(database.sqlite, {
      id: "image",
      userId: "author",
      kind: "image",
      content: originalText,
    });
    const commentIds = [
      "withdrawn",
      "flagged",
      "comment",
      "missing",
      "pending",
      "image",
      "removal",
      "audit",
      "comment",
    ];
    const items = await translations({ commentIds });
    expect(items.map((item) => item.commentId)).toEqual([
      "withdrawn",
      "flagged",
      "comment",
      "missing",
      "pending",
      "image",
      "removal",
      "audit",
    ]);
    expect(
      items
        .filter((item) => item.translatedContent)
        .map((item) => ({ id: item.commentId, text: item.translatedContent })),
    ).toEqual([
      { id: "flagged", text: translatedText },
      { id: "comment", text: translatedText },
      { id: "removal", text: translatedText },
    ]);
    expect(items.filter((item) => item.error)).toEqual(
      ["withdrawn", "missing", "pending", "image", "audit"].map((commentId) =>
        expect.objectContaining({ commentId, error: "COMMENT_NOT_TRANSLATABLE", cached: false }),
      ),
    );
    expect(translationRequests.map((payload) => payload.contents)).toEqual([[originalText]]);
    expect(storedTranslations()).toHaveLength(1);
    // A stored translation must not bypass the comment's current visibility.
    expect(
      await translations({ commentIds: ["withdrawn", "pending", "image"], cachedOnly: true }, null),
    ).toEqual(
      ["withdrawn", "pending", "image"].map((commentId) =>
        expect.objectContaining({ commentId, error: "COMMENT_NOT_TRANSLATABLE", cached: false }),
      ),
    );
    expect(translationRequests).toHaveLength(1);
  });

  it("reports an anonymous cache miss without contacting a translation provider or changing the comment", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({
        commentId: "comment",
        cached: false,
        error: "TRANSLATION_CACHE_MISS",
      }),
    ]);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(storedTranslations()).toEqual([]);
    expect(kv.size).toBe(0);
    expect(database.sqlite.prepare("SELECT content, status FROM ugc_submissions").all()).toEqual([
      { content: originalText, status: "active" },
    ]);
  });

  it("translates a visible comment for a signed-in reader and serves the saved result anonymously even after KV eviction", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    expect(await translations({})).toEqual([
      {
        commentId: "comment",
        sourceLanguage: "zh-CN",
        targetLanguage: "en-US",
        provider: "google_cloud_translation_v3",
        translatedContent: translatedText,
        glossaryApplied: false,
        cached: false,
      },
    ]);
    expect(translationRequests).toEqual([
      { contents: [originalText], targetLanguageCode: "en", mimeType: "text/plain" },
    ]);
    expect(storedTranslations()).toEqual([
      {
        source_language: "zh-CN",
        detected_source_language: "zh-CN",
        target_language: "en",
        translated_content: translatedText,
        glossary_applied: 0,
      },
    ]);
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({
        commentId: "comment",
        translatedContent: translatedText,
        cached: true,
      }),
    ]);
    kv.clear();
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({
        commentId: "comment",
        translatedContent: translatedText,
        cached: true,
      }),
    ]);
    expect(translationRequests).toHaveLength(1);
    expect(kv.size).toBeGreaterThan(0);
    expect(
      database.sqlite
        .prepare("SELECT content, status FROM ugc_submissions WHERE id = 'comment'")
        .get(),
    ).toEqual({ content: originalText, status: "active" });
  });
});

describe("translation access", () => {
  it.each([
    { user: null, status: 401, code: "SESSION_REQUIRED" },
    { user: "suspended", status: 403, code: "ACCESS_DENIED" },
  ])(
    "rejects live translation for $user while allowing them to read existing translations",
    async ({ user, status, code }) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
      await translations({});
      const before = storedTranslations();
      const response = await request({ commentIds: ["comment"], targetLanguage: "en-US" }, user);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(await translations({ cachedOnly: true }, user)).toEqual([
        expect.objectContaining({
          commentId: "comment",
          translatedContent: translatedText,
          cached: true,
        }),
      ]);
      expect(storedTranslations()).toEqual(before);
      expect(translationRequests).toHaveLength(1);
    },
  );
});

describe("translation glossary", () => {
  it("preserves earlier glossary translations across releases and applies the new release to new text", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    env.GOOGLE_TRANSLATE_GLOSSARY = "projects/test-project/locations/global/glossaries/endfield";
    env.GOOGLE_TRANSLATE_GLOSSARY_VERSION = "2026 release 1";
    let providerWording = "First glossary wording";
    provider.translationResponse = () =>
      Response.json({ glossaryTranslations: [{ translatedText: providerWording }] });
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({
        translatedContent: providerWording,
        glossaryApplied: true,
        cached: false,
      }),
    ]);
    env.GOOGLE_TRANSLATE_GLOSSARY_VERSION = "g2026-release-2";
    providerWording = "Revised glossary wording";
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({
        translatedContent: "First glossary wording",
        glossaryApplied: true,
        cached: true,
      }),
    ]);
    insertSubmission(database.sqlite, {
      id: "new-comment",
      userId: "author",
      content: "新入口在北边。",
    });
    expect(await translations({ commentIds: ["new-comment"], sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({
        translatedContent: providerWording,
        glossaryApplied: true,
        cached: false,
      }),
    ]);
    kv.clear();
    expect(await translations({ sourceLanguage: "zh-CN", cachedOnly: true }, null)).toEqual([
      expect.objectContaining({
        translatedContent: "First glossary wording",
        glossaryApplied: true,
        cached: true,
      }),
    ]);
    expect(
      await translations(
        { commentIds: ["new-comment"], sourceLanguage: "zh-CN", cachedOnly: true },
        null,
      ),
    ).toEqual([
      expect.objectContaining({
        translatedContent: providerWording,
        glossaryApplied: true,
        cached: true,
      }),
    ]);
    expect(
      storedTranslations()
        .map((row) => row.translated_content)
        .sort(),
    ).toEqual(["First glossary wording", "Revised glossary wording"]);
    expect(translationRequests).toHaveLength(2);
  });
  it.each([undefined, "zh-CN"])(
    "falls back to a usable base translation when the glossary is unavailable (source: %s)",
    async (sourceLanguage) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
      env.GOOGLE_TRANSLATE_GLOSSARY = "projects/test-project/locations/global/glossaries/endfield";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      provider.translationResponse = (payload) =>
        payload.glossaryConfig
          ? new Response("Glossary temporarily unavailable", { status: 503 })
          : Response.json({ translations: [{ translatedText, detectedLanguageCode: "zh-CN" }] });
      expect(await translations({ sourceLanguage })).toEqual([
        expect.objectContaining({
          translatedContent: translatedText,
          glossaryApplied: false,
          cached: false,
        }),
      ]);
      expect(storedTranslations()).toEqual([
        expect.objectContaining({ translated_content: translatedText, glossary_applied: 0 }),
      ]);
      expect(translationRequests).toHaveLength(2);
      kv.clear();
      expect(await translations({ sourceLanguage, cachedOnly: true }, null)).toEqual([
        expect.objectContaining({
          translatedContent: translatedText,
          glossaryApplied: false,
          cached: true,
        }),
      ]);
      expect(translationRequests).toHaveLength(2);
    },
  );

  it("keeps base translations when detection cannot select a glossary source language", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    insertSubmission(database.sqlite, {
      id: "polish",
      userId: "author",
      content: "Wejście na wschodzie.",
    });
    env.GOOGLE_TRANSLATE_GLOSSARY = "projects/test-project/locations/global/glossaries/endfield";
    env.GOOGLE_TRANSLATE_GLOSSARY_LANGUAGES = "zh-CN,en";
    provider.translationResponse = () =>
      Response.json({
        translations: [
          { translatedText },
          { translatedText: "Enter from the east.", detectedLanguageCode: "pl" },
        ],
      });
    expect(await translations({ commentIds: ["comment", "polish"] })).toEqual([
      expect.objectContaining({
        translatedContent: translatedText,
        sourceLanguage: "auto",
        glossaryApplied: false,
        cached: false,
      }),
      expect.objectContaining({
        translatedContent: "Enter from the east.",
        sourceLanguage: "pl",
        glossaryApplied: false,
        cached: false,
      }),
    ]);
    kv.clear();
    expect(
      await translations({ commentIds: ["comment", "polish"], cachedOnly: true }, null),
    ).toEqual([
      expect.objectContaining({
        translatedContent: translatedText,
        sourceLanguage: "auto",
        cached: true,
      }),
      expect.objectContaining({
        translatedContent: "Enter from the east.",
        sourceLanguage: "pl",
        cached: true,
      }),
    ]);
    expect(translationRequests).toHaveLength(1);
    expect(translationRequests[0]).not.toHaveProperty("glossaryConfig");
    expect(storedTranslations()).toHaveLength(2);
  });

  it("uses the detected source language to save the glossary translation for later anonymous readers", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: "源石在入口。" });
    const glossary = "projects/test-project/locations/global/glossaries/endfield";
    env.GOOGLE_TRANSLATE_GLOSSARY = glossary;
    provider.translationResponse = (payload) =>
      payload.glossaryConfig
        ? Response.json({
            glossaryTranslations: [{ translatedText: "Originium is at the entrance." }],
          })
        : Response.json({
            translations: [
              { translatedText: "Source stone is at the entrance.", detectedLanguageCode: "zh-CN" },
            ],
          });
    expect(await translations({})).toEqual([
      expect.objectContaining({
        translatedContent: "Originium is at the entrance.",
        sourceLanguage: "zh-CN",
        glossaryApplied: true,
        cached: false,
      }),
    ]);
    expect(translationRequests).toEqual([
      { contents: ["源石在入口。"], targetLanguageCode: "en", mimeType: "text/plain" },
      {
        contents: ["源石在入口。"],
        sourceLanguageCode: "zh-CN",
        targetLanguageCode: "en",
        mimeType: "text/plain",
        glossaryConfig: { glossary },
      },
    ]);
    expect(storedTranslations()).toEqual([
      expect.objectContaining({
        translated_content: "Originium is at the entrance.",
        glossary_applied: 1,
      }),
    ]);
    kv.clear();
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({
        translatedContent: "Originium is at the entrance.",
        glossaryApplied: true,
        cached: true,
      }),
    ]);
    expect(translationRequests).toHaveLength(2);
  });
});

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async zremrangebyscore() {}
    async zcard() {
      return 0;
    }
    async zadd() {}
    async expire() {}
  },
}));
