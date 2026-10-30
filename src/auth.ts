import { AuthHttp } from "./auth-http";
import { AuthError } from "./errors";
import { namedGuestError } from "./guest";
import { MfaApi, type StepUpResponse } from "./mfa";
import {
  codeChallenge,
  decodePending,
  encodePending,
  type HistoryLike,
  landedOn,
  type LocationLike,
  newCodeVerifier,
  type OAuthRedirect,
  readLandedSignIn,
  signInErrorCode,
  type SignInWithOAuthOptions,
  validateOAuthOptions,
} from "./oauth";
import {
  type LinkEmailOptions,
  type LinkIdentityOptions,
  type LinkTicket,
  namedLinkError,
  type UserIdentities,
  type UserIdentity,
} from "./identities";
import {
  type EmailOtpType,
  namedOtpError,
  readLandedLink,
  readLandedTokenHash,
  type SignInWithOtpOptions,
  validateOtpOptions,
  type VerifyOtpParams,
} from "./otp";
import type { StorageAdapter } from "./storage";
import {
  type ConfirmEmailChangeResult,
  namedUserError,
  type RawUpdateUserResponse,
  type SignOutOptions,
  type SignOutScope,
  type UpdateUserOptions,
  type UpdateUserResult,
  updateUserBody,
  type UserAttributes,
  type UserProfile,
  validateScope,
  type VerifyEmailChangeParams,
} from "./user";
import { computeExpiresAt, TokenManager } from "./token-manager";
import type {
  APIKeyInfo,
  AuthChangeEvent,
  AuthChangeHandler,
  CreateAPIKeyResult,
  RawAuthResponse,
  Session,
  Subscription,
  User,
} from "./types";

export interface SignInAsGuestOptions {
  /** A Cloudflare Turnstile token, needed when the project requires one. */
  captchaToken?: string;
}

export interface SignInWithPasswordCredentials {
  email: string;
  password: string;
}

export interface SignUpCredentials {
  email: string;
  password: string;
  fullName: string;
}

export interface VerifyEmailResult {
  verified: boolean;
  /** The link proved only the address, so the stored password was disabled and a reset email was sent. */
  passwordResetRequired: boolean;
}

export interface UpdatePasswordWithTokenInput {
  token: string;
  password: string;
}

export interface AuthClientOptions {
  client: AuthClientHost;
  storage: StorageAdapter;
  storageKey: string;
  autoRefreshToken: boolean;
  fetch: typeof fetch;
  /** Finish a provider sign-in found on the page's address during hydrate(). */
  detectSessionInUrl?: boolean;
  location?: LocationLike;
  history?: HistoryLike;
}

/**
 * Minimal DbClient surface the AuthClient needs — kept narrow so the two
 * files don't form an import cycle for type checking.
 */
export interface AuthClientHost {
  authEndpoint(subpath: string): string;
  readonly publishableKey: string;
}

export class AuthClient {
  private readonly host: AuthClientHost;
  private readonly storage: StorageAdapter;
  private readonly storageKey: string;
  private readonly http: AuthHttp;
  private readonly listeners = new Set<AuthChangeHandler>();
  private readonly tokenManager: TokenManager;
  private session: Session | null = null;
  /** Changes whenever the stored tokens change, so a request can tell its session was replaced meanwhile. */
  private sessionGeneration = 0;
  /** Requests that spend the refresh token run one at a time, each storing its result before the next starts. */
  private tokenLane: Promise<unknown> = Promise.resolve();
  private hydrated = false;
  private readonly detectSessionInUrl: boolean;
  private readonly location?: LocationLike;
  private readonly history?: HistoryLike;
  /** TOTP factors and recovery codes of the signed-in account. */
  readonly mfa: MfaApi;

