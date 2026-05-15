/**
 * `db.functions.<module>.<name>(args)` — typed HTTP RPC namespace.
 *
 * The Proxy resolves any property access as a module handle whose own
 * Proxy resolves the next property as the exported function name. Calling
 * the resolved property POSTs to
 *
 *   ${url}/functions/v1/${projectId}/${moduleName}.${exportName}
 *
 * with `{ args }` as JSON. The returned promise resolves to the function's
 * unwrapped `data` payload (or the raw response when the server didn't
 * wrap it).
 */

import { FunctionsError, type ValidationIssue } from "./error";

export interface FunctionsNamespaceOptions {
  /** Server base URL — no trailing slash. */
  url: string;
  /** `{orgSlug}/{projectName}` or opaque id — appended to the function URL path. */
  projectId: string;
  /** Returns headers for each call (so Authorization can be re-read). */
  headersFactory: () => Record<string, string>;
  /** Bound `fetch` (defaults to `globalThis.fetch` if absent). */
  fetchImpl: typeof fetch;
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
  "_postFunction",
  "url",
  "projectId",
  "headersFactory",
  "fetchImpl",
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
    return new Proxy(this, {
      get(target, prop, receiver): unknown {
        if (RESERVED_TOP_KEYS.has(prop)) return Reflect.get(target, prop, receiver);
        if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
        return makeModuleHandle(target, String(prop));
      },
    }) as unknown as FunctionsNamespace<F> & F;
  }

  /**
   * Plain HTTP invoke. Response `{data}` is unwrapped for back-compat.
   */
  async _invoke(moduleName: string, exportName: string, args: unknown): Promise<unknown> {
    const text = await this._postFunction(moduleName, exportName, args);
    return text.parsed != null && typeof text.parsed === "object" && "data" in (text.parsed as Record<string, unknown>)
      ? (text.parsed as { data: unknown }).data
      : text.parsed;
  }

  private async _postFunction(
    moduleName: string,
    exportName: string,
    args: unknown,
  ): Promise<{ parsed: unknown; status: number }> {
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
    return { parsed, status: response.status };
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
