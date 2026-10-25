import { AuthError } from "./errors";

export type OAuthProvider = "google" | "github";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["google", "github"];

export interface SignInWithOAuthOptions {
  provider: OAuthProvider;
  /** Where the browser lands after the provider: the site URL or one of the project's redirect URLs. */
  redirectTo: string;
  /** Return the URL instead of navigating to it (server rendering, popups, tests). */
  skipBrowserRedirect?: boolean;
}

export interface OAuthRedirect {
  provider: OAuthProvider;
  url: string;
}

/** The page's address, as much of `window.location` as sign-in needs. */
export interface LocationLike {
  readonly href: string;
  assign(url: string): void;
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

const VERIFIER_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function webCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (crypto?.subtle == null) {
    throw new AuthError("Sign-in with a provider needs Web Crypto (browsers, Node 18+)", "pkce_unsupported");
  }
  return crypto;
}

/** A fresh PKCE verifier (RFC 7636): 43 characters of base64url. */
export function newCodeVerifier(): string {
  return base64url(webCrypto().getRandomValues(new Uint8Array(VERIFIER_BYTES)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function validateOAuthOptions(options: SignInWithOAuthOptions): void {
  if (!OAUTH_PROVIDERS.includes(options.provider)) {
    throw new AuthError(`Unknown provider "${String(options.provider)}"`, "invalid_request");
  }
  if (typeof options.redirectTo !== "string" || options.redirectTo.trim().length === 0) {
    throw new AuthError("redirectTo is required", "invalid_request");
  }
}

/** What the provider sign-in left on the page's address, if anything. */
export interface LandedSignIn {
  code: string | null;
  error: string | null;
  /** The address without code, error and state. */
  cleaned: string;
}

export function readLandedSignIn(href: string): LandedSignIn | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (code == null && error == null) return null;
  for (const key of ["code", "error", "error_description", "state"]) url.searchParams.delete(key);
  return { code, error, cleaned: url.toString() };
}

export function defaultLocation(): LocationLike | undefined {
  const location = (globalThis as { location?: LocationLike }).location;
  return location != null && typeof location.assign === "function" ? location : undefined;
}

export function defaultHistory(): HistoryLike | undefined {
  const history = (globalThis as { history?: HistoryLike }).history;
  return history != null && typeof history.replaceState === "function" ? history : undefined;
}

/** A sign-in this browser started, kept until it lands back or goes stale. */
export interface PendingSignIn {
  verifier: string;
  redirectTo: string;
  startedAt: number;
}

/** How long a started sign-in may take, as long as auth keeps its state. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60 * 1000;

export function encodePending(pending: PendingSignIn): string {
  return JSON.stringify(pending);
}

export function decodePending(raw: string | null, now: number): PendingSignIn | null {
  if (raw == null || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSignIn>;
    if (typeof parsed.verifier !== "string" || typeof parsed.redirectTo !== "string" || typeof parsed.startedAt !== "number") {
      return null;
    }
    if (now - parsed.startedAt > PENDING_SIGN_IN_TTL_MS || parsed.startedAt > now) return null;
    return parsed as PendingSignIn;
  } catch {
    return null;
  }
}

/** The page is the one the sign-in was sent back to: same origin and path. */
export function landedOn(href: string, redirectTo: string): boolean {
  try {
    const page = new URL(href);
    const target = new URL(redirectTo);
    return page.origin === target.origin && trimSlash(page.pathname) === trimSlash(target.pathname);
  } catch {
    return false;
  }
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The codes auth sends back; anything else on the address is not auth's. */
const SIGN_IN_ERRORS = new Set([
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "method_not_enabled",
  "email_not_verified",
  "signup_disabled",
  "account_disabled",
  "invalid_email",
]);

export function signInErrorCode(raw: string | null): string {
  return raw != null && SIGN_IN_ERRORS.has(raw) ? raw : "server_error";
}
