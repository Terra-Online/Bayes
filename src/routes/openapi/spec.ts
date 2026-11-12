import { Hono } from "hono";
import type { GenerateSpecOptions } from "hono-openapi";

import type { AppEnv } from "@/types/app";

export function specOptions(sessionCookieName: string): Partial<GenerateSpecOptions> {
  return {
    documentation: {
      info: {
        title: "Bayes API",
        version: "1",
        description:
          "HTTP contract for Atlos and Cor. Use operation descriptions for preconditions and recovery, and schema descriptions for field meanings. The client integration guide covers workflows across requests.",
      },
      servers: [{ url: "/", description: "Current backend" }],
      externalDocs: {
        description: "Client integration: sessions, synchronization, content, and live updates",
        url: "https://github.com/Terra-Online/Bayes/blob/HEAD/docs/client-integration.md",
      },
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: sessionCookieName,
            description:
              "Use the session cookie set by the backend. Cookie names and attributes depend on the deployment; browser clients send credentials: include.",
          },
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "Existing session token. This is not a JWT.",
          },
        },
      },
    },
    includeEmptyPaths: false,
    excludeMethods: [],
    exclude: [/^\/__demo(?:\/|$)/, /^\/docs?$/, /^\/openapi\.json$/],
    defaultValidationErrorResponse: false,
  };
}

export function documentedApp(app: Pick<Hono, "routes">): Hono<AppEnv> {
  const documented = new Hono<AppEnv>();
  // OpenAPI uses named parameters for Hono's catch-all wildcard. Only copy the
  // inventory used by the generator; serving routes stay unchanged.
  documented.routes.push(
    ...app.routes.map((route) => ({ ...route, path: route.path.replace(/\/\*$/, "/:path") })),
  );
  return documented;
}
