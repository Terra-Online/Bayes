import type { Context } from "hono";
import type { AppEnv } from "../../types/app";

export type AuthRouteContext = Context<AppEnv>;

export type ForwardToAuthJsonPath = (
  c: AuthRouteContext,
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string> }
) => Response | Promise<Response>;

export type ForwardToAuthRawRequest = (c: AuthRouteContext) => Response | Promise<Response>;
