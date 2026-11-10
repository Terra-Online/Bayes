import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommentTranslationItem } from "@/services/ugc/translation/comments";
import {
  createCommentTranslationFixture,
  insertTranslationSubmission,
  createTranslationSigningKey,
  type CommentTranslationFixture,
  type TranslationProvider,
} from "@/test/fixtures/commentTranslation";

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
    insertTranslationSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: originalText,
    });
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
    provider.tokenResponse = response;
    expect(await translations({ sourceLanguage: "zh-CN" })).toEqual([
      expect.objectContaining({ error, cached: false }),
    ]);
    expect(translationRequests).toEqual([]);
    expect(storedTranslations()).toEqual([]);
    expect(kv.size).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);

    // A missing expires_in is accepted by the provider contract; retry obtains a usable token.
    provider.tokenResponse = () => Response.json({ access_token: "recovered-token" });
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
      insertTranslationSubmission(database.sqlite, {
        id: "comment",
        userId: "author",
        content: originalText,
      });
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
    insertTranslationSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: originalText,
    });
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

  // HTTP isolates the host restriction: a remote address must not receive Google credentials.
  it.each(["http://remote.example.test/proxy", "not a URL"])(
    "keeps Google credentials on the direct provider connection when proxy configuration %s is disallowed",
    async (proxy) => {
      insertTranslationSubmission(database.sqlite, {
        id: "comment",
        userId: "author",
        content: originalText,
      });
      env.GOOGLE_TRANSLATE_FETCH_PROXY_URL = proxy;
      expect(await translations({})).toEqual([
        expect.objectContaining({ translatedContent: translatedText, cached: false }),
      ]);
      expect(providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
        "https://oauth2.googleapis.com/token",
        "https://translation.googleapis.com/v3/projects/test-project/locations/global:translateText",
      ]);
    },
  );

  it("reports a provider timeout without caching failure and succeeds when the reader retries", async () => {
    insertTranslationSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: originalText,
    });
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
    insertTranslationSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: translatedText,
    });
    provider.translationResponse = () =>
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
    insertTranslationSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: originalText,
    });
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

  it("translates groups in request order using the first requested original text", async () => {
    const firstRequestedText = "\n入口在东边。\n";
    const exitText = "出口在西边。";
    const entranceTranslation = "The entrance is on the east side.";
    const exitTranslation = "The exit is on the west side.";
    for (const [id, content] of [
      ["a", "入口在东边。"],
      ["z", firstRequestedText],
      ["middle", exitText],
    ]) {
      insertTranslationSubmission(database.sqlite, { id, userId: "author", content });
    }
    provider.translationResponse = () =>
      Response.json({
        translations: [
          { translatedText: entranceTranslation, detectedLanguageCode: "zh-CN" },
          { translatedText: exitTranslation, detectedLanguageCode: "zh-CN" },
        ],
      });

    const items = await translations({ commentIds: ["z", "middle", "a"] });

    expect(translationRequests.map(({ contents }) => contents)).toEqual([
      [firstRequestedText, exitText],
    ]);
    expect(
      items.map(({ commentId, translatedContent }) => ({ commentId, translatedContent })),
    ).toEqual([
      { commentId: "z", translatedContent: entranceTranslation },
      { commentId: "middle", translatedContent: exitTranslation },
      { commentId: "a", translatedContent: entranceTranslation },
    ]);
    expect(storedTranslations()).toHaveLength(2);
  });

  it("saves successful batch items while reporting an empty translation for another comment", async () => {
    insertTranslationSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: originalText,
    });
    insertTranslationSubmission(database.sqlite, {
      id: "empty-result",
      userId: "author",
      content: "出口在西边。",
    });
    provider.translationResponse = () =>
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
      insertTranslationSubmission(database.sqlite, {
        id: "comment",
        userId: "author",
        content: originalText,
      });
      await translations({});
      insertTranslationSubmission(database.sqlite, {
        id: "uncached",
        userId: "author",
        content: "出口在西边。",
      });
      provider.translationResponse = () => {
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
      provider.translationResponse = () =>
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
