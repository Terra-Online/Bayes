import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/betterAuth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { onAppError } from "@/middleware/error-handler";
import { createRoutes as createSyncRoutes } from "@/routes/sync/createRoutes";
import { readDecryptedBindingCache } from "@/services/official/auth/credentialCache";
import {
  createCredentialRecoveryScope,
  readBindingCredentials,
  recoverBindingCredentials,
} from "@/services/official/auth/credentials";
import {
  createEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT,
} from "@/services/official/client/deviceProfile";
import { getSignature } from "@/services/official/client/signature";
import { serializeEndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type AuthenticatedUserFixture } from "@/test/fixtures/auth";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes as createBindingRoutes } from "./createRoutes";

const oldDevice = "a".repeat(32);
const newDevice = "c".repeat(32);
const oldProfile = serializeEndfieldDeviceProfile(
  createEndfieldDeviceProfile(oldDevice, SKLAND_DEVICE_PROFILE_USER_AGENT),
);
const refreshUrl = "https://zonai.skland.com/web/v1/auth/refresh";
const mapPath = "/web/v1/game/endfield/map/mark/list";

interface RefreshGate {
  entered: boolean;
  response: Promise<Response>;
  release: () => void;
}
interface StoredCredentials {
  cred_enc: string;
  token_enc: string;
}
interface SignedMapCredential {
  token: string;
  device: string;
}

let database: TestDatabase;
let env: Bindings;
let identity: AuthenticatedUserFixture;
let refresh: (device: string) => Response | Promise<Response>;
let refreshDevices: string[];
let mapCredentials: SignedMapCredential[];
let fingerprintEnabled: boolean;
let externalFailures: unknown[];
let gates: RefreshGate[];
let pending: Promise<unknown>[];
let writtenTokens: string[];

function holdRefresh(): RefreshGate {
  let release!: () => void;
  const response = new Promise<Response>((resolve) => {
    release = () => resolve(Response.json({ code: 0, data: { token: "late-token" } }));
  });
  const gate = { entered: false, response, release };
  gates.push(gate);
  return gate;
}

// A deadline makes a blocked second request fail while the first gate is still closed.
async function completesWhileHeld<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Request blocked behind pending refresh")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function storedCredentials(): StoredCredentials {
  return database.sqlite
    .prepare("SELECT cred_enc, token_enc FROM endfield_bindings WHERE uid = 'user'")
    .get() as unknown as StoredCredentials;
}
function storedProfile(): string {
  return String(
    database.sqlite
      .prepare("SELECT device_profile FROM endfield_role_device_profiles WHERE role_id = 'role'")
      .get()!.device_profile,
  );
}
async function expectStoredWinner(): Promise<void> {
  const stored = storedCredentials();
  expect(await decryptSecret(stored.cred_enc, env.BETTER_AUTH_SECRET!)).toBe("cred");
  expect(await decryptSecret(stored.token_enc, env.BETTER_AUTH_SECRET!)).toBe("new-token");
}
// Inspect every write, since a final-row check could miss a late overwrite
// that was subsequently repaired by another request.
async function expectOnlyWinningTokenWasWritten(): Promise<void> {
  const persistedTokens = await Promise.all(
    writtenTokens.map((value) => decryptSecret(value, env.BETTER_AUTH_SECRET!)),
  );
  expect(persistedTokens).toEqual(["new-token"]);
}

function configureDeviceReplacementRecovery(): void {
  fingerprintEnabled = true;
  refresh = (device) =>
    Response.json(
      device === oldDevice
        ? { code: 10001, message: "device rejected" }
        : { code: 0, data: { token: "new-token" } },
    );
}

function request(operation: "sync" | "unlink" = "sync"): Promise<Response> {
  const app = new Hono<AppEnv<{ requestId: string }>>()
    .onError(onAppError)
    .use(
      "*",
      createMiddleware<AppEnv<{ requestId: string }>>(async (c, next) => {
        c.set("requestId", "credentials-request");
        await next();
      }),
    )
    .route("/sync/v1", createSyncRoutes())
    .route("/binding/v1", createBindingRoutes());
  const unlink = operation === "unlink";
  const response = runWithAuthRequest(async () =>
    app.request(
      unlink ? "http://localhost/binding/v1/endfield/unlink" : "http://localhost/sync/v1/official",
      { method: unlink ? "POST" : "GET", headers: identity.headers },
      env,
    ),
  );
  pending.push(response);
  return response;
}
async function expectSync(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    binding: { bound: true, enabled: true, roleId: "role" },
    markedIds: [],
    markers: [],
  });
}

