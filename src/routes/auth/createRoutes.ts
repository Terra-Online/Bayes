import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import type { AppEnv } from "@/types/app";

import { createRoutes as createEmailRoutes } from "./emailRoutes";
import { createRoutes as createLoginMethodsRoutes } from "./loginMethodsRoutes";
import { createRoutes as createPasswordResetRoutes } from "./passwordResetRoutes";
import { createRoutes as createSessionRoutes } from "./sessionRoutes";
import { createRoutes as createSocialRoutes } from "./socialRoutes";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .route("/", createEmailRoutes())
    .route("/", createPasswordResetRoutes())
    .route("/", createSocialRoutes())
    .route("/", createSessionRoutes())
    .route("/", createLoginMethodsRoutes())
    .on(["GET", "POST", "OPTIONS"], "/*", async () => {
      throw new ApiError(404, "NOT_FOUND", "Not found.");
    });
}
