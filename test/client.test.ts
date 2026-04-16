import { createClient, ConfigError, DbClient, AuthError } from "../src";
import { memoryStorageAdapter } from "../src/storage";

describe("createClient", () => {
  const validOpts = {
    url: "http://localhost:10000",
    projectId: "acme/prod",
    publishableKey: "esk_pub_live_abcdefghijklmnop",
    storage: memoryStorageAdapter(),
    autoRefreshToken: false,
  };

  it("returns a DbClient with the given configuration", () => {
    const db = createClient(validOpts);
    expect(db).toBeInstanceOf(DbClient);
    expect(db.url).toBe("http://localhost:10000");
    expect(db.orgSlug).toBe("acme");
    expect(db.projectName).toBe("prod");
  });

  it("strips trailing slash from url", () => {
    const db = createClient({ ...validOpts, url: "http://localhost:10000/" });
    expect(db.url).toBe("http://localhost:10000");
  });

  it("derives graphql, rest, and auth endpoints from url + projectId", () => {
    const db = createClient(validOpts);
    expect(db.graphqlEndpoint()).toBe("http://localhost:10000/graphql");
    expect(db.restEndpoint("/issues")).toBe("http://localhost:10000/api/v1/issues");
    expect(db.restEndpoint("issues")).toBe("http://localhost:10000/api/v1/issues");
    expect(db.authEndpoint("/token")).toBe("http://localhost:10000/auth/acme/prod/token");
    expect(db.authEndpoint("token")).toBe("http://localhost:10000/auth/acme/prod/token");
  });

  it("throws ConfigError when url is missing", () => {
    expect(() => createClient({ ...validOpts, url: "" })).toThrow(ConfigError);
  });

  it("throws ConfigError when url scheme is not http/https", () => {
    expect(() => createClient({ ...validOpts, url: "ftp://nope" })).toThrow(ConfigError);
  });

  it("throws ConfigError when projectId is malformed", () => {
    expect(() => createClient({ ...validOpts, projectId: "acme" })).toThrow(ConfigError);
    expect(() => createClient({ ...validOpts, projectId: "acme/prod/extra" })).toThrow(ConfigError);
  });

  it("throws ConfigError when publishableKey is empty", () => {
    expect(() => createClient({ ...validOpts, publishableKey: "" })).toThrow(ConfigError);
  });

  describe("secret key rejection in browser context", () => {
    beforeEach(() => {
      (globalThis as unknown as { window?: object }).window = {} as object;
    });
    afterEach(() => {
      delete (globalThis as unknown as { window?: object }).window;
    });

    it("throws ConfigError if a secret key is used in browser context", () => {
      expect(() =>
        createClient({
          ...validOpts,
          publishableKey: "esk_sec_live_shouldneverbeinbrowser",
        }),
      ).toThrow(ConfigError);
    });

    it("allows publishable keys in browser context", () => {
      const db = createClient(validOpts);
      expect(db).toBeInstanceOf(DbClient);
    });
  });

  it("allows secret keys in node (server) context", () => {
    const db = createClient({
      ...validOpts,
      publishableKey: "esk_sec_live_serverside_ok_here",
    });
    expect(db).toBeInstanceOf(DbClient);
  });

  it("rejects obviously malformed keys that are short", () => {
    expect(() =>
      createClient({ ...validOpts, publishableKey: "nope" }),
    ).toThrow(ConfigError);
  });

  it("buildHeaders includes publishable key and (when present) bearer token", async () => {
    const db = createClient(validOpts);
    const anon = db.buildHeaders();
    expect(anon["X-Excalibase-Publishable-Key"]).toBe(validOpts.publishableKey);
    expect(anon["Authorization"]).toBeUndefined();

    // Manually install a session to check Authorization header folding.
    (db.auth as unknown as { session: unknown }).session = {
      accessToken: "jwt-xyz",
      refreshToken: null,
      tokenType: "Bearer",
      expiresAt: Date.now() + 60_000,
      user: null,
    };
    const auth = db.buildHeaders();
    expect(auth["Authorization"]).toBe("Bearer jwt-xyz");
  });

  it("wraps 401/403 REST responses as AuthError", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 401 });
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await expect(db.rest.get("/issues")).rejects.toBeInstanceOf(AuthError);
  });

  it("exposes db.graphql and db.rest namespaces", () => {
    const db = createClient(validOpts);
    expect(typeof db.graphql.query).toBe("function");
    expect(typeof db.graphql.mutation).toBe("function");
    expect(typeof db.rest.get).toBe("function");
    expect(typeof db.rest.post).toBe("function");
    expect(typeof db.rest.patch).toBe("function");
    expect(typeof db.rest.put).toBe("function");
    expect(typeof db.rest.delete).toBe("function");
  });

  it("wraps 500 REST responses as NetworkError and preserves server message", async () => {
    const { NetworkError } = await import("../src/errors");
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "internal boom" }), { status: 500 });
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await expect(db.rest.get("/issues")).rejects.toBeInstanceOf(NetworkError);
  });

  it("handles REST responses with empty body", async () => {
    const mockFetch: typeof fetch = async () => new Response(null, { status: 204 });
    const db = createClient({ ...validOpts, fetch: mockFetch });
    const out = await db.rest.delete("/issues/1");
    expect(out).toBeNull();
  });

  it("POSTs JSON body and passes it through", async () => {
    let capturedBody: BodyInit | null | undefined;
    const mockFetch: typeof fetch = async (_input, init = {}) => {
      capturedBody = init.body;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await db.rest.post("/issues", { title: "t" });
    expect(capturedBody).toBe(JSON.stringify({ title: "t" }));
  });

  it("db.rest.patch / put / delete dispatch the right verb", async () => {
    const methods: string[] = [];
    const mockFetch: typeof fetch = async (_input, init = {}) => {
      methods.push(init.method ?? "GET");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await db.rest.patch("/issues/1", { title: "a" });
    await db.rest.put("/issues/1", { title: "b" });
    await db.rest.delete("/issues/1");
    expect(methods).toEqual(["PATCH", "PUT", "DELETE"]);
  });

  it("db.graphql.query and db.graphql.mutation both dispatch", async () => {
    const bodies: string[] = [];
    const mockFetch: typeof fetch = async (_input, init = {}) => {
      bodies.push(init.body as string);
      return new Response(JSON.stringify({ data: { __typename: "Query" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await db.graphql.query("{ __typename }");
    await db.graphql.mutation("mutation { x: __typename }");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("__typename");
    expect(bodies[1]).toContain("mutation");
  });

  it("throws ConfigError when no global fetch is available and none is passed", () => {
    const savedFetch = globalThis.fetch;
    // @ts-expect-error — force unavailable fetch for this assertion
    globalThis.fetch = undefined;
    try {
      expect(() =>
        createClient({ ...validOpts, fetch: undefined as unknown as typeof fetch }),
      ).toThrow(ConfigError);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("wraps REST network failures as NetworkError", async () => {
    const { NetworkError } = await import("../src/errors");
    const mockFetch: typeof fetch = async () => {
      throw new Error("econnrefused");
    };
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await expect(db.rest.get("/issues")).rejects.toBeInstanceOf(NetworkError);
  });

  it("graphqlClient() returns a configured GraphQLClient", () => {
    const db = createClient(validOpts);
    const client = db.graphqlClient();
    expect(client).toBeDefined();
    expect(typeof (client as { request: unknown }).request).toBe("function");
  });

  it("request() wraps fetch errors as NetworkError", async () => {
    const { NetworkError } = await import("../src/errors");
    const mockFetch: typeof fetch = async () => {
      throw new Error("boom");
    };
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await expect(db.graphql.query("{ __typename }")).rejects.toBeInstanceOf(NetworkError);
  });

  it("request() wraps 401 as AuthError", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    const db = createClient({ ...validOpts, fetch: mockFetch });
    await expect(db.graphql.query("{ __typename }")).rejects.toBeInstanceOf(AuthError);
  });
});
