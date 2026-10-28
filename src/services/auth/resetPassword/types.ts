export type PasswordResetContext = {
  // JSON operations supply parsed fields and use only this request's URL and headers.
  // Reset-link forwarding preserves the original method and leaves the body unread.
  raw_request: Request;
  requestId: string;
};

export type RequestPasswordResetInput = PasswordResetContext & {
  email: string;
  redirectTo: string;
  locale?: string;
};

export type ResetPasswordInput = PasswordResetContext & {
  token: string;
  newPassword: string;
  repeatPassword: string;
};

export type PasswordResetPreview = {
  ok: true;
  tokenValid: true;
  email: string;
};
