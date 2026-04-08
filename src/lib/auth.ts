import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { Bindings } from "../types/app";

const DEV_AUTH_SECRET = "dev-only-better-auth-secret-change-in-production";

export function createAuth(env: Bindings) {
  return betterAuth({
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL ?? "http://127.0.0.1:8787",
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET ?? DEV_AUTH_SECRET,
    trustedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true
    },
    user: {
      modelName: "auth_users"
    },
    session: {
      modelName: "auth_sessions"
    },
    account: {
      modelName: "auth_accounts"
    },
    verification: {
      modelName: "auth_verifications"
    },
    plugins: [bearer()],
    advanced: {
      database: {
        generateId: () => crypto.randomUUID()
      }
    }
  });
}
