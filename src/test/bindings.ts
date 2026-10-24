import { vi, type Mocked, type MockInstance } from "vitest";

import type { AutoModerationMsg, TranslationMsg, WebhookMsg } from "@/queues/types/messages";
import type { oem_imgTrans } from "@/services/upload/imageTranscoderContainer";
import type { Bindings } from "@/types/app";

import { testAuthConfig } from "./fixtures/auth";

export type MockImageTranscoder = Mocked<DurableObjectStub<oem_imgTrans>>;

export interface MockBindings {
  bindings: Bindings;
  ugcBucket: Mocked<R2Bucket>;
  autoModerationQueue: Mocked<Bindings["OEM_MODERATION_Q"]>;
  translationQueue: Mocked<Bindings["OEM_TRANSLATION_Q"]>;
  webhookQueue: Mocked<Bindings["OEM_WEBHOOK_Q"]>;
  publicRateLimit: Mocked<RateLimit>;
  authRateLimit: Mocked<RateLimit>;
  bindingRateLimit: Mocked<RateLimit>;
  idMails: Mocked<SendEmail>;
  userObjects: Mocked<DurableObjectNamespace>;
  statsObjects: Mocked<DurableObjectNamespace>;
  notificationObjects: Mocked<DurableObjectNamespace>;
  imageTranscoderNamespace: Mocked<DurableObjectNamespace<oem_imgTrans>>;
  imageTranscoder: MockImageTranscoder;
}

function unconfigured<Method extends (...args: never[]) => unknown>(
  name: string,
): MockInstance<Method> & Method {
  // vi.fn normalizes overloaded signatures to the last overload. The throwing
  // implementation accepts every call; retain the original overloads in its type.
  return vi.fn<Method>().mockImplementation(() => {
    throw new Error(`Unconfigured mock binding: ${name}`);
  }) as unknown as MockInstance<Method> & Method;
}

function createBucket(): Mocked<R2Bucket> {
  return {
    head: unconfigured<R2Bucket["head"]>("UGC_BUCKET.head"),
    get: unconfigured<R2Bucket["get"]>("UGC_BUCKET.get"),
    put: unconfigured<R2Bucket["put"]>("UGC_BUCKET.put"),
    delete: unconfigured<R2Bucket["delete"]>("UGC_BUCKET.delete"),
    list: unconfigured<R2Bucket["list"]>("UGC_BUCKET.list"),
    createMultipartUpload: unconfigured<R2Bucket["createMultipartUpload"]>(
      "UGC_BUCKET.createMultipartUpload",
    ),
    resumeMultipartUpload: unconfigured<R2Bucket["resumeMultipartUpload"]>(
      "UGC_BUCKET.resumeMultipartUpload",
    ),
  };
}

function createQueue<Body>(name: string): Mocked<Queue<Body>> {
  return {
    send: unconfigured<Queue<Body>["send"]>(`${name}.send`),
    sendBatch: unconfigured<Queue<Body>["sendBatch"]>(`${name}.sendBatch`),
    metrics: unconfigured<Queue<Body>["metrics"]>(`${name}.metrics`),
  };
}

function createRateLimit(name: string): Mocked<RateLimit> {
  return { limit: unconfigured<RateLimit["limit"]>(`${name}.limit`) };
}

function createNamespace<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  name: string,
): Mocked<DurableObjectNamespace<T>> {
  return {
    newUniqueId: unconfigured<DurableObjectNamespace<T>["newUniqueId"]>(`${name}.newUniqueId`),
    idFromName: unconfigured<DurableObjectNamespace<T>["idFromName"]>(`${name}.idFromName`),
    idFromString: unconfigured<DurableObjectNamespace<T>["idFromString"]>(`${name}.idFromString`),
    get: unconfigured<DurableObjectNamespace<T>["get"]>(`${name}.get`),
    getByName: unconfigured<DurableObjectNamespace<T>["getByName"]>(`${name}.getByName`),
    jurisdiction: unconfigured<DurableObjectNamespace<T>["jurisdiction"]>(`${name}.jurisdiction`),
  };
}

