import type { Session } from "./types";

export type RefreshFn = () => Promise<Session | null>;

export interface TokenManagerOptions {
  session: Session | null;
  refresh: RefreshFn;
  onRefreshed?: (session: Session | null) => void;
  onError?: (error: unknown) => void;
  leadTimeMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Schedules a token refresh at (expiresAt - leadTime). The refresh callback
 * is responsible for performing the actual network exchange (password
 * refresh_token flow OR api_key re-exchange) and returning the new session.
 */
export class TokenManager {
  private session: Session | null;
  private readonly refresh: RefreshFn;
  private readonly onRefreshed?: (session: Session | null) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly leadTimeMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private handle: unknown = null;
  private stopped = false;
  private started = false;

  constructor(opts: TokenManagerOptions) {
    this.session = opts.session;
    this.refresh = opts.refresh;
    this.onRefreshed = opts.onRefreshed;
    this.onError = opts.onError;
    this.leadTimeMs = opts.leadTimeMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.stopped = false;
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.handle !== null) {
      this.clearTimeoutFn(this.handle);
      this.handle = null;
    }
  }

  setSession(session: Session | null): void {
    this.session = session;
    if (this.handle !== null) {
      this.clearTimeoutFn(this.handle);
      this.handle = null;
    }
    if (this.started && !this.stopped) {
      this.schedule();
    }
  }

  getSession(): Session | null {
    return this.session;
  }

  private schedule(): void {
    if (this.stopped || !this.started || this.session == null) {
      return;
    }
    const msUntilRefresh = Math.max(0, this.session.expiresAt - this.now() - this.leadTimeMs);
    this.handle = this.setTimeoutFn(() => {
      this.handle = null;
      void this.runRefresh();
    }, msUntilRefresh);
  }

  private async runRefresh(): Promise<void> {
    if (this.stopped) return;
    try {
      const next = await this.refresh();
      if (this.stopped) return;
      this.session = next;
      this.onRefreshed?.(next);
      this.schedule();
    } catch (error) {
      this.onError?.(error);
      // Do not reschedule on error — the AuthClient decides whether to retry
      // via signInWithApiKey or surface the failure to the caller.
    }
  }
}

export function computeExpiresAt(expiresInSeconds: number, now: number = Date.now()): number {
  return now + Math.max(0, expiresInSeconds) * 1000;
}
