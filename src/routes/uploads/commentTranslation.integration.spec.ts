import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import type { CommentTranslationItem } from "@/services/upload/commentTranslation";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let env: AppEnv["Bindings"];
let sessions: Record<string, { authorization: string }>;
let kv: Map<string, string>;
let privateKey: string;
type TranslationRequest = {
  contents: string[];
  sourceLanguageCode?: string;
  targetLanguageCode: string;
  glossaryConfig?: { glossary: string };
};
let translationRequests: TranslationRequest[];
let translate: (payload: TranslationRequest) => Response | Promise<Response>;
let tokenResponse: () => Response;
let providerFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let clock = Date.now();
const originalText = "入口在东边。";
const translatedText = "The entrance is on the east side.";

beforeAll(async () => {
  // A disposable signing key exercises real JWT preparation without any credentials.
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const encoded = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
    "base64",
  );
  privateKey = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
});

beforeEach(() => {
  // Expire the process-local OAuth token between cases without resetting internal modules.
  clock += 2 * 60 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
  database = createTestDatabase();
  sessions = {};
  for (const [uid, role] of [
    ["author", "n"],
    ["reader", "n"],
    ["suspended", "s"],
  ]) {
    insertUser(database.sqlite, { uid, role });
    insertAuthUser(database.sqlite, { id: uid });
    sessions[uid] = insertSession(database.sqlite, { userId: uid }).headers;
  }
  kv = new Map();
  translationRequests = [];
  translate = () =>
    Response.json({ translations: [{ translatedText, detectedLanguageCode: "zh-CN" }] });
  tokenResponse = () => Response.json({ access_token: "synthetic-google-token", expires_in: 3600 });
  providerFetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return tokenResponse();
    }
    if (
      url ===
      "https://translation.googleapis.com/v3/projects/test-project/locations/global:translateText"
    ) {
      const payload = JSON.parse(String(init?.body)) as TranslationRequest;
      translationRequests.push(payload);
      return translate(payload);
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
  vi.stubGlobal("fetch", providerFetch);
  const mocks = createMockBindings({ DB: database.db });
  mocks.publicRateLimit.limit.mockResolvedValue({ success: true });
  mocks.authRateLimit.limit.mockResolvedValue({ success: true });
  env = {
    ...mocks.bindings,
    LOCK_UPLOAD_ENDPOINTS: "false",
    OEM_KV: {
      // This suite uses KV's text-only overload. Other KV operations fail explicitly.
      get: vi.fn<(key: string) => Promise<string | null>>(async (key) => kv.get(key) ?? null),
      put: vi.fn<KVNamespace["put"]>().mockImplementation(async (key, value) => {
        if (typeof value !== "string") {
          throw new Error("Expected JSON text in translation KV");
        }
        kv.set(key, value);
      }),
      delete: vi.fn<KVNamespace["delete"]>().mockImplementation(async (key) => {
        kv.delete(key);
      }),
      getWithMetadata: vi
        .fn<KVNamespace["getWithMetadata"]>()
        .mockRejectedValue(new Error("Unconfigured KV metadata read")),
      list: vi.fn<KVNamespace["list"]>().mockRejectedValue(new Error("Unconfigured KV list")),
    } as unknown as KVNamespace,
    GOOGLE_TRANSLATE_PROJECT_ID: "test-project",
    GOOGLE_TRANSLATE_CLIENT_EMAIL: "translation@example.test",
    GOOGLE_TRANSLATE_PRIVATE_KEY: privateKey,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  database.close();
});

async function request(body: unknown, user: string | null = "reader") {
  const app = createRoutes();
  app.onError(onAppError);
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    "http://localhost/comments/translations",
    {
      method: "POST",
      headers: { ...((user && sessions[user]) || {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    { waitUntil: (work: Promise<unknown>) => pending.push(work) } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  return response;
}

async function translations(body: object, user: string | null = "reader") {
  const response = await request(
    { commentIds: ["comment"], targetLanguage: "en-US", ...body },
    user,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: CommentTranslationItem[] }).items;
}

function storedTranslations() {
  return database.sqlite
    .prepare(
      "SELECT source_language, detected_source_language, target_language, translated_content, glossary_applied FROM ugc_text_translations ORDER BY cache_key",
    )
    .all();
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
    translate = () =>
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
    translate = (payload) =>
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
    expect(translationRequests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
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
    { sourceLanguage: undefined, targetLanguage: "xx-YY" },
    { sourceLanguage: "xx-YY", targetLanguage: "en-US" },
  ])("does not send unsupported language requests to Google: %s", async (languages) => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    expect(await translations(languages)).toEqual([
      expect.objectContaining({
        commentId: "comment",
        error: "LANGUAGE_NOT_ALLOWED",
        cached: false,
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(storedTranslations()).toEqual([]);
  });

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

  it("rejects invalid request bodies before requesting live access or contacting Google", async () => {
    const response = await request({ commentIds: [], targetLanguage: "en-US" }, null);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetch).not.toHaveBeenCalled();
    expect(storedTranslations()).toEqual([]);
  });
});

describe("translation glossary", () => {
  it("preserves earlier glossary translations across releases and applies the new release to new text", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    env.GOOGLE_TRANSLATE_GLOSSARY = "projects/test-project/locations/global/glossaries/endfield";
    env.GOOGLE_TRANSLATE_GLOSSARY_VERSION = "2026 release 1";
    let result = "First glossary wording";
    translate = () => Response.json({ glossaryTranslations: [{ translatedText: result }] });
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({ translatedContent: result, glossaryApplied: true, cached: false }),
    ]);
    env.GOOGLE_TRANSLATE_GLOSSARY_VERSION = "g2026-release-2";
    result = "Revised glossary wording";
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
      expect.objectContaining({ translatedContent: result, glossaryApplied: true, cached: false }),
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
      expect.objectContaining({ translatedContent: result, glossaryApplied: true, cached: true }),
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
      translate = (payload) =>
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
    translate = () =>
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
    translate = (payload) =>
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

describe("translation failure outcomes", () => {
  it.each([
    {
      name: "rejected OAuth credentials",
      response: () => new Response(null, { status: 401 }),
      error: "Google token request failed (401).",
    },
    {
      name: "a token response without an access token",
      response: () => Response.json({ expires_in: 3600 }),
      error: "Google token response did not include access_token.",
    },
  ])("keeps the comment retryable after $name", async ({ response, error }) => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
    tokenResponse = response;
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({ error, cached: false }),
    ]);
    expect(translationRequests).toEqual([]);
    expect(storedTranslations()).toEqual([]);
    expect(kv.size).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);

    // A missing expires_in is accepted by the provider contract; retry obtains a usable token.
    tokenResponse = () => Response.json({ access_token: "recovered-token" });
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: false }),
    ]);
    expect(await translations({ sourceLanguage: "zh-CN", cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: true }),
    ]);
    expect(translationRequests).toHaveLength(1);
    expect(storedTranslations()).toHaveLength(1);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);
  });

  it.each([
    {
      binding: "GOOGLE_TRANSLATE_PRIVATE_KEY" as const,
      error: "Google Translation service account is not configured.",
    },
    {
      binding: "GOOGLE_TRANSLATE_PROJECT_ID" as const,
      error: "Google Translation project id is not configured.",
    },
  ])(
    "reports missing $binding without caching a result or changing the comment",
    async ({ binding, error }) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
      const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
      env[binding] = undefined;
      expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
        expect.objectContaining({ error, cached: false }),
      ]);
      expect(providerFetch).not.toHaveBeenCalled();
      expect(storedTranslations()).toEqual([]);
      expect(kv.size).toBe(0);
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);
    },
  );

  it("translates through the configured local Google proxy and reuses the persisted result", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    env.GOOGLE_TRANSLATE_FETCH_PROXY_URL = "http://127.0.0.1:9090/google";
    const forwarded: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    providerFetch.mockImplementation(async (url, init) => {
      if (String(url) !== env.GOOGLE_TRANSLATE_FETCH_PROXY_URL) {
        throw new Error(`Unexpected direct request: ${url}`);
      }
      const payload = JSON.parse(String(init?.body));
      forwarded.push(payload);
      return Response.json({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          forwarded.length === 1
            ? { access_token: "proxy-token", expires_in: 3600 }
            : { translations: [{ translatedText, detectedLanguageCode: "zh-CN" }] },
        ),
      });
    });
    expect(await translations({})).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: false }),
    ]);
    expect(forwarded.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "https://oauth2.googleapis.com/token", method: "POST" },
      {
        url: "https://translation.googleapis.com/v3/projects/test-project/locations/global:translateText",
        method: "POST",
      },
    ]);
    expect(new URLSearchParams(forwarded[0]!.body).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(forwarded[1]!.headers.authorization).toBe("Bearer proxy-token");
    expect(JSON.parse(forwarded[1]!.body)).toMatchObject({
      contents: [originalText],
      targetLanguageCode: "en",
    });
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: true }),
    ]);
    expect(storedTranslations()).toHaveLength(1);
    expect(forwarded).toHaveLength(2);
  });

  it.each(["https://remote.example.test/proxy", "https://localhost:9090/proxy", "not a URL"])(
    "keeps Google credentials on the direct provider connection when proxy configuration %s is disallowed",
    async (proxy) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
      env.GOOGLE_TRANSLATE_FETCH_PROXY_URL = proxy;
      expect(await translations({})).toEqual([
        expect.objectContaining({ translatedContent: translatedText, cached: false }),
      ]);
      expect(providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
        "https://oauth2.googleapis.com/token",
        "https://translation.googleapis.com/v3/projects/test-project/locations/global:translateText",
      ]);
      expect(storedTranslations()).toHaveLength(1);
      expect(await translations({ cachedOnly: true }, null)).toEqual([
        expect.objectContaining({ translatedContent: translatedText, cached: true }),
      ]);
      expect(providerFetch).toHaveBeenCalledTimes(2);
    },
  );

  it("reports a provider timeout without caching failure and succeeds when the reader retries", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const externalFetch = providerFetch.getMockImplementation()!;
    let started!: () => void;
    const translationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    providerFetch.mockImplementation((url, init) => {
      if (String(url).includes("translation.googleapis.com")) {
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          started();
        });
      }
      return externalFetch(url, init);
    });
    const response = translations({ sourceLanguage: "zh-CN" });
    await translationStarted;
    await vi.advanceTimersToNextTimerAsync();
    expect(await response).toEqual([
      expect.objectContaining({
        error: "Google Translation google-translate request timed out.",
        cached: false,
      }),
    ]);
    expect(storedTranslations()).toEqual([]);
    expect(kv.size).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);

    providerFetch.mockImplementation(externalFetch);
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: false }),
    ]);
    expect(await translations({ sourceLanguage: "zh-CN", cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: true }),
    ]);
    expect(storedTranslations()).toHaveLength(1);
  });

  it("does not cache a detected source language that is already the requested target language", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: translatedText });
    translate = () =>
      Response.json({ translations: [{ translatedText, detectedLanguageCode: "en" }] });
    expect(await translations({})).toEqual([
      expect.objectContaining({
        commentId: "comment",
        sourceLanguage: "en",
        error: "Target language cannot be equal to source language.",
        cached: false,
      }),
    ]);
    expect(storedTranslations()).toEqual([]);
    expect(kv.size).toBe(0);
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ error: "TRANSLATION_CACHE_MISS" }),
    ]);
  });

  it("keeps a completed translation available when KV writes fail", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    env.OEM_KV!.put = async () => {
      throw new Error("KV unavailable");
    };
    expect(await translations({})).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: false }),
    ]);
    expect(kv.size).toBe(0);
    expect(storedTranslations()).toHaveLength(1);
    expect(await translations({ cachedOnly: true }, null)).toEqual([
      expect.objectContaining({ translatedContent: translatedText, cached: true }),
    ]);
    expect(translationRequests).toHaveLength(1);
  });

  it("saves successful batch items while reporting an empty translation for another comment", async () => {
    insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
    insertSubmission(database.sqlite, {
      id: "empty-result",
      userId: "author",
      content: "出口在西边。",
    });
    translate = () =>
      Response.json({
        translations: [
          { translatedText, detectedLanguageCode: "zh-CN" },
          { translatedText: "", detectedLanguageCode: "zh-CN" },
        ],
      });
    expect(await translations({ commentIds: ["comment", "empty-result"] })).toEqual([
      expect.objectContaining({
        commentId: "comment",
        translatedContent: translatedText,
        cached: false,
      }),
      expect.objectContaining({
        commentId: "empty-result",
        error: "TRANSLATION_EMPTY",
        cached: false,
      }),
    ]);
    expect(storedTranslations()).toHaveLength(1);
    expect(
      await translations({ commentIds: ["comment", "empty-result"], cachedOnly: true }, null),
    ).toEqual([
      expect.objectContaining({
        commentId: "comment",
        translatedContent: translatedText,
        cached: true,
      }),
      expect.objectContaining({
        commentId: "empty-result",
        error: "TRANSLATION_CACHE_MISS",
        cached: false,
      }),
    ]);
  });

  it.each(["http", "network"])(
    "preserves cached translations during a provider %s failure and leaves misses retryable",
    async (failure) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author", content: originalText });
      await translations({});
      insertSubmission(database.sqlite, {
        id: "uncached",
        userId: "author",
        content: "出口在西边。",
      });
      translate = () => {
        if (failure === "network") {
          throw new Error("Translation network unavailable");
        }
        return new Response("Provider unavailable", { status: 503 });
      };
      const items = await translations({ commentIds: ["comment", "uncached"] });
      expect(items[0]).toMatchObject({
        commentId: "comment",
        translatedContent: translatedText,
        cached: true,
      });
      expect(items[1]).toMatchObject({
        commentId: "uncached",
        cached: false,
        error:
          failure === "network"
            ? "Translation network unavailable"
            : "Google Translation request failed (503). Provider unavailable",
      });
      expect(items[1]).not.toHaveProperty("translatedContent");
      expect(storedTranslations()).toHaveLength(1);
      expect(await translations({ commentIds: ["uncached"], cachedOnly: true }, null)).toEqual([
        expect.objectContaining({ error: "TRANSLATION_CACHE_MISS" }),
      ]);
      translate = () =>
        Response.json({
          translations: [
            { translatedText: "The exit is on the west side.", detectedLanguageCode: "zh-CN" },
          ],
        });
      expect(await translations({ commentIds: ["uncached"] })).toEqual([
        expect.objectContaining({
          translatedContent: "The exit is on the west side.",
          cached: false,
        }),
      ]);
      expect(await translations({ commentIds: ["uncached"], cachedOnly: true }, null)).toEqual([
        expect.objectContaining({
          translatedContent: "The exit is on the west side.",
          cached: true,
        }),
      ]);
      expect(storedTranslations()).toHaveLength(2);
    },
  );
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
