import { AuthError } from "./errors";

/** The codes /guest, and a guest's refresh, answer with; any other text is not a code. */
const GUEST_ERRORS = new Set([
  "method_not_enabled",
  "signup_disabled",
  "rate_limited",
  "captcha_required",
  "captcha_failed",
  "captcha_unavailable",
  "invalid_request",
]);

/** The same error, its code named by what the server said when it is a known one. */
export function namedGuestError(error: unknown): unknown {
  if (!(error instanceof AuthError) || !GUEST_ERRORS.has(error.message)) return error;
  return new AuthError(error.message, error.message, error.status, error.cause);
}
