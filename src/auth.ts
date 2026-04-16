import { AuthError, NetworkError } from "./errors";
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

export interface AuthClientOptions {
  client: AuthClientHost;
  storage: StorageAdapter;
  storageKey: string;
  autoRefreshToken: boolean;
  fetch: typeof fetch;
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

  constructor(opts: AuthClientOptions) {
    this.host = opts.client;
    this.storage = opts.storage;
    this.storageKey = opts.storageKey;
    this.fetchImpl = opts.fetch;
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
          this.session = parsed;
          this.tokenManager.setSession(parsed);
        }
      }
    } catch {
      // Ignore malformed storage — treat as no session.
    }
    return this.session;
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
      user: raw.user ?? null,
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
