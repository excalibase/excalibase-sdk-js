import { AuthError } from "./errors";
import type { RawAuthResponse, User } from "./types";

/** The signed-in account as `GET /user` reads it. */
export interface UserProfile extends User {
  emailVerified: boolean;
  hasPassword: boolean;
  /** Written by the user through `updateUser({ data })`. */
  userMetadata: Record<string, unknown>;
  /** Written only by a secret key or Studio; read-only here. */
  appMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface UserAttributes {
  fullName?: string;
  /**
   * Merged into the user's metadata: each top-level key replaces the stored one, and a key set to `null` is
   * removed. At most 16 KB as compact JSON and 8 levels deep.
   */
  data?: Record<string, unknown>;
  /**
   * Mails a confirmation link to the new address; the address changes only when it is confirmed. Not together
   * with `password` (`password_and_email_separately`).
   */
  email?: string;
  /** Ends every session of the account; the fresh one returned becomes the current session. */
  password?: string;
  /** Proves the user when the last sign-in is older than 5 minutes. */
  currentPassword?: string;
}

export interface UpdateUserOptions {
  /** Where the email change link lands: the site URL (the default) or one of the project's redirect URLs. */
  emailRedirectTo?: string;
}

export interface UpdateUserResult {
  user: UserProfile;
  /** A confirmation link was mailed to the new address. */
  emailChangeRequested: boolean;
}

export interface RawUpdateUserResponse {
  user: UserProfile;
  emailChangeRequested?: boolean;
  session?: RawAuthResponse;
}

/** `local` ends this session, `global` every session of the user, `others` all but this one. */
export type SignOutScope = "local" | "global" | "others";

export interface SignOutOptions {
  /** Defaults to `local`. */
  scope?: SignOutScope;
}

export interface VerifyEmailChangeParams {
  type: "email_change";
  token_hash: string;
}

export interface ConfirmEmailChangeResult {
  /** The refreshed session's user, or null when the session has no refresh token to refresh with. */
  user: User | null;
}

const SIGN_OUT_SCOPES: readonly SignOutScope[] = ["local", "global", "others"];

const ATTRIBUTE_KEYS: readonly (keyof UserAttributes)[] = ["fullName", "data", "email", "password", "currentPassword"];

export function validateScope(scope: SignOutScope): SignOutScope {
  if (!SIGN_OUT_SCOPES.includes(scope)) {
    throw new AuthError(`Unknown sign-out scope "${String(scope)}"`, "invalid_scope");
  }
  return scope;
}

/** The PATCH /user body: only the fields given; app metadata is never sent from a client. */
export function updateUserBody(attributes: UserAttributes, options: UpdateUserOptions): Record<string, unknown> {
  const unknown = Object.keys(attributes).filter((key) => !ATTRIBUTE_KEYS.includes(key as keyof UserAttributes));
  if (unknown.length > 0) {
    throw new AuthError(`updateUser does not take ${unknown.join(", ")}`, "invalid_request");
  }
  if (attributes.email !== undefined && attributes.password !== undefined) {
    throw new AuthError("Change the password and the email address in separate requests", "password_and_email_separately");
  }
  if (attributes.data !== undefined && !isPlainObject(attributes.data)) {
    throw new AuthError("data must be an object", "invalid_metadata");
  }
  const body: Record<string, unknown> = {};
  for (const key of ATTRIBUTE_KEYS) {
    if (attributes[key] !== undefined) body[key] = attributes[key];
  }
  if (options.emailRedirectTo !== undefined) body.emailRedirectTo = options.emailRedirectTo;
  return body;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** The codes the account routes answer with; any other text is not a code. */
const USER_ERRORS = new Set([
  "reauthentication_required",
  "email_not_verified",
  "invalid_metadata",
  "metadata_too_large",
  "rate_limited",
  "invalid_or_expired_token",
  "email_exists",
  "method_not_enabled",
  "invalid_scope",
  "password_and_email_separately",
  "invalid_request",
  "account_disabled",
]);

/** The same error, its code named by what the server said when it is a known one. */
export function namedUserError(error: unknown): unknown {
  if (!(error instanceof AuthError) || !USER_ERRORS.has(error.message)) return error;
  return new AuthError(error.message, error.message, error.status, error.cause);
}
