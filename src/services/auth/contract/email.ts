// Registration, password sign-in and password reset use the same email format.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
