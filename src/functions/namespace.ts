/**
 * `db.functions.<module>.<name>(args)` — typed HTTP RPC namespace plus a
 * `.watch()` orchestrator for reactive subscriptions.
 *
 * Each call returns a {@link LazyQuery} — a Promise-like object that is BOTH:
 *   - thenable (await resolves to the one-shot HTTP result; unchanged)
 *   - `.watch()`-able (orchestrates reactive updates by listening on graphql's
 *     collection-CDC WebSocket and re-invoking the function whenever a
 *     dependency table fires an event)
 *
 * The HTTP path POSTs to
 *   ${url}/functions/v1/${projectId}/${moduleName}.${exportName}
 * with `{ args }` as JSON.
 *
 * `await` calls do NOT request the envelope (back-compat unwrap of `{data}`).
 * `.watch()` calls add `X-Excalibase-Envelope: v1` so the server returns
 * `{result, reads}` and the orchestrator can subscribe to the right tables.
 */

import { FunctionsError, type ValidationIssue } from "./error";
import { ReactiveWebSocket, type SubError, type FunctionRefMsg } from "./reactive_ws";

export interface FunctionsNamespaceOptions {
  /** Server base URL — no trailing slash. */
  url: string;
  /** `{orgSlug}/{projectName}` or opaque id — appended to the function URL path. */
  projectId: string;
  /** Returns headers for each call (so Authorization can be re-read). */
  headersFactory: () => Record<string, string>;
  /** Bound `fetch` (defaults to `globalThis.fetch` if absent). */
  fetchImpl: typeof fetch;
  /**
   * WS endpoint for `.watch()` subscriptions — graphql's `/graphql` endpoint
   * (the same one used for collection-level CDC subscriptions). Required for
   * reactive subscriptions; calling `.watch()` without it throws.
   */
  wsUrl?: string;
  /** Returns the current JWT bearer token for the WS connection_init. */
  jwtProvider?: () => Promise<string> | string;
}

export interface Subscription<T = unknown> {
  onUpdate(handler: (data: T) => void): () => void;
  onError(handler: (err: SubError) => void): () => void;
  close(): void;
}

export interface LazyQuery<T = unknown> extends Promise<T> {
  watch(): Subscription<T>;
}

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
  "_invokeWithEnvelope",
  "_postFunction",
  "_closeReactive",
  "_reactive",
  "_ensureReactive",
  "_openSubscription",
  "_subIdCounter",
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
    return new Proxy(this, {
      get(target, prop, receiver): unknown {
        if (RESERVED_TOP_KEYS.has(prop)) return Reflect.get(target, prop, receiver);
        if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
        return makeModuleHandle(target, String(prop));
      },
    }) as unknown as FunctionsNamespace<F> & F;
  }

  /**
   * Plain HTTP invoke — no envelope header. Response `{data}` is unwrapped
   * for back-compat. Used by `await db.functions.x.y(args)`.
   */
  async _invoke(moduleName: string, exportName: string, args: unknown): Promise<unknown> {
    const text = await this._postFunction(moduleName, exportName, args, {});
    return text.parsed != null && typeof text.parsed === "object" && "data" in (text.parsed as Record<string, unknown>)
      ? (text.parsed as { data: unknown }).data
      : text.parsed;
  }

  /**
   * Envelope-aware invoke — sets `X-Excalibase-Envelope: v1` so the server
   * returns `{result, reads}`. Used by the reactive orchestrator on initial
   * subscribe and every CDC-triggered re-invoke.
   */
  async _invokeWithEnvelope(
    moduleName: string,
    exportName: string,
    args: unknown,
  ): Promise<{ result: unknown; reads: readonly string[] }> {
    const text = await this._postFunction(moduleName, exportName, args, {
      "X-Excalibase-Envelope": "v1",
    });
    const parsed = text.parsed;
    if (parsed != null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if ("result" in obj || "reads" in obj) {
        const reads = Array.isArray(obj.reads)
          ? (obj.reads as unknown[]).filter((v) => typeof v === "string") as string[]
          : [];
        return { result: obj.result, reads };
      }
      // Server hasn't yet learned the envelope header — fall back to {data}.
      if ("data" in obj) {
        return { result: obj.data, reads: [] };
      }
    }
    return { result: parsed, reads: [] };
  }

  private async _postFunction(
    moduleName: string,
    exportName: string,
    args: unknown,
    extraHeaders: Record<string, string>,
  ): Promise<{ parsed: unknown; status: number }> {
    const url = `${this.url}/functions/v1/${this.projectId}/${moduleName}.${exportName}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headersFactory(),
      ...extraHeaders,
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
    return { parsed, status: response.status };
  }

  _openSubscription(moduleName: string, exportName: string, args: unknown): Subscription<unknown> {
    if (this.wsUrl == null || this.wsUrl.length === 0) {
      throw new Error(
        "db.functions.<m>.<n>().watch() requires `wsUrl` to be set in createClient(). " +
          "See docs/reactive-queries.md.",
      );
    }
    const reactive = this._ensureReactive();
    const subId = this._nextSubId();
    const updateListeners = new Set<(d: unknown) => void>();
    const errorListeners = new Set<(e: SubError) => void>();
    let teardown: (() => void) | null = null;
    let closed = false;
    void reactive.subscribe(
      subId,
      { moduleName, exportName },
      args,
      (data) => {
        for (const fn of updateListeners) fn(data);
      },
      (err) => {
        for (const fn of errorListeners) fn(err);
      },
    ).then((t) => {
      teardown = t;
      if (closed) t();
    }).catch((err) => {
      for (const fn of errorListeners) {
        fn({ code: "subscribe_failed", message: err instanceof Error ? err.message : String(err) });
      }
    });
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
        if (teardown != null) teardown();
      },
    };
  }

  private _ensureReactive(): ReactiveWebSocket {
    if (this._reactive != null) return this._reactive;
    const ws = new ReactiveWebSocket({
      url: this.wsUrl as string,
      jwtProvider: this.jwtProvider ?? (() => ""),
      invoke: (ref: FunctionRefMsg, args: unknown) =>
        this._invokeWithEnvelope(ref.moduleName, ref.exportName, args),
    });
    this._reactive = ws;
    return ws;
  }

  async _closeReactive(): Promise<void> {
    const ws = this._reactive;
    this._reactive = null;
    if (ws != null) await ws.close();
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
