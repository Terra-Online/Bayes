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

export const profileUpdateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "Nickname must be at least 2 characters.")
    .max(26, "Nickname must be 26 characters or fewer.")
    .regex(/^[A-Za-z0-9_-]+$/, "Nickname can only contain letters, numbers, '_' or '-'."),
  avatar: z.number().int().min(1).max(99).optional(),
  avt: z.number().int().min(1).max(99).optional(),
});
