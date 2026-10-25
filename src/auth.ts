import { AuthError, CorsError, NetworkError } from "./errors";
import {
  codeChallenge,
  type HistoryLike,
  type LocationLike,
  newCodeVerifier,
  type OAuthRedirect,
  readLandedSignIn,
  type SignInWithOAuthOptions,
  validateOAuthOptions,
} from "./oauth";
import type { StorageAdapter } from "./storage";
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
  private readonly fetchImpl: typeof fetch;
  private readonly listeners = new Set<AuthChangeHandler>();
  private readonly tokenManager: TokenManager;
  private session: Session | null = null;
  private hydrated = false;
  private readonly detectSessionInUrl: boolean;
  private readonly location?: LocationLike;
  private readonly history?: HistoryLike;

  constructor(opts: AuthClientOptions) {
    this.host = opts.client;
    this.storage = opts.storage;
    this.storageKey = opts.storageKey;
    this.fetchImpl = opts.fetch;
    this.detectSessionInUrl = opts.detectSessionInUrl ?? true;
    this.location = opts.location;
    this.history = opts.history;
    this.tokenManager = new TokenManager({
      session: null,
      refresh: () => this.refresh(),
      onRefreshed: (next) => this.installSession(next, "TOKEN_REFRESHED", { persist: true }),
    });
    if (opts.autoRefreshToken) {
      this.tokenManager.start();
    }
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
    await Promise.resolve(this.storage.setItem(this.verifierKey, verifier));
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
    const verifier = await Promise.resolve(this.storage.getItem(this.verifierKey));
    if (verifier == null || verifier.length === 0) {
      throw new AuthError("No sign-in was started in this browser", "pkce_verifier_missing");
    }
    await Promise.resolve(this.storage.removeItem(this.verifierKey));
    const body = { grant_type: "pkce", auth_code: code, code_verifier: verifier };
    const raw = await this.postJSON<RawAuthResponse>(this.host.authEndpoint("/token"), body);
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  private get verifierKey(): string {
    return `${this.storageKey}-code-verifier`;
  }

  /** Only a sign-in this browser started is finished; any other ?code= is the app's own. */
  private async finishLandedSignIn(): Promise<void> {
    const landed = this.location == null ? null : readLandedSignIn(this.location.href);
    if (landed == null) return;
    const pending = await Promise.resolve(this.storage.getItem(this.verifierKey));
    if (pending == null || pending.length === 0) return;
    this.history?.replaceState(null, "", landed.cleaned);
    if (landed.error != null || landed.code == null) {
      await Promise.resolve(this.storage.removeItem(this.verifierKey));
      throw new AuthError(`Sign-in failed: ${landed.error ?? "no code"}`, landed.error ?? "server_error");
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
    const raw = await this.postJSON<RawAuthResponse>(this.host.authEndpoint("/register"), body);
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  async signInWithPassword(credentials: SignInWithPasswordCredentials): Promise<Session> {
    const body = {
      grant_type: "password",
      email: credentials.email,
      password: credentials.password,
    };
    const raw = await this.postJSON<RawAuthResponse>(this.host.authEndpoint("/token"), body);
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  async signInWithApiKey(apiKey?: string): Promise<Session> {
    const key = apiKey ?? this.host.publishableKey;
    const body = { grant_type: "api_key", api_key: key };
    const raw = await this.postJSON<RawAuthResponse>(this.host.authEndpoint("/token"), body);
    const session = this.sessionFromResponse(raw);
    this.installSession(session, "SIGNED_IN", { persist: true });
    return session;
  }

  async signOut(): Promise<void> {
    const refreshToken = this.session?.refreshToken;
    if (refreshToken != null && refreshToken.length > 0) {
      try {
        await this.postJSON(this.host.authEndpoint("/logout"), { refreshToken });
      } catch {
        // Swallow logout errors — the local session is removed regardless,
        // and the refresh token will be cleaned up server-side on expiry.
      }
    }
    this.installSession(null, "SIGNED_OUT", { persist: true });
  }

  /**
   * Rotates the current session. Prefers refresh_token grant when a refresh
   * token is present (password login path); falls back to api_key re-exchange
   * (SDK was bootstrapped anonymously or with an api-key-derived session).
   */
  async refresh(): Promise<Session | null> {
    const refreshToken = this.session?.refreshToken;
    if (refreshToken != null && refreshToken.length > 0) {
      const body = { grant_type: "refresh_token", refresh_token: refreshToken };
      const raw = await this.postJSON<RawAuthResponse>(this.host.authEndpoint("/token"), body);
      return this.sessionFromResponse(raw);
    }
    // No refresh token — this path handles the api-key flow (no refresh
    // tokens issued) and the anonymous-publishable-key bootstrap.
    if (this.host.publishableKey.startsWith("esk_")) {
      const body = { grant_type: "api_key", api_key: this.host.publishableKey };
      const raw = await this.postJSON<RawAuthResponse>(this.host.authEndpoint("/token"), body);
      return this.sessionFromResponse(raw);
    }
    return null;
  }

  /** Redeems the token from a verification email. The server ends every session the account had. */
  async verifyEmail(input: { token: string }): Promise<VerifyEmailResult> {
    requireValue(input.token, "token is required");
    const raw = await this.postJSON<{ verified?: boolean; passwordResetRequired?: boolean }>(
      this.host.authEndpoint("/verify-email"),
      { token: input.token },
    );
    return { verified: raw.verified === true, passwordResetRequired: raw.passwordResetRequired === true };
  }

  /** Asks for a new verification email. Resolves the same way whether or not the account exists. */
  async resendVerification(input: { email: string }): Promise<void> {
    requireValue(input.email, "email is required");
    await this.postJSON(this.host.authEndpoint("/resend-verification"), { email: input.email });
  }

  /** Asks for a password reset email. Resolves the same way whether or not the account exists. */
  async resetPasswordForEmail(email: string): Promise<void> {
    requireValue(email, "email is required");
    await this.postJSON(this.host.authEndpoint("/forgot-password"), { email });
  }

  /** Sets a new password with the token from a reset email. The server ends every session the account had. */
  async updatePasswordWithToken(input: UpdatePasswordWithTokenInput): Promise<void> {
    requireValue(input.token, "token is required");
    requireValue(input.password, "password is required");
    await this.postJSON(this.host.authEndpoint("/reset-password"), {
      token: input.token,
      newPassword: input.password,
    });
  }

  async createApiKey(input: { name: string; keyType: "publishable" | "secret" }): Promise<CreateAPIKeyResult> {
    return this.postJSON<CreateAPIKeyResult>(this.host.authEndpoint("/api-keys/"), input);
  }

  async listApiKeys(): Promise<APIKeyInfo[]> {
    const response = await this.getJSON<{ keys: APIKeyInfo[] }>(this.host.authEndpoint("/api-keys/"));
    return response.keys ?? [];
  }

  async revokeApiKey(id: number): Promise<void> {
    await this.deleteJSON(this.host.authEndpoint(`/api-keys/${id}`));
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
    this.session = session;
    this.tokenManager.setSession(session);
    if (opts.persist) {
      void this.persistSession(session);
    }
    for (const listener of this.listeners) {
      try {
        listener(event, session);
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

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Excalibase-Publishable-Key": this.host.publishableKey,
    };
    if (this.session?.accessToken != null) {
      headers["Authorization"] = `Bearer ${this.session.accessToken}`;
    }
    return headers;
  }

  private async postJSON<T>(url: string, body: unknown): Promise<T> {
    return this.requestJSON<T>("POST", url, body);
  }

  private async getJSON<T>(url: string): Promise<T> {
    return this.requestJSON<T>("GET", url);
  }

  private async deleteJSON<T>(url: string): Promise<T> {
    return this.requestJSON<T>("DELETE", url);
  }

  private async requestJSON<T>(method: string, url: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.baseHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof CorsError) throw error;
      throw new NetworkError(`Auth request failed: ${method} ${url}`, error);
    }
    const text = await response.text();
    const parsed = text.length > 0 ? parseJson(text) : null;
    if (!response.ok) {
      const message = extractErrorMessage(parsed) ?? `Auth ${method} ${url} failed with ${response.status}`;
      throw new AuthError(message, `http_${response.status}`, response.status, parsed);
    }
    return (parsed ?? ({} as T)) as T;
  }
}

function requireValue(value: string | undefined, message: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthError(message, "invalid_request");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(parsed: unknown): string | null {
  if (parsed != null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
  }
  return null;
}

/**
 * The signed-in end user, or null. An api-key (anonymous) session has no user; older auth servers sent a
 * placeholder `{ id: 0 }` for it, which must not read as someone signed in (EXC-607).
 */
function endUser(user: User | null | undefined): User | null {
  return user != null && typeof user.id === "number" && user.id > 0 ? user : null;
}