  constructor(opts: AuthClientOptions) {
    this.host = opts.client;
    this.storage = opts.storage;
    this.storageKey = opts.storageKey;
    this.http = new AuthHttp({
      fetch: opts.fetch,
      publishableKey: () => this.host.publishableKey,
      accessToken: () => this.session?.accessToken ?? null,
    });
    this.detectSessionInUrl = opts.detectSessionInUrl ?? true;
    this.location = opts.location;
    this.history = opts.history;
    this.tokenManager = new TokenManager({
      session: null,
      refresh: () => this.refreshAndInstall("TOKEN_REFRESHED"),
    });
    if (opts.autoRefreshToken) {
      this.tokenManager.start();
    }
    this.mfa = new MfaApi({
      http: this.http,
      endpoint: (path) => this.host.authEndpoint(path),
      session: () => this.session,
      stepUp: (send) => this.stepUp(send),
    });
  }

  currentSession(): Session | null {
    return this.session;
  }

  user(): User | null {
    return this.session?.user ?? null;
  }

  async hydrate(): Promise<Session | null> {
    if (this.hydrated) return this.session;
    this.hydrated = true;
    try {
      const raw = await Promise.resolve(this.storage.getItem(this.storageKey));
      if (raw != null && raw.length > 0) {
        const parsed = JSON.parse(raw) as Session;
        if (typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number") {
          const session = { ...parsed, user: endUser(parsed.user) };
          this.session = session;
          this.tokenManager.setSession(session);
        }
      }
    } catch {
      // Ignore malformed storage — treat as no session.
    }
    if (this.detectSessionInUrl) {
      await this.finishLandedSignIn();
      await this.finishLandedLink();
      await this.finishLandedEmailChange();
    }
    return this.session;
  }

