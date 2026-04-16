import { createClient } from "../src";
import { AuthError } from "../src/errors";
import { memoryStorageAdapter } from "../src/storage";
import type { RawAuthResponse } from "../src/types";

type FetchCall = {
  url: string;
  init: RequestInit;
};

interface RouteHandler {
  (call: FetchCall): { status?: number; body?: unknown };
}

function makeFetch(handlers: Record<string, RouteHandler>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mock: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${pathOf(url)}`;
    calls.push({ url, init });
    const handler = handlers[key];
    if (handler == null) {
      return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 500 });
    }
    const result = handler({ url, init });
    const status = result.status ?? 200;
    // 204 / 205 / 304 are defined as "null body status" in the fetch spec;
    // passing any body (even empty string) throws on Response construction.
    const nullBodyStatus = status === 204 || status === 205 || status === 304;
    const body = result.body === undefined || nullBodyStatus ? null : JSON.stringify(result.body);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: mock, calls };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function passwordResponse(): RawAuthResponse {
  return {
    accessToken: "jwt-access",
    refreshToken: "rt-1",
    tokenType: "Bearer",
    expiresIn: 3600,
    user: { id: 42, email: "alice@example.com", fullName: "Alice" },
  };
}

function apiKeyResponse(): RawAuthResponse {
  return {
    accessToken: "jwt-anon",
    tokenType: "Bearer",
    expiresIn: 3600,
  };
}

const baseOpts = {
  url: "http://localhost:10010",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  autoRefreshToken: false,
};

describe("AuthClient.signInWithPassword", () => {
  it("POSTs /token with grant_type=password and installs the session", async () => {
    let capturedBody: string | null = null;
    const { fetch: f, calls } = makeFetch({
      "POST /auth/acme/prod/token": ({ init }) => {
        capturedBody = init.body as string;
        return { body: passwordResponse() };
      },
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    const session = await db.auth.signInWithPassword({
      email: "alice@example.com",
      password: "s3cret",
    });
    expect(calls).toHaveLength(1);
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ grant_type: "password", email: "alice@example.com", password: "s3cret" });
    expect(session.accessToken).toBe("jwt-access");
    expect(session.refreshToken).toBe("rt-1");
    expect(session.user?.email).toBe("alice@example.com");
    expect(db.auth.currentSession()?.accessToken).toBe("jwt-access");
  });

  it("raises AuthError on 401", async () => {
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ status: 401, body: { error: "invalid credentials" } }),
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(
      db.auth.signInWithPassword({ email: "x@y.z", password: "wrong" }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("persists the session to storage", async () => {
    const storage = memoryStorageAdapter();
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
    });
    const db = createClient({ ...baseOpts, storage, fetch: f });
    await db.auth.signInWithPassword({ email: "alice@example.com", password: "s3cret" });
    const raw = storage.getItem(`excalibase.auth.session:acme/prod`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.accessToken).toBe("jwt-access");
  });
});

describe("AuthClient.signInWithApiKey", () => {
  it("POSTs /token with grant_type=api_key and no refresh token returned", async () => {
    let capturedBody: string | null = null;
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": ({ init }) => {
        capturedBody = init.body as string;
        return { body: apiKeyResponse() };
      },
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    const session = await db.auth.signInWithApiKey();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.grant_type).toBe("api_key");
    expect(parsed.api_key).toBe(baseOpts.publishableKey);
    expect(session.refreshToken).toBeNull();
    expect(session.accessToken).toBe("jwt-anon");
  });
});

describe("AuthClient.signUp", () => {
  it("POSTs /register and installs the session", async () => {
    let capturedBody: string | null = null;
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/register": ({ init }) => {
        capturedBody = init.body as string;
        return { body: passwordResponse() };
      },
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    const session = await db.auth.signUp({ email: "new@x.z", password: "pw", fullName: "New" });
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ email: "new@x.z", password: "pw", fullName: "New" });
    expect(session.accessToken).toBe("jwt-access");
  });
});

describe("AuthClient.signOut", () => {
  it("clears the session and calls /logout if a refresh token is present", async () => {
    let logoutHit = false;
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
      "POST /auth/acme/prod/logout": () => {
        logoutHit = true;
        return { body: { status: "ok" } };
      },
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    expect(db.auth.currentSession()).not.toBeNull();
    await db.auth.signOut();
    expect(db.auth.currentSession()).toBeNull();
    expect(logoutHit).toBe(true);
  });

  it("clears local session even if /logout errors", async () => {
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
      "POST /auth/acme/prod/logout": () => ({ status: 500, body: { error: "boom" } }),
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    await db.auth.signOut();
    expect(db.auth.currentSession()).toBeNull();
  });
});

describe("AuthClient.refresh", () => {
  it("uses refresh_token grant when a refresh token is present", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": ({ init }) => {
        bodies.push(JSON.parse(init.body as string));
        return { body: passwordResponse() };
      },
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    await db.auth.refresh();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ grant_type: "refresh_token", refresh_token: "rt-1" });
  });

  it("falls back to api_key grant when no refresh token exists", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": ({ init }) => {
        bodies.push(JSON.parse(init.body as string));
        return { body: apiKeyResponse() };
      },
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.refresh();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ grant_type: "api_key", api_key: baseOpts.publishableKey });
  });
});

describe("AuthClient.onAuthStateChange", () => {
  it("fires SIGNED_IN on sign-in and SIGNED_OUT on sign-out", async () => {
    const events: Array<{ event: string; hasSession: boolean }> = [];
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
      "POST /auth/acme/prod/logout": () => ({ body: {} }),
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    const sub = db.auth.onAuthStateChange((event, session) => {
      events.push({ event, hasSession: session != null });
    });
    // Let the microtask-deferred initial fire flush.
    await Promise.resolve();
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    await db.auth.signOut();
    sub.unsubscribe();
    expect(events.map((e) => e.event)).toEqual(["SIGNED_OUT", "SIGNED_IN", "SIGNED_OUT"]);
    expect(events.map((e) => e.hasSession)).toEqual([false, true, false]);
  });

  it("unsubscribe stops delivery", async () => {
    const events: string[] = [];
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    const sub = db.auth.onAuthStateChange((event) => events.push(event));
    sub.unsubscribe();
    await Promise.resolve();
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    expect(events).toHaveLength(0);
  });
});

describe("AuthClient.hydrate", () => {
  it("restores a session from storage", async () => {
    const storage = memoryStorageAdapter();
    storage.setItem(
      "excalibase.auth.session:acme/prod",
      JSON.stringify({
        accessToken: "restored",
        refreshToken: "rt",
        tokenType: "Bearer",
        expiresAt: Date.now() + 60_000,
        user: null,
      }),
    );
    const { fetch: f } = makeFetch({});
    const db = createClient({ ...baseOpts, storage, fetch: f });
    const restored = await db.auth.hydrate();
    expect(restored?.accessToken).toBe("restored");
    expect(db.auth.currentSession()?.accessToken).toBe("restored");
  });

  it("ignores malformed storage payloads", async () => {
    const storage = memoryStorageAdapter();
    storage.setItem("excalibase.auth.session:acme/prod", "not json {{{");
    const { fetch: f } = makeFetch({});
    const db = createClient({ ...baseOpts, storage, fetch: f });
    const restored = await db.auth.hydrate();
    expect(restored).toBeNull();
  });
});

describe("AuthClient api key CRUD", () => {
  it("createApiKey POSTs and returns the plaintext payload", async () => {
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
      "POST /auth/acme/prod/api-keys/": () => ({
        status: 201,
        body: {
          id: 1,
          plaintext: "esk_pub_live_secret",
          keyPrefix: "esk_pub_live",
          keyType: "publishable",
          name: "web",
          createdAt: "2026-04-15T00:00:00Z",
        },
      }),
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    const key = await db.auth.createApiKey({ name: "web", keyType: "publishable" });
    expect(key.plaintext).toBe("esk_pub_live_secret");
    expect(key.id).toBe(1);
  });

  it("listApiKeys unwraps the { keys } envelope", async () => {
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
      "GET /auth/acme/prod/api-keys/": () => ({
        body: {
          keys: [
            { id: 1, keyPrefix: "esk_pub_live_a", keyType: "publishable", name: "web", createdAt: "2026-04-15T00:00:00Z" },
            { id: 2, keyPrefix: "esk_sec_live_b", keyType: "secret", name: "cron", createdAt: "2026-04-15T00:00:00Z" },
          ],
        },
      }),
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    const keys = await db.auth.listApiKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]?.name).toBe("web");
  });

  it("revokeApiKey issues DELETE to the id path", async () => {
    let deleted = false;
    const { fetch: f } = makeFetch({
      "POST /auth/acme/prod/token": () => ({ body: passwordResponse() }),
      "DELETE /auth/acme/prod/api-keys/99": () => {
        deleted = true;
        return { status: 204, body: undefined };
      },
    });
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.signInWithPassword({ email: "a@b.c", password: "x" });
    await db.auth.revokeApiKey(99);
    expect(deleted).toBe(true);
  });
});
