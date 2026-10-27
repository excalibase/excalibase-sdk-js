import { AuthError } from "./errors";
import type { OAuthProvider } from "./oauth";
import type { EmailOtpType } from "./otp";

/** One way the signed-in account signs in besides its own address: a provider, or another address. */
export interface UserIdentity {
  id: number;
  provider: OAuthProvider | "email";
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface UserIdentities {
  identities: UserIdentity[];
  /** Whether the account also signs in with a password. */
  hasPassword: boolean;
}

export interface LinkIdentityOptions {
  provider: OAuthProvider;
  /** Where the browser lands after the provider: the site URL or one of the project's redirect URLs. */
  redirectTo: string;
  /** Return the URL instead of navigating to it. */
  skipBrowserRedirect?: boolean;
}

export interface LinkEmailOptions {
  email: string;
  /** Defaults to `magiclink`. */
  type?: EmailOtpType;
  /** Where a link lands: the site URL (the default) or one of the project's redirect URLs. */
  emailRedirectTo?: string;
}

export interface LinkTicket {
  linkTicket: string;
  expiresIn: number;
}

/** The codes the identity routes answer with; any other text is not a code. */
const LINK_ERRORS = new Set([
  "reauthentication_required",
  "identity_already_exists",
  "last_sign_in_method",
  "identity_not_found",
  "method_not_enabled",
  "email_not_verified",
  "account_disabled",
  "rate_limited",
  "invalid_email",
]);

/** The same error, its code named by what the server said when it is a known one. */
export function namedLinkError(error: unknown): unknown {
  if (!(error instanceof AuthError) || !LINK_ERRORS.has(error.message)) return error;
  return new AuthError(error.message, error.message, error.status, error.cause);
}
