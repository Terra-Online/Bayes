import { z } from "zod";

export const socialProviderSchema = z.enum(["google", "discord", "github"]);

export const linkAccountSchema = z.object({
  provider: socialProviderSchema,
  callbackURL: z.string().optional(),
  errorCallbackURL: z.string().optional(),
  disableRedirect: z.boolean().optional(),
});

export const unlinkAccountSchema = z.object({
  provider: z.enum(["email", "google", "discord", "github"]),
});

export const sendTemplateOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
  type: z.literal("sign-in").default("sign-in"),
  locale: z.string().trim().min(1).optional(),
});

export const registerWithOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(20, "Password must be 20 characters or fewer.")
    .regex(/[A-Z]/, "Password must include at least one uppercase letter.")
    .regex(/^\S+$/, "Password cannot contain spaces."),
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "OTP must be 6 digits."),
  name: z.string().trim().min(1).max(64).optional(),
});

export const requestPasswordResetSchema = z.object({
  email: z.string().email("Invalid email address."),
  redirectTo: z.string().url("Invalid redirect URL."),
  locale: z.string().trim().min(1).optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, "Token is required."),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(20, "Password must be 20 characters or fewer.")
    .regex(/[A-Z]/, "Password must include at least one uppercase letter.")
    .regex(/^\S+$/, "Password cannot contain spaces."),
  repeatPassword: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(20, "Password must be 20 characters or fewer.")
    .regex(/[A-Z]/, "Password must include at least one uppercase letter.")
    .regex(/^\S+$/, "Password cannot contain spaces."),
});

export const resetPasswordPreviewSchema = z.object({
  token: z.string().trim().min(1, "Token is required."),
});

export const sessionExchangeSchema = z.object({
  code: z.string().trim().min(16, "Code is required."),
});

export const userResponseSchema = z
  .object({
    uid: z
      .string()
      .describe(
        "Public UID, not the internal user ID. The suffix is provisional while needsProfileSetup is true and finalizes on the first successful nickname confirmation.",
      ),
    role: z.enum(["n", "p", "a", "s", "r"]),
    karma: z.number(),
    avatar: z.number(),
    email: z.string(),
    nickname: z.string(),
    registeredAt: z.string().optional(),
    needsProfileSetup: z
      .boolean()
      .describe(
        "Confirm the nickname on this existing profile to finalize the UID suffix. Later nickname edits preserve the complete UID.",
      ),
  })
  .meta({ ref: "User" });

export const sessionResponseSchema = z.object({
  user: userResponseSchema,
  requiresCookieConfirmation: z
    .literal(true)
    .optional()
    .describe(
      "A replacement session cookie was issued. Request the session again with browser credentials to confirm that the cookie is accepted; confirmation succeeds when this field is absent.",
    ),
});

// Better Auth owns these forwarded payloads. Keep their model distinct from
// the business user returned by /session (whose uid is the public UID).
export const authProviderUserSchema = z
  .looseObject({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ ref: "AuthProviderUser" });
export const passwordLoginSchema = z.looseObject({
  email: z.string(),
  password: z.string(),
  rememberMe: z.boolean().optional(),
  callbackURL: z.string().optional(),
});
export const socialLoginSchema = linkAccountSchema
  .extend({
    newUserCallbackURL: z.string().optional(),
    requestSignUp: z.boolean().optional(),
  })
  .loose();
export const passwordLoginResponseSchema = z.looseObject({
  redirect: z.boolean(),
  token: z.string(),
  url: z.string().optional(),
  user: authProviderUserSchema,
});
export const registrationResponseSchema = z.looseObject({
  token: z.string(),
  user: authProviderUserSchema,
});
export const socialLoginResponseSchema = z.looseObject({
  redirect: z.boolean(),
  url: z.string().optional(),
});
export const loginMethodsResponseSchema = z.object({
  accounts: z.array(
    z.object({
      provider: z.string(),
      linkedAt: z.string(),
      verified: z.boolean().optional(),
      unlinkable: z.boolean(),
    }),
  ),
});
export const passwordResetPreviewResponseSchema = z.object({
  ok: z.literal(true),
  tokenValid: z.literal(true),
  email: z.string(),
});