beforeEach(async () => {
  gates = [];
  pending = [];
  refreshDevices = [];
  mapCredentials = [];
  externalFailures = [];
  fingerprintEnabled = false;
  writtenTokens = [];
  database = createTestDatabase();
  identity = insertAuthenticatedUser(database.sqlite, { uid: "user" });
  const mocks = createMockBindings({ DB: database.db });
  mocks.bindingRateLimit.limit.mockResolvedValue({ success: true });
  env = mocks.bindings;
  database.sqlite
    .prepare(`INSERT INTO endfield_bindings
    (uid, provider, server_id, role_id, cred_enc, token_enc, status, updated_at)
    VALUES ('user', 'skland', 1, 'role', ?, ?, 'enabled', 'old')`)
    .run(
      await encryptSecret("cred", env.BETTER_AUTH_SECRET!),
      await encryptSecret("token", env.BETTER_AUTH_SECRET!),
    );
  database.sqlite
    .prepare(
      "INSERT INTO endfield_role_device_profiles (role_id, device_profile) VALUES ('role', ?)",
    )
    .run(oldProfile);
  // Observe every credential update, so a transient late-token write cannot be
  // hidden by a later restoration of the winning value.
  database.sqlite.function("observe_token_write", (value) => {
    writtenTokens.push(String(value));
    return 0;
  });
  database.sqlite.exec(
    "CREATE TRIGGER observe_token_update AFTER UPDATE OF token_enc ON endfield_bindings BEGIN SELECT observe_token_write(NEW.token_enc); END",
  );
  refresh = () => Response.json({ code: 0, data: { token: "new-token" } });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      try {
        const upstream = new Request(input, init);
        const url = new URL(upstream.url);
        const device = upstream.headers.get("x-deviceid")!;
        if (upstream.url === refreshUrl && upstream.method === "GET") {
          expect(await upstream.text()).toBe("");
          expect(upstream.headers.get("cred")).toBe("cred");
          expect([oldDevice, newDevice]).toContain(device);
          refreshDevices.push(device);
          return await refresh(device);
        }
        if (
          url.origin === "https://zonai.skland.com" &&
          url.pathname === mapPath &&
          upstream.method === "GET"
        ) {
          expect(await upstream.text()).toBe("");
          expect(Object.fromEntries(url.searchParams)).toEqual({
            mapId: expect.stringMatching(/^map0[12]$/),
            roleId: "role",
            serverId: "1",
          });
          expect(upstream.headers.get("cred")).toBe("cred");
          expect([oldDevice, newDevice]).toContain(device);
          const signedPath = `${mapPath}mapId=${url.searchParams.get("mapId")}&roleId=role&serverId=1`;
          // Tokens travel as signatures, never as plaintext. Verify which credential
          // the real client used, rather than returning success for every retry.
          for (const token of ["token", "new-token", "late-token"]) {
            const signature = await getSignature(
              signedPath,
              upstream.headers.get("timestamp")!,
              token,
              "",
              device,
            );
            if (upstream.headers.get("sign") !== signature) {
              continue;
            }
            mapCredentials.push({ token, device });
            return Response.json(token === "token" ? { code: 401 } : { code: 0, data: [] });
          }
          throw new Error("Unrecognized map credential signature");
        }
        if (
          fingerprintEnabled &&
          upstream.url === "https://fp-it.portal101.cn/deviceprofile/v4" &&
          upstream.method === "POST"
        ) {
          expect(await upstream.json()).toEqual({
            appId: "default",
            compress: 2,
            data: expect.any(String),
            encode: 5,
            ep: expect.any(String),
            organization: "UWXspnCCJN4sfYlNfqps",
            os: "web",
          });
          return Response.json({ code: 1100, detail: { deviceId: newDevice } });
        }
        // skland-kit obtains its device before attempting this empty-code sign-in.
        if (
          fingerprintEnabled &&
          upstream.url === "https://zonai.skland.com/web/v1/user/auth/generate_cred_by_code" &&
          upstream.method === "POST"
        ) {
          expect(upstream.headers.get("did")).toBe(`B${newDevice}`);
          expect(await upstream.json()).toEqual({ code: "", kind: 1 });
          return Response.json({ code: 401, data: {} });
        }
        throw new Error(`Unconfigured external request: ${upstream.method} ${upstream.url}`);
      } catch (error) {
        externalFailures.push(error);
        throw error;
      }
    }),
  );
});
afterEach(async () => {
  try {
    for (const gate of gates) {
      gate.release();
    }
    await Promise.allSettled(pending);
    expect(externalFailures).toEqual([]);
  } finally {
    database.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("request-owned credential refresh and conditional persistence", () => {
  it("preserves valid stored credentials after incomplete provider refresh and retries on a later sync", async () => {
    const before = storedCredentials();
    refresh = () => Response.json({ code: 0, data: {} });
    const failed = await request();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "ENDFIELD_REFRESH_TOKEN_MISSING" });
    expect(storedCredentials()).toEqual(before);
    expect(storedProfile()).toBe(oldProfile);
    refresh = () => Response.json({ code: 0, data: { token: "new-token" } });
    await expectSync(await request());
    await expectStoredWinner();
    expect(storedProfile()).toBe(oldProfile);
  });

  it("deduplicates refreshes inside the same request", async () => {
    const dependencies = { env, recoveryScope: createCredentialRecoveryScope() };
    const binding = await readBindingCredentials({ uid: "user" }, env);
    const input = {
      uid: "user",
      rejectedCredentials: binding,
      rejection: new ApiError(401, "ENDFIELD_CREDENTIAL_REJECTED", "rejected"),
    };
    const calls = [
      recoverBindingCredentials(input, dependencies),
      recoverBindingCredentials(input, dependencies),
    ];
    pending.push(...calls);
    const result = await Promise.all(calls);
    expect(refreshDevices).toEqual([oldDevice]);
    expect(result).toEqual([
      expect.objectContaining({ cred: "cred", token: "new-token" }),
      expect.objectContaining({ cred: "cred", token: "new-token" }),
    ]);
  });

  it("does not block another request or let a late refresh overwrite its committed credentials", async () => {
    const gate = holdRefresh();
    refresh = () => {
      if (!gate.entered) {
        gate.entered = true;
        return gate.response;
      }
      return Response.json({ code: 0, data: { token: "new-token" } });
    };
    const first = request();
    await vi.waitFor(() => expect(gate.entered).toBe(true));
    await expectSync(await completesWhileHeld(request()));
    await expectStoredWinner();
    gate.release();
    await expectSync(await first);
    expect(mapCredentials.filter(({ token }) => token !== "token")).toEqual(
      Array.from({ length: 4 }, () => ({ token: "new-token", device: oldDevice })),
    );
    await expectStoredWinner();
    await expectOnlyWinningTokenWasWritten();
  });

  it("cannot resurrect a binding unlinked during a refresh", async () => {
    const gate = holdRefresh();
    refresh = () => {
      gate.entered = true;
      return gate.response;
    };
    const first = request();
    await vi.waitFor(() => expect(gate.entered).toBe(true));
    const unlinked = await completesWhileHeld(request("unlink"));
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toEqual({ ok: true, binding: { bound: false, enabled: false } });
    gate.release();
    const response = await first;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ENDFIELD_BINDING_NOT_FOUND" });
    expect(database.sqlite.prepare("SELECT * FROM endfield_bindings").all()).toEqual([]);
    expect(readDecryptedBindingCache(env, "user")).toBeNull();
  });

  it("commits a recovered device profile atomically with its matching credentials", async () => {
    configureDeviceReplacementRecovery();
    await expectSync(await request());
    expect(refreshDevices).toEqual([oldDevice, newDevice]);
    expect(JSON.parse(storedProfile())).toMatchObject({ deviceId: newDevice });
    expect(mapCredentials.filter(({ token }) => token !== "token")).toEqual([
      { token: "new-token", device: newDevice },
      { token: "new-token", device: newDevice },
    ]);
    await expectStoredWinner();
    await expectOnlyWinningTokenWasWritten();
  });

  it("skips a late device-profile write when another request has already refreshed credentials", async () => {
    // Observe writes independently of the valid preseeded row, including no-op
    // upserts that an unchanged-value assertion alone would miss.
    let profileWrites = 0;
    database.sqlite.function("observe_profile_write", () => {
      profileWrites++;
      return 0;
    });
    database.sqlite
      .exec(`CREATE TRIGGER observe_profile_insert BEFORE INSERT ON endfield_role_device_profiles BEGIN SELECT observe_profile_write(); END;
      CREATE TRIGGER observe_profile_update BEFORE UPDATE ON endfield_role_device_profiles BEGIN SELECT observe_profile_write(); END;`);
    fingerprintEnabled = true;
    const gate = holdRefresh();
    refresh = (device) => {
      if (device === newDevice) {
        gate.entered = true;
        return gate.response;
      }
      return Response.json(
        gate.entered
          ? { code: 0, data: { token: "new-token" } }
          : { code: 10001, message: "device rejected" },
      );
    };
    const first = request();
    await vi.waitFor(() => expect(gate.entered).toBe(true));
    await expectSync(await completesWhileHeld(request()));
    await expectStoredWinner();
    expect(storedProfile()).toBe(oldProfile);
    gate.release();
    await expectSync(await first);
    expect(mapCredentials.filter(({ token }) => token !== "token")).toEqual(
      Array.from({ length: 4 }, () => ({ token: "new-token", device: oldDevice })),
    );
    expect(storedProfile()).toBe(oldProfile);
    expect(profileWrites).toBe(0);
    await expectStoredWinner();
    await expectOnlyWinningTokenWasWritten();
  });

  it("rolls back the credential update when device-profile persistence fails", async () => {
    const before = storedCredentials();
    let rejectedProfileWrites = 0;
    database.sqlite.function("observe_profile_rejection", () => {
      rejectedProfileWrites++;
      return 0;
    });
    database.sqlite.exec(
      "CREATE TRIGGER reject_profile BEFORE INSERT ON endfield_role_device_profiles BEGIN SELECT observe_profile_rejection(); SELECT RAISE(ABORT, 'profile write rejected'); END",
    );
    configureDeviceReplacementRecovery();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(errorLog).toHaveBeenCalledWith(
      "request failed",
      expect.objectContaining({
        rawError: expect.objectContaining({ message: "profile write rejected" }),
      }),
    );
    expect(rejectedProfileWrites).toBe(1);
    expect(storedCredentials()).toEqual(before);
    expect(storedProfile()).toBe(oldProfile);
  });
});
