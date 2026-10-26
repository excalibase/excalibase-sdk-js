import { AuthError } from "./errors";

/** `magiclink` mails a link to the app; `email` mails a six-digit code. */
export type EmailOtpType = "magiclink" | "email";

export const EMAIL_OTP_TYPES: readonly EmailOtpType[] = ["magiclink", "email"];

export interface SignInWithOtpOptions {
  email: string;
  /** Defaults to `magiclink`. */
  type?: EmailOtpType;
  /** Where a link lands: the site URL (the default) or one of the project's redirect URLs. */
  emailRedirectTo?: string;
  /** Make an account for a new address, if the project takes sign-ups. Defaults to true. */
  shouldCreateUser?: boolean;
}

export type VerifyOtpParams =
  | { type: "email"; email: string; token: string }
  | { type: "magiclink"; token_hash: string };

export function validateOtpOptions(options: SignInWithOtpOptions): EmailOtpType {
  if (typeof options.email !== "string" || options.email.trim().length === 0) {
    throw new AuthError("email is required", "invalid_request");
  }
  const type = options.type ?? "magiclink";
  if (!EMAIL_OTP_TYPES.includes(type)) {
    throw new AuthError(`Unknown type "${String(type)}"`, "invalid_request");
  }
  return type;
}

/** The codes /otp and /verify answer with; any other text is not a code. */
const OTP_ERRORS = new Set([
  "method_not_enabled",
  "rate_limited",
  "invalid_or_expired_token",
  "signup_disabled",
  "account_disabled",
  "invalid_email",
]);

/** The same error, its code named by what the server said when it is a known one. */
export function namedOtpError(error: unknown): unknown {
  if (!(error instanceof AuthError) || !OTP_ERRORS.has(error.message)) return error;
  return new AuthError(error.message, error.message, error.status, error.cause);
}

/** A magic link that landed on the page: its token hash and the address without it. */
export interface LandedLink {
  tokenHash: string;
  cleaned: string;
}

export function readLandedLink(href: string): LandedLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const tokenHash = url.searchParams.get("token_hash");
  if (tokenHash == null || tokenHash.length === 0 || url.searchParams.get("type") !== "magiclink") return null;
  url.searchParams.delete("token_hash");
  url.searchParams.delete("type");
  return { tokenHash, cleaned: url.toString() };
}
