// The route extracts these values from the incoming request.
export type RegistrationRequest = {
  url: string;
  origin?: string;
  referer?: string;
  cookie?: string;
  authorization?: string;
  clientIp?: string;
  userAgent?: string;
  acceptedLanguages?: string;
  emailLocale?: string;
  // This is the incoming x-request-id value.
  // The application may generate a different request ID.
  requestIdHeader?: string;
};

type RegistrationContext = {
  request: RegistrationRequest;
  requestId: string;
};

export type RequestRegistrationOtpInput = RegistrationContext & {
  email: string;
  locale?: string;
};

export type RegisterViaOTPInput = RegistrationContext & {
  email: string;
  otp: string;
  password: string;
  name?: string;
};

export type RegistrationResult = {
  status: number;
  // The adapter copies the response body as bytes without parsing or re-encoding it.
  body: ArrayBuffer | null;
  headers: Array<[name: string, value: string]>;
  // The route emits each cookie in a separate Set-Cookie header.
  cookies: string[];
};
