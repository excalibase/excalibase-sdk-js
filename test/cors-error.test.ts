import { createClient, CorsError, NetworkError } from "../src";
import { corsFailure } from "../src/cors";
import { memoryStorageAdapter } from "../src/storage";

const API = "https://api.example.com";
const PAGE = "http://localhost:5173";

type Env = { origin?: string; onLine?: boolean };

// A browser page on `origin`; without one this is a server (Node) runtime.
function asBrowser({ origin, onLine }: Env): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  if (origin !== undefined) g.window = { location: { origin } };
  Object.defineProperty(globalThis, "navigator", { value: { onLine }, configurable: true, writable: true });
  return () => {
    if (saved.window === undefined) delete g.window;
    else g.window = saved.window;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
    else delete g.navigator;
  };
}

const failedToFetch = () => Promise.reject(new TypeError("Failed to fetch"));

function client(fetchImpl: typeof fetch) {
  return createClient({
    url: API,
    projectId: "proj-abc",
    publishableKey: "esk_pub_live_abcdefghijklmnop",
    storage: memoryStorageAdapter(),
    autoRefreshToken: false,
    fetch: fetchImpl,
  });
}

describe("a browser call blocked by CORS", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("REST says it was probably CORS, names the page origin and where to allow it", async () => {
    restore = asBrowser({ origin: PAGE, onLine: true });
    const error = await client(failedToFetch as typeof fetch).rest.get("/todos").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorsError);
    expect(error).toBeInstanceOf(NetworkError);
    const cors = error as CorsError;
    expect(cors.code).toBe("cors_blocked");
    expect(cors.origin).toBe(PAGE);
    expect(cors.message).toContain("probably blocked by CORS");
    expect(cors.message).toContain(`${PAGE} `);
    expect(cors.message).toContain("Studio → Settings → Allowed origins");
    expect(cors.cause).toBeInstanceOf(TypeError);
  });

  it("GraphQL, auth and functions report it the same way", async () => {
    restore = asBrowser({ origin: PAGE, onLine: true });
    const db = client(failedToFetch as typeof fetch);
    await expect(db.rawGraphql("{ todos { id } }")).rejects.toBeInstanceOf(CorsError);
    await expect(db.auth.signInWithPassword({ email: "a@b.c", password: "pw" })).rejects.toBeInstanceOf(CorsError);
    const functions = db.functions as unknown as { todos: { list: (args: unknown) => Promise<unknown> } };
    await expect(functions.todos.list({})).rejects.toBeInstanceOf(CorsError);
  });

  it.each([
    ["Firefox", "NetworkError when attempting to fetch resource."],
    ["Safari", "Load failed"],
  ])("%s's wording is recognised", (_browser, message) => {
    restore = asBrowser({ origin: PAGE, onLine: true });
    expect(corsFailure(new TypeError(message), `${API}/x`)).toBeInstanceOf(CorsError);
  });
});

describe("failures that are not CORS keep their own error", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("an offline browser is not told about CORS", () => {
    restore = asBrowser({ origin: PAGE, onLine: false });
    expect(corsFailure(new TypeError("Failed to fetch"), `${API}/x`)).toBeNull();
  });

  it("a server runtime has no origin and no CORS", () => {
    restore = asBrowser({ onLine: true });
    expect(corsFailure(new TypeError("fetch failed"), `${API}/x`)).toBeNull();
  });

  it("a same-origin call cannot be refused by CORS", () => {
    restore = asBrowser({ origin: API, onLine: true });
    expect(corsFailure(new TypeError("Failed to fetch"), new URL(`${API}/x`))).toBeNull();
    expect(corsFailure(new TypeError("Failed to fetch"), new Request(`${API}/x`))).toBeNull();
    expect(corsFailure(new TypeError("Failed to fetch"), "/x")).toBeNull();
  });

  it("an abort or a programming error is not CORS", () => {
    restore = asBrowser({ origin: PAGE, onLine: true });
    expect(corsFailure(new DOMException("aborted", "AbortError"), `${API}/x`)).toBeNull();
    expect(corsFailure(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"), `${API}/x`)).toBeNull();
  });

  it("an opaque page origin is not named", () => {
    restore = asBrowser({ origin: "null", onLine: true });
    expect(corsFailure(new TypeError("Failed to fetch"), `${API}/x`)).toBeNull();
  });

  it("REST in a server runtime still throws a plain NetworkError", async () => {
    restore = asBrowser({ onLine: true });
    const error = await client(failedToFetch as typeof fetch).rest.get("/todos").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(CorsError);
  });
});