function createImageTranscoder(): MockImageTranscoder {
  const id: DurableObjectId = {
    toString: () => "mock-image-transcoder",
    equals: (other) => other === id,
  };
  const stub = {
    id,
    name: "mock-image-transcoder",
    fetch: unconfigured<Fetcher["fetch"]>("OEM_IMG_TRANS.fetch"),
    connect: unconfigured<Fetcher["connect"]>("OEM_IMG_TRANS.connect"),
  };
  // Workers synthesizes RPC members from the Durable Object class. Materialize
  // stable, failing mocks on access; this cast is limited to that dynamic surface.
  return new Proxy(stub, {
    get(target, property, receiver) {
      // A stub returned by an async SDK lookup must not become a thenable.
      if (property === "then") {
        return undefined;
      }
      if (typeof property !== "string" || Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      const name = `OEM_IMG_TRANS.${property}`;
      const method = unconfigured(name);
      // RPC properties are awaited rather than called. Reject on either form
      // of use, without creating an unhandled rejected promise on mere access.
      const rejectedValue = () => Promise.reject(new Error(`Unconfigured mock binding: ${name}`));
      const promiseMethods: Pick<Promise<never>, "then" | "catch" | "finally"> = {
        then: (...args) => rejectedValue().then(...args),
        catch: (...args) => rejectedValue().catch(...args),
        finally: (...args) => rejectedValue().finally(...args),
      };
      Object.assign(method, promiseMethods);
      Reflect.set(target, property, method);
      return method;
    },
  }) as unknown as MockImageTranscoder;
}

/**
 * Fresh external mocks for each test. DB remains the caller's real test database.
 * External operations fail until the test explicitly supplies their behavior.
 */
export function createMockBindings(input: { DB: D1Database }): MockBindings {
  const ugcBucket = createBucket();
  const autoModerationQueue = createQueue<AutoModerationMsg>("OEM_MODERATION_Q");
  const translationQueue = createQueue<TranslationMsg>("OEM_TRANSLATION_Q");
  const webhookQueue = createQueue<WebhookMsg>("OEM_WEBHOOK_Q");
  const publicRateLimit = createRateLimit("OEM_PUBLIC_RATE_LIMIT");
  const authRateLimit = createRateLimit("OEM_AUTH_RATE_LIMIT");
  const bindingRateLimit = createRateLimit("OEM_BINDING_RATE_LIMIT");
  const idMails: Mocked<SendEmail> = { send: unconfigured<SendEmail["send"]>("OEM_ID_MAILS.send") };
  const userObjects = createNamespace("OEM_USER_DO");
  const statsObjects = createNamespace("OEM_STATS_DO");
  const notificationObjects = createNamespace("OEM_NOTIFICATION_DO");
  const imageTranscoderNamespace = createNamespace<oem_imgTrans>("OEM_IMG_TRANS");
  const imageTranscoder = createImageTranscoder();
  const bindings: Bindings = {
    ...testAuthConfig,
    DB: input.DB,
    UGC_BUCKET: ugcBucket,
    OEM_USER_DO: userObjects,
    OEM_STATS_DO: statsObjects,
    OEM_NOTIFICATION_DO: notificationObjects,
    OEM_IMG_TRANS: imageTranscoderNamespace,
    OEM_PUBLIC_RATE_LIMIT: publicRateLimit,
    OEM_AUTH_RATE_LIMIT: authRateLimit,
    OEM_BINDING_RATE_LIMIT: bindingRateLimit,
    OEM_MODERATION_Q: autoModerationQueue,
    OEM_TRANSLATION_Q: translationQueue,
    OEM_WEBHOOK_Q: webhookQueue,
    OEM_ID_MAILS: idMails,
    UPSTASH_REDIS_REST_URL: "https://redis.example.invalid",
    UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
  };
  return {
    bindings,
    ugcBucket,
    autoModerationQueue,
    translationQueue,
    webhookQueue,
    publicRateLimit,
    authRateLimit,
    bindingRateLimit,
    idMails,
    userObjects,
    statsObjects,
    notificationObjects,
    imageTranscoderNamespace,
    imageTranscoder,
  };
}

/** Metadata returned by a configured R2 operation; no object storage is emulated. */
export function createMockR2Object(input: {
  key: string;
  size: number;
  httpMetadata?: R2HTTPMetadata;
}): Mocked<R2Object> {
  return {
    key: input.key,
    size: input.size,
    version: "test-version",
    etag: "test-etag",
    httpEtag: '"test-etag"',
    checksums: { toJSON: unconfigured<R2Checksums["toJSON"]>("R2Object.checksums.toJSON") },
    uploaded: new Date("2026-09-01T00:00:00.000Z"),
    storageClass: "Standard",
    httpMetadata: input.httpMetadata,
    writeHttpMetadata: unconfigured<R2Object["writeHttpMetadata"]>("R2Object.writeHttpMetadata"),
  };
}