  /**
   * Starts a sign-in with Google or GitHub: keeps a PKCE verifier in storage
   * and sends the browser to auth, which returns it to `redirectTo?code=…`.
   */
  async signInWithOAuth(options: SignInWithOAuthOptions): Promise<OAuthRedirect> {
    validateOAuthOptions(options);
    const verifier = newCodeVerifier();
    const challenge = await codeChallenge(verifier);
    const pending = encodePending({ verifier, redirectTo: options.redirectTo, startedAt: Date.now() });
    await Promise.resolve(this.storage.setItem(this.verifierKey, pending));
    const query = new URLSearchParams({
      provider: options.provider,
      redirect_to: options.redirectTo,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const url = `${this.host.authEndpoint("/authorize")}?${query.toString()}`;
    if (options.skipBrowserRedirect !== true) {
      this.location?.assign(url);
    }
    return { provider: options.provider, url };
  }

  /** Redeems the code a provider sign-in returned, with the verifier this browser kept. */
  async exchangeCodeForSession(code: string): Promise<Session> {
    const pending = decodePending(await Promise.resolve(this.storage.getItem(this.verifierKey)), Date.now());
    await Promise.resolve(this.storage.removeItem(this.verifierKey));
    if (pending == null) {
      throw new AuthError("No sign-in was started in this browser, or it expired", "pkce_verifier_missing");
    }
    const body = { grant_type: "pkce", auth_code: code, code_verifier: pending.verifier };
    let raw: RawAuthResponse;
    try {
      raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/token"), body);
    } catch (error) {
      throw namedLinkError(error);
    }
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  private get verifierKey(): string {
    return `${this.storageKey}-code-verifier`;
  }

  private get otpVerifierKey(): string {
    return `${this.storageKey}-otp-verifier`;
  }

  /**
   * Emails a sign-in link or eight-digit code. Resolves the same way whether or not the account exists; the
   * link or code then works only in this browser, which keeps the PKCE verifier.
   */
  async signInWithOtp(options: SignInWithOtpOptions): Promise<void> {
    const type = validateOtpOptions(options);
    try {
      await this.requestEmail("/otp", options, type, { create_user: options.shouldCreateUser ?? true });
    } catch (error) {
      throw namedOtpError(error);
    }
  }

  /** Keeps a PKCE verifier for /verify and asks auth to mail a link or code. */
  private async requestEmail(
    path: string,
    options: { email: string; emailRedirectTo?: string },
    type: EmailOtpType,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const verifier = newCodeVerifier();
    const challenge = await codeChallenge(verifier);
    const redirectTo = type === "magiclink" ? (options.emailRedirectTo ?? "") : "";
    const body: Record<string, unknown> = {
      email: options.email.trim(),
      type,
      ...extra,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    if (redirectTo !== "") body.redirect_to = redirectTo;
    await Promise.resolve(this.storage.setItem(this.otpVerifierKey, encodePending({ verifier, redirectTo, startedAt: Date.now() })));
    await this.http.post(this.host.authEndpoint(path), body);
  }

  /**
   * Links Google or GitHub to the signed-in account. The browser goes through the provider and lands on
   * `redirectTo?code=…`; the link is written when `hydrate()` or `exchangeCodeForSession` redeems that code with
   * the verifier kept here. Needs a recent sign-in (`reauthentication_required` otherwise).
   */
  async linkIdentity(options: LinkIdentityOptions): Promise<OAuthRedirect> {
    validateOAuthOptions(options);
    this.requireSession();
    await this.freshenGuest();
    const verifier = newCodeVerifier();
    const challenge = await codeChallenge(verifier);
    let ticket: LinkTicket;
    try {
      ticket = await this.http.post<LinkTicket>(this.host.authEndpoint("/user/identities/authorize"), {
        provider: options.provider,
        redirect_to: options.redirectTo,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
    } catch (error) {
      throw namedLinkError(error);
    }
    const pending = encodePending({ verifier, redirectTo: options.redirectTo, startedAt: Date.now() });
    await Promise.resolve(this.storage.setItem(this.verifierKey, pending));
    const url = `${this.host.authEndpoint("/authorize")}?${new URLSearchParams({ link_ticket: ticket.linkTicket }).toString()}`;
    if (options.skipBrowserRedirect !== true) {
      this.location?.assign(url);
    }
    return { provider: options.provider, url };
  }

  /**
   * Emails a link or code proving another address; `verifyOtp` (or `hydrate()` for a link) spends it in this
   * browser and links the address to the signed-in account. Needs a recent sign-in.
   */
  async linkEmail(options: LinkEmailOptions): Promise<void> {
    const type = validateOtpOptions(options);
    this.requireSession();
    await this.freshenGuest();
    try {
      await this.requestEmail("/user/identities/email", options, type, {});
    } catch (error) {
      throw namedLinkError(error);
    }
  }

  /** The signed-in account's linked identities, and whether it has a password. */
  async getUserIdentities(): Promise<UserIdentities> {
    this.requireSession();
    try {
      return await this.http.get<UserIdentities>(this.host.authEndpoint("/user/identities"));
    } catch (error) {
      throw namedLinkError(error);
    }
  }

  /** Unlinks an identity; refused (`last_sign_in_method`) when it is the last way in. Needs a recent sign-in. */
  async unlinkIdentity(identity: UserIdentity | number): Promise<void> {
    this.requireSession();
    const id = typeof identity === "number" ? identity : identity.id;
    try {
      await this.http.delete(this.host.authEndpoint(`/user/identities/${encodeURIComponent(String(id))}`));
    } catch (error) {
      throw namedLinkError(error);
    }
  }

  private requireSession(): Session {
    if (this.session?.accessToken == null) {
      throw new AuthError("Sign in first", "not_signed_in");
    }
    return this.session;
  }

  /**
   * Spends a code typed by the user, or a link's token hash, with the verifier this browser kept, and signs in.
   * A wrong code keeps the verifier for another try; a link is spent by its first try.
   */
  async verifyOtp(params: VerifyEmailChangeParams): Promise<ConfirmEmailChangeResult>;
  async verifyOtp(params: VerifyOtpParams): Promise<Session>;
  async verifyOtp(params: VerifyOtpParams | VerifyEmailChangeParams): Promise<Session | ConfirmEmailChangeResult> {
    if (params.type === "email_change") return this.confirmEmailChange({ tokenHash: params.token_hash });
    const pending = decodePending(await Promise.resolve(this.storage.getItem(this.otpVerifierKey)), Date.now());
    if (pending == null) {
      await Promise.resolve(this.storage.removeItem(this.otpVerifierKey));
      throw new AuthError("No sign-in email was asked for in this browser, or it expired", "pkce_verifier_missing");
    }
    const body =
      params.type === "email"
        ? { type: "email", email: params.email, token: params.token, code_verifier: pending.verifier }
        : { type: "magiclink", token_hash: params.token_hash, code_verifier: pending.verifier };
    let raw: RawAuthResponse;
    try {
      raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/verify"), body);
    } catch (error) {
      if (params.type === "magiclink") await Promise.resolve(this.storage.removeItem(this.otpVerifierKey));
      throw namedLinkError(namedOtpError(error));
    }
    await Promise.resolve(this.storage.removeItem(this.otpVerifierKey));
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  /** Only a link this browser asked for, on the page it was sent to, is spent. */
  private async finishLandedLink(): Promise<void> {
    const landed = this.location == null ? null : readLandedLink(this.location.href);
    if (landed == null) return;
    const pending = decodePending(await Promise.resolve(this.storage.getItem(this.otpVerifierKey)), Date.now());
    if (pending == null) {
      // Useless without a verifier this browser never kept; keep it out of history and referrers.
      this.history?.replaceState(null, "", landed.cleaned);
      return;
    }
    if (pending.redirectTo !== "" && !landedOn(this.location!.href, pending.redirectTo)) return;
    this.history?.replaceState(null, "", landed.cleaned);
    await this.verifyOtp({ type: "magiclink", token_hash: landed.tokenHash });
  }

  /**
   * Confirmed only for a signed-in browser; otherwise the link stays on the page for the app to confirm after
   * sign-in. A refusal is reported as EMAIL_CHANGE_FAILED, never thrown, so a crafted link cannot break start-up.
   */
  private async finishLandedEmailChange(): Promise<void> {
    const landed = this.location == null ? null : readLandedTokenHash(this.location.href, "email_change");
    if (landed == null || this.session?.accessToken == null) return;
    this.history?.replaceState(null, "", landed.cleaned);
    try {
      await this.confirmEmailChange({ tokenHash: landed.tokenHash });
    } catch (error) {
      this.emit("EMAIL_CHANGE_FAILED", this.session, error);
    }
  }

  /** Only a sign-in this browser started is finished; any other ?code= is the app's own. */
  private async finishLandedSignIn(): Promise<void> {
    const landed = this.location == null ? null : readLandedSignIn(this.location.href);
    if (landed == null) return;
    const pending = decodePending(await Promise.resolve(this.storage.getItem(this.verifierKey)), Date.now());
    if (pending == null || !landedOn(this.location!.href, pending.redirectTo)) return;
    this.history?.replaceState(null, "", landed.cleaned);
    if (landed.error != null || landed.code == null) {
      await Promise.resolve(this.storage.removeItem(this.verifierKey));
      const code = signInErrorCode(landed.error);
      throw new AuthError(`Sign-in failed: ${code}`, code);
    }
    await this.exchangeCodeForSession(landed.code);
  }

  onAuthStateChange(handler: AuthChangeHandler): Subscription {
    this.listeners.add(handler);
    // Fire the initial state so the caller doesn't have to probe `currentSession`.
    // Defer via microtask to avoid re-entrancy during subscribe().
    queueMicrotask(() => {
      if (this.listeners.has(handler)) {
        handler(this.session == null ? "SIGNED_OUT" : "SIGNED_IN", this.session);
      }
    });
    return {
      unsubscribe: () => {
        this.listeners.delete(handler);
      },
    };
  }

  async signUp(credentials: SignUpCredentials): Promise<Session> {
    const body = {
      email: credentials.email,
      password: credentials.password,
      fullName: credentials.fullName,
    };
    const raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/register"), body);
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  /**
   * Starts a session for a new guest account: no address or password, role `guest`. The guest keeps its id when it
   * later adds an address (`updateUser({ email })`) or a provider (`linkIdentity`). Send `captchaToken` when the
   * project requires Cloudflare Turnstile.
   */
  async signInAsGuest(options: SignInAsGuestOptions = {}): Promise<Session> {
    const body = options.captchaToken == null ? {} : { captchaToken: options.captchaToken };
    let raw: RawAuthResponse;
    try {
      raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/guest"), body);
    } catch (error) {
      throw namedGuestError(error);
    }
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  /**
   * A guest has nothing to sign in again with, so auth takes a token issued in the last few minutes as a recent
   * sign-in; refresh first so an address, password or link request is accepted.
   */
  private async freshenGuest(): Promise<void> {
    if (this.session?.user?.isGuest !== true) return;
    try {
      await this.refreshAndInstall("TOKEN_REFRESHED");
    } catch (error) {
      throw namedGuestError(error);
    }
  }

  async signInWithPassword(credentials: SignInWithPasswordCredentials): Promise<Session> {
    const body = {
      grant_type: "password",
      email: credentials.email,
      password: credentials.password,
    };
    const raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/token"), body);
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  async signInWithApiKey(apiKey?: string): Promise<Session> {
    const key = apiKey ?? this.host.publishableKey;
    const body = { grant_type: "api_key", api_key: key };
    const raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/token"), body);
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  /**
   * `local` (the default) revokes this session's refresh token, ignoring a failure, and clears it here. `global`
   * ends every session of the user and clears this one even when the server refuses, then rethrows. `others`
   * ends every other session and keeps this one.
   */
  async signOut(options: SignOutOptions = {}): Promise<void> {
    const scope = validateScope(options.scope ?? "local");
    if (scope !== "local") return this.signOutEverywhere(scope);
    const refreshToken = this.session?.refreshToken;
    if (refreshToken != null && refreshToken.length > 0) {
      try {
        await this.http.post(this.host.authEndpoint("/logout"), { refreshToken });
      } catch {
        // Swallow logout errors — the local session is removed regardless,
        // and the refresh token will be cleaned up server-side on expiry.
      }
    }
    this.installSession(null, "SIGNED_OUT", { persist: true });
  }

  private async signOutEverywhere(scope: Exclude<SignOutScope, "local">): Promise<void> {
    this.requireSession();
    const url = `${this.host.authEndpoint("/logout")}?scope=${scope}`;
    const refreshToken = this.session?.refreshToken ?? null;
    try {
      await this.http.post(url, { refreshToken });
    } catch (error) {
      if (scope === "global") await this.revokeQuietly(refreshToken);
      throw namedUserError(error);
    } finally {
      if (scope === "global") this.installSession(null, "SIGNED_OUT", { persist: true });
    }
  }

  /** Revokes this session's refresh token; a failure is ignored since the session is cleared regardless. */
  private async revokeQuietly(refreshToken: string | null): Promise<void> {
    if (refreshToken == null || refreshToken.length === 0) return;
    try {
      await this.http.post(this.host.authEndpoint("/logout"), { refreshToken });
    } catch {
      // The token still expires server-side.
    }
  }

  /** The signed-in account, with its metadata. */
  async getUser(): Promise<UserProfile> {
    this.requireSession();
    try {
      return await this.http.get<UserProfile>(this.host.authEndpoint("/user"));
    } catch (error) {
      throw namedUserError(error);
    }
  }

  /**
   * Changes the signed-in account. A password or address change needs a sign-in in the last 5 minutes (or, for a
   * password, `currentPassword`); app metadata is written only by a secret key or Studio.
   */
  async updateUser(attributes: UserAttributes, options: UpdateUserOptions = {}): Promise<UpdateUserResult> {
    const body = updateUserBody(attributes, options);
    this.requireSession();
    if (attributes.email != null || attributes.password != null) await this.freshenGuest();
    let raw: RawUpdateUserResponse;
    try {
      raw = await this.http.request<RawUpdateUserResponse>("PATCH", this.host.authEndpoint("/user"), body);
    } catch (error) {
      throw namedUserError(error);
    }
    if (raw.session != null) {
      this.installSession(this.sessionFromResponse(raw.session), "TOKEN_REFRESHED", { persist: true });
    } else if (this.session != null) {
      const { id, email, fullName } = raw.user;
      const user = raw.user.isGuest === true ? { id, email, fullName, isGuest: true } : { id, email, fullName };
      this.installSession({ ...this.session, user }, "USER_UPDATED", { persist: true });
    }
    return { user: raw.user, emailChangeRequested: raw.emailChangeRequested === true };
  }

  /**
   * Confirms a new address with the link's token hash. Needs the session of the account that asked for the change;
   * it is refreshed afterwards so the new address shows.
   */
  async confirmEmailChange(input: { tokenHash: string }): Promise<ConfirmEmailChangeResult> {
    requireValue(input.tokenHash, "tokenHash is required");
    this.requireSession();
    try {
      await this.http.post(this.host.authEndpoint("/user/email/confirm"), { token_hash: input.tokenHash });
    } catch (error) {
      throw namedUserError(error);
    }
    const refreshed = await this.refreshAndInstall("USER_UPDATED");
    return { user: refreshed?.user ?? null };
  }

  /**
   * Rotates the current session. Prefers refresh_token grant when a refresh
   * token is present (password login path); falls back to api_key re-exchange
   * (SDK was bootstrapped anonymously or with an api-key-derived session).
   */
  refresh(): Promise<Session | null> {
    return this.inTokenLane(() => this.requestRefresh());
  }

  /** Refreshes and stores the result, unless the session was replaced (sign-out, step-up) while it was asked for. */
  private refreshAndInstall(event: AuthChangeEvent): Promise<Session | null> {
    return this.inTokenLane(async () => {
      const generation = this.sessionGeneration;
      const next = await this.requestRefresh();
      if (generation !== this.sessionGeneration) return this.session;
      if (next != null) this.installSession(next, event, { persist: true });
      return next;
    });
  }

  /**
   * Presents the stored refresh token to a step-up route and stores the aal2 session it returns. Retries once when
   * the token was rotated by something else meanwhile; refuses to store a result for a session that is gone.
   */
  private stepUp<T extends StepUpResponse>(send: (refreshToken: string) => Promise<T>): Promise<{ session: Session; response: T }> {
    return this.inTokenLane(async () => {
      let attempt = this.stepUpAttempt();
      let response: T;
      try {
        response = await send(attempt.refreshToken);
      } catch (error) {
        const retry = isRefusedRefreshToken(error) ? this.stepUpRetry(attempt) : null;
        if (retry == null) throw error;
        attempt = retry;
        response = await send(attempt.refreshToken);
      }
      if (attempt.generation !== this.sessionGeneration) {
        throw new AuthError("The session changed while this was in flight", "session_changed");
      }
      const session = this.sessionFromResponse(response);
      this.installSession(session, "MFA_CHALLENGE_VERIFIED", { persist: true });
      return { session, response };
    });
  }

  private stepUpAttempt(): { refreshToken: string; generation: number; userId: number | null } {
    const refreshToken = this.session?.refreshToken;
    if (this.session?.accessToken == null || refreshToken == null || refreshToken.length === 0) {
      throw new AuthError("Sign in with an account first", "not_signed_in");
    }
    return { refreshToken, generation: this.sessionGeneration, userId: this.session.user?.id ?? null };
  }

  /** Only the same account's session, holding a different refresh token, is worth one more try. */
  private stepUpRetry(previous: { refreshToken: string; userId: number | null }): ReturnType<AuthClient["stepUpAttempt"]> | null {
    const current = this.session;
    if (current?.refreshToken == null || current.refreshToken === previous.refreshToken) return null;
    if ((current.user?.id ?? null) !== previous.userId) return null;
    return this.stepUpAttempt();
  }

  private inTokenLane<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tokenLane.then(task, task);
    this.tokenLane = run.catch(() => undefined);
    return run;
  }

  private async requestRefresh(): Promise<Session | null> {
    const refreshToken = this.session?.refreshToken;
    if (refreshToken != null && refreshToken.length > 0) {
      const body = { grant_type: "refresh_token", refresh_token: refreshToken };
      const raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/token"), body);
      return this.sessionFromResponse(raw);
    }
    // No refresh token — this path handles the api-key flow (no refresh
    // tokens issued) and the anonymous-publishable-key bootstrap.
    if (this.host.publishableKey.startsWith("esk_")) {
      const body = { grant_type: "api_key", api_key: this.host.publishableKey };
      const raw = await this.http.post<RawAuthResponse>(this.host.authEndpoint("/token"), body);
      return this.sessionFromResponse(raw);
    }
    return null;
  }

  /** Redeems the token from a verification email. The server ends every session the account had. */
  async verifyEmail(input: { token: string }): Promise<VerifyEmailResult> {
    requireValue(input.token, "token is required");
    const raw = await this.http.post<{ verified?: boolean; passwordResetRequired?: boolean }>(
      this.host.authEndpoint("/verify-email"),
      { token: input.token },
    );
    return { verified: raw.verified === true, passwordResetRequired: raw.passwordResetRequired === true };
  }

  /** Asks for a new verification email. Resolves the same way whether or not the account exists. */
  async resendVerification(input: { email: string }): Promise<void> {
    requireValue(input.email, "email is required");
    await this.http.post(this.host.authEndpoint("/resend-verification"), { email: input.email });
  }

  /** Asks for a password reset email. Resolves the same way whether or not the account exists. */
  async resetPasswordForEmail(email: string): Promise<void> {
    requireValue(email, "email is required");
    await this.http.post(this.host.authEndpoint("/forgot-password"), { email });
  }

  /** Sets a new password with the token from a reset email. The server ends every session the account had. */
  async updatePasswordWithToken(input: UpdatePasswordWithTokenInput): Promise<void> {
    requireValue(input.token, "token is required");
    requireValue(input.password, "password is required");
    await this.http.post(this.host.authEndpoint("/reset-password"), {
      token: input.token,
      newPassword: input.password,
    });
  }

  async createApiKey(input: { name: string; keyType: "publishable" | "secret" }): Promise<CreateAPIKeyResult> {
    return this.http.post<CreateAPIKeyResult>(this.host.authEndpoint("/api-keys/"), input);
  }

  async listApiKeys(): Promise<APIKeyInfo[]> {
    const response = await this.http.get<{ keys: APIKeyInfo[] }>(this.host.authEndpoint("/api-keys/"));
    return response.keys ?? [];
  }

  async revokeApiKey(id: number): Promise<void> {
    await this.http.delete(this.host.authEndpoint(`/api-keys/${id}`));
  }

  stopAutoRefresh(): void {
    this.tokenManager.stop();
  }

  private sessionFromResponse(raw: RawAuthResponse): Session {
    return {
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken ?? null,
      tokenType: raw.tokenType ?? "Bearer",
      expiresAt: computeExpiresAt(raw.expiresIn ?? 0),
      user: endUser(raw.user),
    };
  }

  private installSession(
    session: Session | null,
    event: AuthChangeEvent,
    opts: { persist: boolean },
  ): void {
    if (session?.accessToken !== this.session?.accessToken || session?.refreshToken !== this.session?.refreshToken) {
      this.sessionGeneration += 1;
    }
    this.session = session;
    this.tokenManager.setSession(session);
    if (opts.persist) {
      void this.persistSession(session);
    }
    this.emit(event, session);
  }

  private emit(event: AuthChangeEvent, session: Session | null, error?: unknown): void {
    for (const listener of this.listeners) {
      try {
        if (error === undefined) listener(event, session);
        else listener(event, session, error);
      } catch {
        // Listener failures must not break the auth flow.
      }
    }
  }

  private async persistSession(session: Session | null): Promise<void> {
    try {
      if (session == null) {
        await Promise.resolve(this.storage.removeItem(this.storageKey));
      } else {
        await Promise.resolve(this.storage.setItem(this.storageKey, JSON.stringify(session)));
      }
    } catch {
      // Storage failures shouldn't crash the caller — session is still in memory.
    }
  }
}

function isRefusedRefreshToken(error: unknown): boolean {
  return error instanceof AuthError && error.status === 401 && error.message === "invalid refresh token";
}

function requireValue(value: string | undefined, message: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthError(message, "invalid_request");
  }
}

/**
 * The signed-in end user, or null. An api-key (anonymous) session has no user; older auth servers sent a
 * placeholder `{ id: 0 }` for it, which must not read as someone signed in (EXC-607).
 */
function endUser(user: User | null | undefined): User | null {
  return user != null && typeof user.id === "number" && user.id > 0 ? user : null;
}
