import type { AuthHttp } from "./auth-http";
import { AuthError } from "./errors";
import type { RawAuthResponse, Session } from "./types";

export type AuthenticatorAssuranceLevel = "aal1" | "aal2";
export type FactorStatus = "unverified" | "verified";

export interface Factor {
  id: string;
  factorType: "totp";
  friendlyName: string;
  status: FactorStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MfaEnrollParams {
  factorType: "totp";
  friendlyName?: string;
  /** The name an authenticator app shows above the code. */
  issuer?: string;
}

export interface MfaEnrollResult {
  id: string;
  factorType: "totp";
  friendlyName: string;
  status: FactorStatus;
  /** Shown once: `uri` goes into a QR code, `secret` is for typing in by hand. */
  totp: { secret: string; uri: string };
}

export interface MfaChallengeParams {
  factorId: string;
}

export interface MfaChallenge {
  id: string;
  expiresAt: string;
}

export interface MfaVerifyParams {
  factorId: string;
  challengeId: string;
  code: string;
}

export interface MfaChallengeAndVerifyParams {
  factorId: string;
  code: string;
}

export interface MfaVerifyResult {
  session: Session;
  /** Only when this is the account's first verified factor; shown once. */
  recoveryCodes?: string[];
}

export interface MfaUnenrollParams {
  factorId: string;
}

export interface MfaListFactorsResult {
  all: Factor[];
  /** Verified TOTP factors only: the ones a challenge can use. */
  totp: Factor[];
  recoveryCodesRemaining: number;
}

export interface MfaAssuranceLevel {
  /** From the access token; null when signed out or the token carries no level (MFA off). */
  currentLevel: AuthenticatorAssuranceLevel | null;
  /** `aal2` when the account has a verified factor, else the current level. */
  nextLevel: AuthenticatorAssuranceLevel | null;
  /** The token's `amr`: first factor, then second, e.g. `["password", "totp"]`. */
  currentAuthenticationMethods: string[];
}

export interface MfaUseRecoveryCodeParams {
  code: string;
}

export interface MfaRecoveryCodes {
  recoveryCodes: string[];
}

/** What the MFA calls need from the AuthClient. */
export interface MfaHost {
  http: AuthHttp;
  endpoint(path: string): string;
  session(): Session | null;
  /** Stores the session the server returned and announces it the way a sign-in does. */
  signIn(raw: RawAuthResponse): Session;
}

/** The codes the factor routes answer with; any other text is not a code. */
const MFA_ERRORS = new Set([
  "method_not_enabled",
  "insufficient_aal",
  "invalid_code",
  "invalid_challenge",
  "too_many_attempts",
  "email_required",
  "invalid_request",
]);

function namedMfaError(error: unknown): unknown {
  if (!(error instanceof AuthError) || !MFA_ERRORS.has(error.message)) return error;
  return new AuthError(error.message, error.message, error.status, error.cause);
}

/** TOTP factors and recovery codes of the signed-in account (`client.auth.mfa`). */
export class MfaApi {
  constructor(private readonly host: MfaHost) {}

  /** Adds an unverified TOTP factor; it counts once `verify` accepts a code from it. */
  enroll(params: MfaEnrollParams): Promise<MfaEnrollResult> {
    const body: Record<string, string> = { factorType: params.factorType };
    if (params.friendlyName != null) body.friendlyName = params.friendlyName;
    if (params.issuer != null) body.issuer = params.issuer;
    return this.call(() => this.host.http.post<MfaEnrollResult>(this.host.endpoint("/factors"), body));
  }

  /** Starts a five-minute challenge for a factor. */
  challenge(params: MfaChallengeParams): Promise<MfaChallenge> {
    return this.call(() => this.host.http.post<MfaChallenge>(this.factorUrl(params.factorId, "/challenge"), {}));
  }

