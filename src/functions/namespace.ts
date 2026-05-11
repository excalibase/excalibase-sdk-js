/**
 * Phase 2: `db.functions.<module>.<name>(args)` HTTP RPC namespace.
 *
 * Runtime structure: a two-level `Proxy` wraps a {@link FunctionsNamespace}
 * instance. Top-level property access yields a "module" handle whose own
 * property access produces a callable function ref. Each call POSTs to
 *   ${url}/functions/v1/${projectId}/${moduleName}.${exportName}
 * with `{ args }` as the JSON body. The response body is `{ data }`
 * (success) or `{ error, issues? }` (failure → {@link FunctionsError}).
 *
 * The namespace shape is typed in {@link DefaultFunctions} (or a codegen-
 * emitted `Functions` interface). The Proxy's actual implementation does
 * not see types — `_invoke` is the single underlying entry point.
 */

import { FunctionsError, type ValidationIssue } from "./error";

export interface FunctionsNamespaceOptions {
  /** Server base URL — no trailing slash. */
  url: string;
  /** `{orgSlug}/{projectName}` — appended to the function URL path. */
  projectId: string;
  /** Returns headers for each call (so Authorization can be re-read). */
  headersFactory: () => Record<string, string>;
  /** Bound `fetch` (defaults to `globalThis.fetch` if absent). */
  fetchImpl: typeof fetch;
}

// Module-level reserved keys that must NOT be intercepted by the Proxy —
// otherwise `await` machinery (e.g. checking for `.then`), `console.log`
// inspection, etc., spuriously generate "modules" or surprising callables.
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
  "url",
  "projectId",
  "headersFactory",
  "fetchImpl",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeModuleHandle(ns: FunctionsNamespace<any>, moduleName: string): Record<string, unknown> {
  // Each module handle is itself a Proxy. Property access yields a callable
  // that delegates to `ns._invoke(moduleName, exportName, args)`.
  return new Proxy({} as Record<string, unknown>, {
    get(_target, exportProp): unknown {
      if (typeof exportProp === "symbol") return undefined;
      if (exportProp === "then" || exportProp === "catch" || exportProp === "finally") {
        // Make module handles non-thenable so `await` doesn't try to drain them.
        return undefined;
      }
      const exportName = String(exportProp);
      return (args: unknown) => ns._invoke(moduleName, exportName, args);
    },
  });
}

export class FunctionsNamespace<F = unknown> {
  readonly url: string;
  readonly projectId: string;
  readonly headersFactory: () => Record<string, string>;
  readonly fetchImpl: typeof fetch;

  constructor(opts: FunctionsNamespaceOptions) {
    this.url = opts.url;
    this.projectId = opts.projectId;
    this.headersFactory = opts.headersFactory;
    this.fetchImpl = opts.fetchImpl;
    // Returning a Proxy from the constructor swaps the instance the caller
    // sees. Top-level property access is intercepted to yield module handles
    // (also Proxies), while reserved keys (own methods/fields, then/catch)
    // pass through unchanged so the instance methods still work.
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
    // No `data` field — return the whole body. Keeps the SDK forward-compat
    // with bare responses (e.g. legacy v1 fetch handlers wired through).
    return parsed;
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
