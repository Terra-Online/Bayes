import { Hono } from "hono";

import { decryptSecret } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { requireAuth } from "@/middleware/auth";
import { getBinding } from "@/repositories/binding/repository";
import { agreeSchema } from "@/routes/schema/locator";
import { getCredentialSecret } from "@/services/official/auth/credentials";
import { getBindingDeviceProfile } from "@/services/official/auth/deviceProfile";
import { publicBinding } from "@/services/official/auth/publicBinding";
import { agreePolicy } from "@/services/official/client/mapClient";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .use("/*", requireAuth)
    .post("/agree-policy", async (c) => {
      const user = c.get("authUser");
      const binding = await getBinding(c.env.DB, user.uid);
      if (!binding) {
        throw new ApiError(
          404,
          "ENDFIELD_BINDING_NOT_FOUND",
          "Endfield binding is not configured.",
        );
      }
      if (binding.status !== "enabled") {
        throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
      }

      const payload = await c.req.json().catch(() => undefined);
      const parsed = agreeSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid agree-policy payload.",
          parsed.error.flatten(),
        );
      }

      const reqRole = parsed.data?.roleId;
      const reqServer = parsed.data?.serverId;
      if (
        (reqRole && reqRole !== binding.role_id) ||
        (reqServer !== undefined && Number(reqServer) !== Number(binding.server_id))
      ) {
        throw new ApiError(
          409,
          "ENDFIELD_BINDING_MISMATCH",
          "Policy authorization target does not match the current Endfield binding.",
        );
      }

      const secret = getCredentialSecret(c.env);
      await agreePolicy({
        provider: binding.provider,
        roleId: binding.role_id,
        serverId: Number(binding.server_id),
        cred: await decryptSecret(binding.cred_enc, secret),
        token: await decryptSecret(binding.token_enc, secret),
        deviceProfile: await getBindingDeviceProfile(c.env.DB, binding),
      });

      return c.json({ ok: true, binding: publicBinding(binding) });
    });
}
