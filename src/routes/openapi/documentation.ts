import { swaggerUI } from "@hono/swagger-ui";
import { createCookieGetter } from "better-auth/cookies";
import { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { createMiddleware } from "hono/factory";

import { isLocalBackendUrl } from "@/lib/isLocalBackendUrl";
import { authCookieOptions } from "@/services/auth/betterAuth/origins";
import type { AppEnv } from "@/types/app";

import { documentedApp, specOptions } from "./spec";

const requireDocsEnabled = createMiddleware<AppEnv>(async (c, next) => {
  const configured = c.env.API_DOCS_ENABLED?.trim().toLowerCase();
  const enabled = configured
    ? ["1", "true", "on", "yes"].includes(configured)
    : isLocalBackendUrl(c.env.BETTER_AUTH_URL);
  c.header("Cache-Control", "private, no-store");
  if (!enabled) {
    return c.notFound();
  }
  await next();
});

export function createDocumentation(app: Pick<Hono, "routes">) {
  const documented = documentedApp(app);
  // Cache immutable specifications by cookie scheme, never by request context.
  const handlers = new Map<string, ReturnType<typeof openAPIRouteHandler<AppEnv, "/">>>();
  return {
    redirect: new Hono<AppEnv>()
      .use("*", requireDocsEnabled)
      .get("/", (c) => c.redirect("/docs", 307)),
    spec: new Hono<AppEnv>().use("*", requireDocsEnabled).get("/", (c, next) => {
      const cookieName = createCookieGetter(authCookieOptions(c.env))("session_token").name;
      let handler = handlers.get(cookieName);
      if (!handler) {
        handler = openAPIRouteHandler(documented, specOptions(cookieName));
        handlers.set(cookieName, handler);
      }
      return handler(c, next);
    }),
    ui: new Hono<AppEnv>().use("*", requireDocsEnabled).get("/", (c, next) =>
      swaggerUI<AppEnv>({
        url: "/openapi.json",
        supportedSubmitMethods: isLocalBackendUrl(c.env.BETTER_AUTH_URL)
          ? ["get", "post", "put", "patch", "delete", "options", "head"]
          : [],
        persistAuthorization: false,
        validatorUrl: "",
      })(c, next),
    ),
  };
}
