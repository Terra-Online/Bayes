import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { vi } from "vitest";

import { createApp } from "@/app";
import type { SnapshotReviewStatus } from "@/repositories/submission/snapshotReads";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import type { AppEnv } from "@/types/app";

import { insertAuthUser, insertSession } from "./auth";
import { insertUser } from "./users";

export type TranslationRequest = {
  contents: string[];
  sourceLanguageCode?: string;
  targetLanguageCode: string;
  glossaryConfig?: { glossary: string };
};

export interface TranslationProvider {
  translationResponse: (payload: TranslationRequest) => Response | Promise<Response>;
  tokenResponse: () => Response;
}

export interface CommentTranslationFixtureInput {
  privateKey: string;
  translatedText: string;
}

export interface CommentTranslationFixture {
  database: TestDatabase;
  env: AppEnv["Bindings"];
  kv: Map<string, string>;
  translationRequests: TranslationRequest[];
  provider: TranslationProvider;
  providerFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  request: (body: unknown, user?: string | null) => Promise<Response>;
  storedTranslations: () => Record<string, SQLOutputValue>[];
}

export async function createTranslationSigningKey(): Promise<string> {
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
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

export function createCommentTranslationFixture({
  privateKey,
  translatedText,
}: CommentTranslationFixtureInput): CommentTranslationFixture {
  const database = createTestDatabase();
  importCurrentSubmissions(database);
  const sessions: Record<string, { authorization: string }> = {};
  for (const [uid, role] of [
    ["author", "n"],
    ["reader", "n"],
    ["suspended", "s"],
  ]) {
    insertUser(database.sqlite, { uid, role });
    insertAuthUser(database.sqlite, { id: uid });
    sessions[uid] = insertSession(database.sqlite, { userId: uid }).headers;
  }
  const kv = new Map<string, string>();
  const translationRequests: TranslationRequest[] = [];
  const provider: TranslationProvider = {
    translationResponse: () =>
      Response.json({ translations: [{ translatedText, detectedLanguageCode: "zh-CN" }] }),
    tokenResponse: () =>
      Response.json({ access_token: "synthetic-google-token", expires_in: 3600 }),
  };
  const providerFetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return provider.tokenResponse();
    }
    if (
      url ===
      "https://translation.googleapis.com/v3/projects/test-project/locations/global:translateText"
    ) {
      const payload = JSON.parse(String(init?.body)) as TranslationRequest;
      translationRequests.push(payload);
      return provider.translationResponse(payload);
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
  const mocks = createMockBindings({ DB: database.db });
  mocks.publicRateLimit.limit.mockResolvedValue({ success: true });
  mocks.authRateLimit.limit.mockResolvedValue({ success: true });
  const env: AppEnv["Bindings"] = {
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

  async function request(body: unknown, user: string | null = "reader") {
    const app = createApp();
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      "http://localhost/uploads/v1/comments/translations",
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

  function storedTranslations() {
    return database.sqlite
      .prepare(
        "SELECT source_language, detected_source_language, target_language, translated_content, glossary_applied FROM ugc_text_translations ORDER BY cache_key",
      )
      .all();
  }
  return {
    database,
    env,
    kv,
    translationRequests,
    provider,
    providerFetch,
    request,
    storedTranslations,
  };
}

interface TranslationSubmissionFixture {
  id: string;
  userId: string;
  content: string;
  kind?: "comment" | "image";
  reviewStatus?: SnapshotReviewStatus;
}

export function insertTranslationSubmission(
  sqlite: DatabaseSync,
  input: TranslationSubmissionFixture,
): void {
  const kind = input.kind ?? "comment";
  sqlite
    .prepare(`INSERT INTO ugc_submissions
    (id,kind,poi_id,poi_hash,poi_type,user_id) VALUES (?,?,'marker-1','hash','poi',?)`)
    .run(input.id, kind, input.userId);
  sqlite
    .prepare(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,content,file_path,review_status,creator_user_id)
    VALUES (?,?,?,1,?,?,?,?)`)
    .run(
      `snapshot-${input.id}`,
      input.id,
      kind,
      input.content,
      kind === "image" ? "prod/image.webp" : null,
      input.reviewStatus ?? "approved",
      input.userId,
    );
}