  /** Checks a code; on success this session is rotated to aal2 and stored like a sign-in. */
  async verify(params: MfaVerifyParams): Promise<MfaVerifyResult> {
    const refreshToken = this.refreshToken();
    const body = { challengeId: params.challengeId, code: params.code, refreshToken };
    const raw = await this.call(() =>
      this.host.http.post<RawAuthResponse & { recoveryCodes?: string[] }>(this.factorUrl(params.factorId, "/verify"), body),
    );
    const session = this.host.signIn(raw);
    return raw.recoveryCodes == null ? { session } : { session, recoveryCodes: raw.recoveryCodes };
  }

  async challengeAndVerify(params: MfaChallengeAndVerifyParams): Promise<MfaVerifyResult> {
    const started = await this.challenge({ factorId: params.factorId });
    return this.verify({ factorId: params.factorId, challengeId: started.id, code: params.code });
  }

  /** Removes a factor; removing the last verified one also deletes the recovery codes. */
  async unenroll(params: MfaUnenrollParams): Promise<void> {
    await this.call(() => this.host.http.delete(this.factorUrl(params.factorId, "")));
  }

  async listFactors(): Promise<MfaListFactorsResult> {
    const raw = await this.call(() =>
      this.host.http.get<{ factors?: Factor[]; recoveryCodesRemaining?: number }>(this.host.endpoint("/factors")),
    );
    const all = raw.factors ?? [];
    return {
      all,
      totp: all.filter((factor) => factor.factorType === "totp" && factor.status === "verified"),
      recoveryCodesRemaining: raw.recoveryCodesRemaining ?? 0,
    };
  }

  /**
   * The current level comes from the access token, unverified (the server checks it). The factor list is asked
   * for only when the token carries a level and the account is not a guest.
   */
  async getAuthenticatorAssuranceLevel(): Promise<MfaAssuranceLevel> {
    const session = this.host.session();
    if (session?.accessToken == null) return { currentLevel: null, nextLevel: null, currentAuthenticationMethods: [] };
    const claims = readClaims(session.accessToken);
    const currentLevel = claims.aal === "aal1" || claims.aal === "aal2" ? claims.aal : null;
    const currentAuthenticationMethods = currentLevel == null ? [] : methodsOf(claims.amr);
    if (currentLevel == null || session.user?.isGuest === true) {
      return { currentLevel, nextLevel: currentLevel, currentAuthenticationMethods };
    }
    const { totp } = await this.listFactors();
    return { currentLevel, nextLevel: totp.length > 0 ? "aal2" : currentLevel, currentAuthenticationMethods };
  }

  /** Spends a single-use recovery code in place of a TOTP code; the aal2 session is stored like a sign-in. */
  async useRecoveryCode(params: MfaUseRecoveryCodeParams): Promise<Session> {
    const body = { code: params.code, refreshToken: this.refreshToken() };
    const raw = await this.call(() => this.host.http.post<RawAuthResponse>(this.host.endpoint("/factors/recovery"), body));
    return this.host.signIn(raw);
  }

  /** Replaces every recovery code with a new set, shown once. Needs aal2. */
  regenerateRecoveryCodes(): Promise<MfaRecoveryCodes> {
    return this.call(() => this.host.http.post<MfaRecoveryCodes>(this.host.endpoint("/factors/recovery-codes"), {}));
  }

  private factorUrl(factorId: string, suffix: string): string {
    return this.host.endpoint(`/factors/${encodeURIComponent(factorId)}${suffix}`);
  }

  private refreshToken(): string {
    const refreshToken = this.requireSession().refreshToken;
    if (refreshToken == null || refreshToken.length === 0) {
      throw new AuthError("This session cannot be stepped up; sign in with an account first", "not_signed_in");
    }
    return refreshToken;
  }

  private requireSession(): Session {
    const session = this.host.session();
    if (session?.accessToken == null) throw new AuthError("Sign in first", "not_signed_in");
    return session;
  }

  private async call<T>(send: () => Promise<T>): Promise<T> {
    this.requireSession();
    try {
      return await send();
    } catch (error) {
      throw namedMfaError(error);
    }
  }
}

function readClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload == null) return {};
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return claims != null && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function methodsOf(amr: unknown): string[] {
  return Array.isArray(amr) ? amr.filter((method): method is string => typeof method === "string") : [];
}
