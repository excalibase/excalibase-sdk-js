import { AuthError, CorsError, NetworkError } from "./errors";

export interface AuthHttpOptions {
  fetch: typeof fetch;
  publishableKey: () => string;
  /** The current session's access token, sent as the bearer when there is one. */
  accessToken: () => string | null;
}

/** JSON requests to the auth server; a non-2xx answer becomes an AuthError carrying the server's `error`. */
export class AuthHttp {
  constructor(private readonly options: AuthHttpOptions) {}

  post<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>("POST", url, body);
  }

  get<T>(url: string): Promise<T> {
    return this.request<T>("GET", url);
  }

  delete<T>(url: string): Promise<T> {
    return this.request<T>("DELETE", url);
  }

  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers: this.headers(),
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

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Excalibase-Publishable-Key": this.options.publishableKey(),
    };
    const accessToken = this.options.accessToken();
    if (accessToken != null) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }
    return headers;
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
