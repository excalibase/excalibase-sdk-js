/**
 * One client per project: `createClient({ url, projectId, key })` takes the
 * platform's base URL and builds every service path the edge serves:
 *
 *   GraphQL + realtime WebSocket   {url}/{projectId}/graphql
 *   REST                           {url}/{projectId}/api/v1/...
 *   end-user auth                  {url}/auth/{orgSlug}/{projectId}/...
 *   functions (and storage)        {url}/functions/v1/{projectId}/{module}.{name}
 */
import { createClient, ConfigError } from "../src";
import { memoryStorageAdapter } from "../src/storage";

const URL_BASE = "https://api.example.test";
const KEY = "esk_pub_live_abcdefghijklmnop";

interface Call {
  url: string;
  method: string;
}

function recordingFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    let body: unknown = { data: { ok: true } };
    if (url.includes("/auth/")) {
      body = { accessToken: "jwt", refreshToken: "rt", tokenType: "Bearer", expiresIn: 3600 };
    } else if (url.endsWith("system.generateUploadUrl")) {
      body = { data: { url: "https://files.example.test/staging/u1", storageId: "s1", uploadId: "u1" } };
    } else if (url.startsWith("https://files.example.test")) {
      return new Response(null, { status: 200 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function client(extra: Record<string, unknown> = {}) {
  return createClient({
    url: URL_BASE,
    projectId: "proj-abc123",
    key: KEY,
    storage: memoryStorageAdapter(),
    autoRefreshToken: false,
    ...extra,
  });
}

describe("createClient({ url, projectId, key }) builds every service path", () => {
  it("names the project in the GraphQL, REST, functions and realtime paths", () => {
    const db = client();
    expect(db.projectId).toBe("proj-abc123");
    expect(db.graphqlEndpoint()).toBe(`${URL_BASE}/proj-abc123/graphql`);
    expect(db.restEndpoint("/products?select=id")).toBe(`${URL_BASE}/proj-abc123/api/v1/products?select=id`);
    expect(db.restEndpoint("products")).toBe(`${URL_BASE}/proj-abc123/api/v1/products`);
    expect(db.functionsEndpoint("system.generateUploadUrl")).toBe(
      `${URL_BASE}/functions/v1/proj-abc123/system.generateUploadUrl`,
    );
    expect(db.realtimeEndpoint()).toBe("wss://api.example.test/proj-abc123/graphql");
  });

  it("keeps a path prefix the platform is mounted under", () => {
    const db = client({ url: "http://localhost:8080/edge/" });
    expect(db.graphqlEndpoint()).toBe("http://localhost:8080/edge/proj-abc123/graphql");
    expect(db.realtimeEndpoint()).toBe("ws://localhost:8080/edge/proj-abc123/graphql");
  });

  it("routes auth by project id; the org segment defaults to the project id", () => {
    expect(client().authEndpoint("/token")).toBe(`${URL_BASE}/auth/proj-abc123/proj-abc123/token`);
    expect(client({ orgSlug: "acme" }).authEndpoint("token")).toBe(`${URL_BASE}/auth/acme/proj-abc123/token`);
  });

  it("sends each call to its service path", async () => {
    const { fetch, calls } = recordingFetch();
    const db = client({ fetch, orgSlug: "acme" });

    await db.auth.signInWithPassword({ email: "a@example.test", password: "pw-123456" });
    await db.graphql.query("{ __typename }");
    await db.rest.get("/products?select=id");
    await (db.functions as unknown as { shop: { ping: (a: unknown) => Promise<unknown> } }).shop.ping({});
    await db.storage.uploadViaFunctions(new Blob(["hi"], { type: "text/plain" }));

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${URL_BASE}/auth/acme/proj-abc123/token`,
      `POST ${URL_BASE}/proj-abc123/graphql`,
      `GET ${URL_BASE}/proj-abc123/api/v1/products?select=id`,
      `POST ${URL_BASE}/functions/v1/proj-abc123/shop.ping`,
      `POST ${URL_BASE}/functions/v1/proj-abc123/system.generateUploadUrl`,
      "PUT https://files.example.test/staging/u1",
      `POST ${URL_BASE}/functions/v1/proj-abc123/system.completeUpload`,
    ]);
  });
});

describe("older options", () => {
  it("still accepts publishableKey for the key", () => {
    const db = createClient({ url: URL_BASE, projectId: "proj-abc123", publishableKey: KEY });
    expect(db.publishableKey).toBe(KEY);
    expect(db.buildHeaders()["X-Excalibase-Publishable-Key"]).toBe(KEY);
  });

  it("reads the {orgSlug}/{projectId} form as the org and the project", () => {
    const db = createClient({ url: URL_BASE, projectId: "acme/proj-abc123", key: KEY });
    expect(db.projectId).toBe("proj-abc123");
    expect(db.orgSlug).toBe("acme");
    expect(db.graphqlEndpoint()).toBe(`${URL_BASE}/proj-abc123/graphql`);
    expect(db.authEndpoint("/token")).toBe(`${URL_BASE}/auth/acme/proj-abc123/token`);
    expect(db.functionsEndpoint("m.f")).toBe(`${URL_BASE}/functions/v1/proj-abc123/m.f`);
  });
});

describe("clear errors", () => {
  function message(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as Error).message;
    }
    throw new Error("expected a ConfigError");
  }

  it("names `key` when no key is given", () => {
    expect(message(() => createClient({ url: URL_BASE, projectId: "p1" } as never))).toMatch(/`key`/);
  });

  it("refuses two different keys", () => {
    expect(
      message(() => createClient({ url: URL_BASE, projectId: "p1", key: KEY, publishableKey: `${KEY}x` })),
    ).toMatch(/`key`/);
  });

  it("refuses a url that already names a service path", () => {
    for (const url of [`${URL_BASE}/graphql`, `${URL_BASE}/proj-abc123/graphql`, `${URL_BASE}/api/v1`]) {
      expect(message(() => client({ url }))).toMatch(/base URL/);
    }
  });

  it("refuses a url that already names the project", () => {
    expect(message(() => client({ url: `${URL_BASE}/proj-abc123` }))).toMatch(/`projectId`/);
  });

  it("refuses a project id that is not one path segment (or org/project)", () => {
    for (const projectId of ["a/b/c", "../x", "proj.1", "bad@id", "", "a".repeat(129)]) {
      expect(message(() => client({ projectId }))).toMatch(/`projectId`/);
    }
  });

  it("refuses an org slug that disagrees with the {org}/{project} form", () => {
    expect(message(() => client({ projectId: "acme/proj-abc123", orgSlug: "other" }))).toMatch(/`orgSlug`/);
    expect(message(() => client({ orgSlug: "bad org" }))).toMatch(/`orgSlug`/);
  });
});
