/**
 * Phase 2 + 9b.C: `db.functions.<module>.<name>(args)` typed RPC namespace.
 *
 * Runtime structure: a two-level `Proxy` wraps a {@link FunctionsNamespace}
 * instance. Top-level property access yields a "module" handle whose own
 * property access produces a callable function ref.
 *
 * As of Phase 9b.C, each call returns a {@link LazyQuery} — a Promise-like
 * object that is BOTH:
 *   - thenable (await resolves to the one-shot HTTP result; Phase 2 behavior)
 *   - `.watch()`-able (opens a WS subscription for push updates; Phase 9b.C)
 *
 * The HTTP path POSTs to
 *   ${url}/functions/v1/${projectId}/${moduleName}.${exportName}
 * with `{ args }` as JSON. Response `{ data }` is unwrapped; `{ error, issues? }`
 * throws {@link FunctionsError}. The WS path is implemented by
 * {@link ReactiveWebSocket}; the namespace owns one WS per `db` client and
 * multiplexes all watch subscriptions.
 */

import { FunctionsError, type ValidationIssue } from "./error";
import { ReactiveWebSocket, type SubError } from "./reactive_ws";

export interface FunctionsNamespaceOptions {
  /** Server base URL — no trailing slash. */
  url: string;
  /** `{orgSlug}/{projectName}` — appended to the function URL path. */
  projectId: string;
  /** Returns headers for each call (so Authorization can be re-read). */
  headersFactory: () => Record<string, string>;
  /** Bound `fetch` (defaults to `globalThis.fetch` if absent). */
  fetchImpl: typeof fetch;
  /**
   * Optional WS endpoint for `.watch()` subscriptions. Required for reactive
   * subscriptions; calling `.watch()` without it throws a clear error.
   */
  wsUrl?: string;
  /** Returns the current JWT bearer token for WS auth (query param `token`). */
  jwtProvider?: () => Promise<string> | string;
}

/** A reactive subscription handle. */
export interface Subscription<T = unknown> {
  /** Register an update listener. Returns an unsubscribe function. */
  onUpdate(handler: (data: T) => void): () => void;
  /** Register an error listener. Returns an unsubscribe function. */
  onError(handler: (err: SubError) => void): () => void;
  /** Stop the subscription server-side and tear down listeners. */
  close(): void;
}

/**
 * Returned from `db.functions.<m>.<n>(args)`. Either:
 *   - `await` it → one-shot HTTP result
 *   - call `.watch()` → reactive WebSocket subscription
 */
export interface LazyQuery<T = unknown> extends Promise<T> {
  watch(): Subscription<T>;
}

// Reserved at the top-level Proxy to avoid synthesizing module handles for
// internal members. `_invoke`, `_closeReactive`, `_reactive` etc are own
// methods on the FunctionsNamespace instance and must pass through.
const RESERVED_TOP_KEYS = new Set<PropertyKey>([
  "then",
  "catch",
  "finally",
  "constructor",
  "toString",
  "toJSON",
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  "_invoke",
  "_closeReactive",
  "_reactive",
  "_nextSubId",
  "url",
  "projectId",
  "headersFactory",
  "fetchImpl",
  "wsUrl",
  "jwtProvider",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeModuleHandle(ns: FunctionsNamespace<any>, moduleName: string): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, exportProp): unknown {
      if (typeof exportProp === "symbol") return undefined;
      if (exportProp === "then" || exportProp === "catch" || exportProp === "finally") {
        return undefined;
      }
      const exportName = String(exportProp);
      return (args: unknown) => makeLazyQuery(ns, moduleName, exportName, args);
    },
  });
}

