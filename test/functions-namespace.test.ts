/**
 * Phase 2: `db.functions.<module>.<name>(args)` — typed HTTP RPC namespace.
 *
 * The namespace is a 2-level Proxy: top-level property access yields a
 * "module" handle whose own properties are callable "function refs". Each
 * call POSTs to `${url}/functions/v1/${projectId}/${moduleName}.${exportName}`
 * with body `{ args }`. The response body is JSON; `{ data }` is unwrapped,
 * `{ error, issues? }` throws a `FunctionsError`.
 */

import { describe, test, expect } from "@jest/globals";
import { FunctionsNamespace } from "../src/functions/namespace";
import { FunctionsError } from "../src/functions/error";
import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function captureMockFetch(response: {
  status?: number;
  body: unknown;
}): { fetchImpl: typeof fetch; lastRequest: () => CapturedRequest | null } {
  let captured: CapturedRequest | null = null;
  const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit) => {
    captured = {
      url: url as string,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : null,
    };
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, lastRequest: () => captured };
}

describe("FunctionsNamespace (low-level)", () => {
  test("invokes the moduleName.exportName URL with {args} body", async () => {
    const { fetchImpl, lastRequest } = captureMockFetch({
      body: { data: { count: 3 } },
    });
    const ns = new FunctionsNamespace({
      url: "http://localhost:10000",
      projectId: "acme/prod",
      headersFactory: () => ({ "X-Excalibase-Publishable-Key": "pk" }),
      fetchImpl,
    });

    const result = await ns._invoke("users", "list", { status: "active" });
    expect(result).toEqual({ count: 3 });

    const req = lastRequest()!;
    expect(req.url).toBe("http://localhost:10000/functions/v1/acme/prod/users.list");
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.headers["X-Excalibase-Publishable-Key"]).toBe("pk");
    expect(req.body).toEqual({ args: { status: "active" } });
  });

  test("Proxy access shape — db.functions.users.list(args) maps to _invoke", async () => {
    const { fetchImpl, lastRequest } = captureMockFetch({
      body: { data: [{ id: 1 }] },
    });
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxied = ns as unknown as any;
    const out = await proxied.users.list({ q: "all" });
    expect(out).toEqual([{ id: 1 }]);
    expect(lastRequest()!.url).toBe("http://x/functions/v1/a/b/users.list");
    expect(lastRequest()!.body).toEqual({ args: { q: "all" } });
  });

  test("throws FunctionsError with validation issues on 400", async () => {
    const { fetchImpl } = captureMockFetch({
      status: 400,
      body: { error: "validation", issues: [{ path: ["name"], message: "required" }] },
    });
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl,
    });
    await expect(ns._invoke("users", "create", {})).rejects.toMatchObject({
      name: "FunctionsError",
      issues: [{ path: ["name"], message: "required" }],
    });
  });

  test("throws FunctionsError with generic message on 500", async () => {
    const { fetchImpl } = captureMockFetch({
      status: 500,
      body: { error: "boom" },
    });
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl,
    });
    let caught: unknown;
    try {
      await ns._invoke("users", "list", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FunctionsError);
    expect((caught as FunctionsError).message).toContain("boom");
    expect((caught as FunctionsError).issues).toBeUndefined();
  });

  test("authorization header is included from headersFactory", async () => {
    const { fetchImpl, lastRequest } = captureMockFetch({
      body: { data: { ok: true } },
    });
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({ Authorization: "Bearer jwt-xyz" }),
      fetchImpl,
    });
    await ns._invoke("m", "n", {});
    expect(lastRequest()!.headers["Authorization"]).toBe("Bearer jwt-xyz");
  });

  test("wraps fetch network errors as FunctionsError", async () => {
    const failing: typeof fetch = (async () => {
      throw new Error("econnrefused");
    }) as typeof fetch;
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl: failing,
    });
    let caught: unknown;
    try {
      await ns._invoke("m", "n", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FunctionsError);
    expect((caught as FunctionsError).code).toBe("network_error");
    expect((caught as FunctionsError).message).toContain("econnrefused");
  });

  test("extracts `message` field on error responses when `error` is absent", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ message: "kaboom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl,
    });
    await expect(ns._invoke("m", "n", {})).rejects.toMatchObject({
      name: "FunctionsError",
      message: expect.stringContaining("kaboom"),
    });
  });

  test("falls back to default error message when body is non-JSON", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("not-json-at-all", { status: 502 })) as typeof fetch;
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl,
    });
    await expect(ns._invoke("m", "n", {})).rejects.toMatchObject({
      name: "FunctionsError",
      message: expect.stringContaining("502"),
    });
  });

  test("returns raw body when response has no `data` field (forward compat)", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ raw: "stuff" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl,
    });
    const out = await ns._invoke("m", "n", {});
    expect(out).toEqual({ raw: "stuff" });
  });

  test("module handle then/catch/finally property access returns undefined (not callable)", async () => {
    const { fetchImpl } = captureMockFetch({ body: { data: 1 } });
    const ns = new FunctionsNamespace({
      url: "http://x",
      projectId: "a/b",
      headersFactory: () => ({}),
      fetchImpl,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (ns as any).users;
    expect(mod.then).toBeUndefined();
    expect(mod.catch).toBeUndefined();
    expect(mod.finally).toBeUndefined();
    // Symbol property access on a module handle returns undefined.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mod as any)[Symbol.iterator]).toBeUndefined();
  });
});

describe("createClient → db.functions wiring", () => {
  const validOpts = {
    url: "http://localhost:10000",
    projectId: "acme/prod",
    publishableKey: "esk_pub_live_abcdefghijklmnop",
    storage: memoryStorageAdapter(),
    autoRefreshToken: false,
  };

  test("db.functions is present on the client", () => {
    const db = createClient(validOpts);
    expect(db.functions).toBeDefined();
    // proxied — has the _invoke method exposed for testing/escape hatch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (db.functions as any)._invoke).toBe("function");
  });

  test("calling db.functions.users.list dispatches with publishable key + bearer header", async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      captured = {
        url: url as string,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      return new Response(JSON.stringify({ data: { total: 7 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createClient({ ...validOpts, fetch: mockFetch });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fns = db.functions as unknown as any;
    const out = await fns.users.list({ status: "active" });
    expect(out).toEqual({ total: 7 });
    expect(captured!.url).toBe("http://localhost:10000/functions/v1/acme/prod/users.list");
    expect(captured!.headers["X-Excalibase-Publishable-Key"]).toBe(validOpts.publishableKey);
    expect(captured!.body).toEqual({ args: { status: "active" } });
  });
});
