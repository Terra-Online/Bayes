import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../lib/auth/createAuth";
import { ensureUserProfile } from "../repositories/users";
import type { AppEnv, Bindings } from "../types/app";
import { invalidateAuthUserCache, resolveAuthIdentity, resolveAuthUser, resolveContextAuthUser } from "./auth";

vi.mock("../lib/auth/createAuth", () => ({ createAuth: vi.fn() }));
vi.mock("../lib/auth/browserSession", () => ({ resolveBrowserSessionHeaders: (_auth: unknown, headers: Headers) => ({ headers }) }));
vi.mock("../repositories/users", () => ({ ensureUserProfile: vi.fn(), formatPublicUid: () => "100001AA" }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const identity = { uid: "first", email: "first@example.test" };
const session = { user: { id: identity.uid, email: identity.email, name: "First" } };
function environment() { return { DB: {} } as Bindings; }
function headers() { return new Headers({ authorization: "Bearer same-token" }); }

describe("request-owned auth lookups", () => {
  const getSession = vi.fn();
  beforeEach(() => {
    vi.mocked(createAuth).mockClear();
    getSession.mockReset().mockResolvedValue(session);
    vi.mocked(createAuth).mockReturnValue({ api: { getSession } } as unknown as ReturnType<typeof createAuth>);
    vi.mocked(ensureUserProfile).mockReset().mockImplementation(async (_db, input) => ({
      ...input, role: "n", karma: 0, avt: 1, nickname: "First", nicknameCustomized: true,
    }) as Awaited<ReturnType<typeof ensureUserProfile>>);
  });

  it.each([undefined, "analytics=abc; cf_clearance=xyz"])("avoids auth initialization without credentials (%s)", async (cookie) => {
    const requestHeaders = new Headers(cookie ? { cookie } : undefined);
    await expect(resolveAuthIdentity(environment(), requestHeaders)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    expect(createAuth).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not join another request's pending identity lookup, and can retry failure", async () => {
    const env = environment();
    const blocked = deferred<typeof session>();
    getSession.mockReturnValueOnce(blocked.promise);
    const first = resolveAuthIdentity(env, headers());
    const failed = expect(first).rejects.toThrow("owner canceled");
    await expect(resolveAuthIdentity(env, headers())).resolves.toMatchObject(identity);
    expect(getSession).toHaveBeenCalledTimes(2);
    blocked.reject(new Error("owner canceled"));
    await failed;
    // Completed identities retain the existing short TTL.
    await resolveAuthIdentity(env, headers());
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("does not join another request's pending profile lookup", async () => {
    const env = environment();
    const blocked = deferred<Awaited<ReturnType<typeof ensureUserProfile>>>();
    vi.mocked(ensureUserProfile).mockReturnValueOnce(blocked.promise);
    const first = resolveAuthUser(env, headers(), identity);
    await expect(resolveAuthUser(env, headers(), identity)).resolves.toMatchObject(identity);
    expect(ensureUserProfile).toHaveBeenCalledTimes(2);
    const failed = expect(first).rejects.toThrow("owner canceled");
    blocked.reject(new Error("owner canceled"));
    await failed;
  });

  it("deduplicates concurrent helpers within a Hono request", async () => {
    const env = environment();
    const app = new Hono<AppEnv>();
    app.get("/", async (c) => {
      const users = await Promise.all([resolveContextAuthUser(c), resolveContextAuthUser(c)]);
      expect(users[0]).toBe(users[1]);
      return c.json({ uid: users[0]!.uid });
    });
    expect((await app.request("/", { headers: headers() }, env)).status).toBe(200);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(ensureUserProfile).toHaveBeenCalledTimes(1);
  });

  it("isolates completed values by bindings/configuration and invalidates the right environment", async () => {
    const env = environment();
    await resolveAuthIdentity(env, headers());
    const other = environment();
    getSession.mockResolvedValue({ user: { id: "second", email: "second@example.test" } });
    expect(await resolveAuthIdentity(other, headers())).toMatchObject({ uid: "second" });
    expect(await resolveAuthIdentity(env, headers())).toMatchObject({ uid: "first" });
    invalidateAuthUserCache(headers(), env);
    getSession.mockResolvedValue(null);
    await expect(resolveAuthIdentity(env, headers())).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(await resolveAuthIdentity(other, headers())).toMatchObject({ uid: "second" });
    other.BETTER_AUTH_SECRET = "rotated";
    await expect(resolveAuthIdentity(other, headers())).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("keeps completed auth values when an unrelated binding wrapper changes", async () => {
    const env = environment();
    await resolveAuthIdentity(env, headers());
    const next = {
      ...env,
      OEM_KV: {} as KVNamespace,
      OEM_ID_MAILS: {} as Bindings["OEM_ID_MAILS"],
      UPSTASH_REDIS_REST_URL: "https://unrelated.example",
      UPSTASH_REDIS_REST_TOKEN: "unrelated-token"
    };
    getSession.mockResolvedValue(null);
    await expect(resolveAuthIdentity(next, headers())).resolves.toMatchObject(identity);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("never substitutes a warm cached account for a freshly verified different user", async () => {
    const env = environment();
    await resolveAuthUser(env, headers(), identity);
    const second = await resolveAuthUser(env, headers(), { uid: "second", email: "second@example.test" });
    expect(second.uid).toBe("second");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not repopulate a revoked cache from an older pending lookup", async () => {
    const env = environment();
    const blocked = deferred<typeof session>();
    getSession.mockReturnValueOnce(blocked.promise);
    const first = resolveAuthIdentity(env, headers());
    invalidateAuthUserCache(headers(), env);
    blocked.resolve(session);
    await first;
    getSession.mockResolvedValue(null);
    await expect(resolveAuthIdentity(env, headers())).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