/**
 * Builds a thenable that is also `.watch()`-able. The `then/catch/finally`
 * implementations defer to a lazily-constructed HTTP Promise (created on
 * first `then`). `.watch()` opens a WS subscription via the namespace's
 * shared {@link ReactiveWebSocket}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeLazyQuery(ns: FunctionsNamespace<any>, moduleName: string, exportName: string, args: unknown): LazyQuery<unknown> {
  let httpPromise: Promise<unknown> | null = null;
  const ensurePromise = (): Promise<unknown> => {
    if (httpPromise == null) httpPromise = ns._invoke(moduleName, exportName, args);
    return httpPromise;
  };
  const lazy: Partial<LazyQuery<unknown>> & Record<string, unknown> = {
    then(onFulfilled?: unknown, onRejected?: unknown) {
      return ensurePromise().then(onFulfilled as never, onRejected as never);
    },
    catch(onRejected?: unknown) {
      return ensurePromise().catch(onRejected as never);
    },
    finally(onFinally?: unknown) {
      return ensurePromise().finally(onFinally as never);
    },
    watch(): Subscription<unknown> {
      return ns._openSubscription(moduleName, exportName, args);
    },
  };
  // Tag for Promise.resolve detection — not strictly required, but cleaner
  // for libraries that sniff `Symbol.toStringTag`.
  Object.defineProperty(lazy, Symbol.toStringTag, { value: "LazyQuery" });
  return lazy as LazyQuery<unknown>;
}

export class FunctionsNamespace<F = unknown> {
  readonly url: string;
  readonly projectId: string;
  readonly headersFactory: () => Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly wsUrl: string | undefined;
  readonly jwtProvider: (() => Promise<string> | string) | undefined;
  private _reactive: ReactiveWebSocket | null = null;
  private _subIdCounter = 0;

  constructor(opts: FunctionsNamespaceOptions) {
    this.url = opts.url;
    this.projectId = opts.projectId;
    this.headersFactory = opts.headersFactory;
    this.fetchImpl = opts.fetchImpl;
    this.wsUrl = opts.wsUrl;
    this.jwtProvider = opts.jwtProvider;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return new Proxy(this, {
      get(target, prop, receiver): unknown {
        if (RESERVED_TOP_KEYS.has(prop)) return Reflect.get(target, prop, receiver);
        if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
        return makeModuleHandle(self, String(prop));
      },
    }) as unknown as FunctionsNamespace<F> & F;
  }

  async _invoke(moduleName: string, exportName: string, args: unknown): Promise<unknown> {
    const url = `${this.url}/functions/v1/${this.projectId}/${moduleName}.${exportName}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headersFactory(),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ args }),
      });
    } catch (err) {
      throw new FunctionsError(
        `network error invoking ${moduleName}.${exportName}: ${(err as Error).message ?? String(err)}`,
        { code: "network_error" },
      );
    }
    const text = await response.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : null;

    if (!response.ok) {
      const message = extractErrorMessage(parsed) ?? `functions ${moduleName}.${exportName} failed with ${response.status}`;
      const issues = extractIssues(parsed);
      throw new FunctionsError(message, {
        code: issues != null ? "validation" : "functions_error",
        status: response.status,
        issues,
      });
    }
    if (parsed != null && typeof parsed === "object" && "data" in (parsed as Record<string, unknown>)) {
      return (parsed as { data: unknown }).data;
    }
    return parsed;
  }

  /**
   * Open a `.watch()` subscription. Creates the shared {@link ReactiveWebSocket}
   * on first call. Throws when `wsUrl` was not configured.
   */
  _openSubscription(moduleName: string, exportName: string, args: unknown): Subscription<unknown> {
    if (this.wsUrl == null || this.wsUrl.length === 0) {
      throw new Error(
        "db.functions.<m>.<n>().watch() requires `wsUrl` to be set in createClient(). " +
          "See docs/reactive-queries.md.",
      );
    }
    if (this._reactive == null) {
      this._reactive = new ReactiveWebSocket({
        url: this.wsUrl,
        jwtProvider: this.jwtProvider ?? (() => ""),
      });
    }
    const subId = this._nextSubId();
    const updateListeners = new Set<(d: unknown) => void>();
    const errorListeners = new Set<(e: SubError) => void>();
    let unsub: (() => void) | null = null;
    const reactive = this._reactive;
    const start = (): void => {
      unsub = reactive.subscribe(
        subId,
        { moduleName, exportName },
        args,
        (data) => {
          for (const fn of updateListeners) fn(data);
        },
        (err) => {
          for (const fn of errorListeners) fn(err);
        },
      );
    };
    start();
    let closed = false;
    return {
      onUpdate(handler) {
        updateListeners.add(handler);
        return () => {
          updateListeners.delete(handler);
        };
      },
      onError(handler) {
        errorListeners.add(handler);
        return () => {
          errorListeners.delete(handler);
        };
      },
      close() {
        if (closed) return;
        closed = true;
        updateListeners.clear();
        errorListeners.clear();
        if (unsub != null) unsub();
      },
    };
  }

  /** Close the underlying reactive WebSocket (if any) and reset. */
  async _closeReactive(): Promise<void> {
    const ws = this._reactive;
    this._reactive = null;
    if (ws != null) {
      await ws.close();
    }
  }

  private _nextSubId(): string {
    this._subIdCounter += 1;
    return `s${this._subIdCounter}`;
  }
}

function safeJsonParse(text: string): unknown {
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

function extractIssues(parsed: unknown): ReadonlyArray<ValidationIssue> | undefined {
  if (parsed != null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.issues)) {
      return obj.issues as ReadonlyArray<ValidationIssue>;
    }
  }
  return undefined;
}
