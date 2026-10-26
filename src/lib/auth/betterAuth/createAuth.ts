import { AsyncLocalStorage } from "node:async_hooks";

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getSchema } from "better-auth/db";

import { sameAuthEnvironment } from "@/lib/auth/environment";
import { toSerializableError } from "@/lib/auth/errors";
import type { Bindings } from "@/types/app";

import { createAuthConfiguration } from "./configuration";
import * as schemaCache from "./schemaCache";
import { wrapDatabaseWithSchemaCache, type SchemaQueryResults } from "./schemaCacheWrapper";

type AuthInvocation = { onError?: (error: unknown) => void };
const authInvocation = new AsyncLocalStorage<AuthInvocation>();

function buildAuth(env: Bindings, schemaQueryResults?: SchemaQueryResults) {
  const options = {
    ...createAuthConfiguration(env),
    onAPIError: {
      onError: (error, ctx) => {
        authInvocation.getStore()?.onError?.(error);
        console.error("[better-auth][api-error]", {
          oauthStateStrategy: ctx.oauthConfig.storeStateStrategy,
          hasSession: Boolean(ctx.session),
          error: toSerializableError(error),
        });
      },
    },
  } satisfies BetterAuthOptions;
  const wrapped = wrapDatabaseWithSchemaCache(
    env.DB,
    schemaQueryResults,
    () => new Set(Object.keys(getSchema(options))),
  );
  return { auth: betterAuth({ ...options, database: wrapped.db }), wrapped };
}

type Auth = ReturnType<typeof buildAuth>["auth"];

type AuthRuntime = { env: Bindings; auth: Auth; ready: Promise<void>; defaultFacade?: Auth };
const requestAuthContext = new AsyncLocalStorage<WeakMap<D1Database, AuthRuntime>>();

export function runWithAuthRequest<T>(handler: () => T): T {
  return requestAuthContext.run(new WeakMap(), handler);
}

export function createAuth(env: Bindings, options?: AuthInvocation): Auth {
  const runtimesByDB = requestAuthContext.getStore();
  let runtime = runtimesByDB?.get(env.DB);
  if (!runtime || !sameAuthEnvironment(runtime.env, env)) {
    const currentSlot = schemaCache.getOrInit(env.DB);
    const requestEnv = { ...env };
    const { auth, wrapped } = buildAuth(requestEnv, currentSlot.schemaQueryResults);
    const ready = auth.$context.then(async (context) => {
      await context.checkSchema?.();
      if (!currentSlot.schemaQueryResults) {
        currentSlot.schemaQueryResults = new Map(wrapped.getUncachedResults());
      }
    });
    runtime = { env: requestEnv, auth, ready };
    runtimesByDB?.set(env.DB, runtime);
    void ready.catch(() => {
      if (runtimesByDB && runtimesByDB.get(env.DB) === runtime) {
        runtimesByDB.delete(env.DB);
      }
    });
  }
  if (!options && runtime.defaultFacade) {
    return runtime.defaultFacade;
  }
  const { auth, ready } = runtime;
  // Each request owns its Kysely connection/lock and pending checks. Only plain,
  // successfully validated schema results are shared across requests.
  const handler: Auth["handler"] = (request) =>
    ready.then(() => authInvocation.run(options ?? {}, () => auth.handler(request)));
  const api = new Proxy(auth.api, {
    get(target, key, receiver) {
      const endpoint = Reflect.get(target, key, receiver);
      if (typeof endpoint !== "function") {
        return endpoint;
      }
      return new Proxy(endpoint, {
        apply(fn, thisArg, args) {
          return ready.then(() =>
            authInvocation.run(options ?? {}, () => Reflect.apply(fn, thisArg, args)),
          );
        },
      });
    },
  });
  const facade = { ...auth, handler, fetch: handler, api };
  if (!options) {
    runtime.defaultFacade = facade;
  }
  return facade;
}
