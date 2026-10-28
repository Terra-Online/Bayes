type RegistrationContext = {
  // The route parses JSON first. The adapter reads only this request's URL and headers.
  raw_request: Request;
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
