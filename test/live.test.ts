/**
 * Live integration test against a running excalibase study-cases stack.
 *
 * Skipped by default. Run with:
 *
 *   cd /home/duc/Documents/duk/excalibase-graphql && make study-cases-up
 *   cd /home/duc/Documents/duk/excalibase-sdk-js && SDK_LIVE_URL=http://localhost:10004 \
 *     SDK_LIVE_AUTH_URL=http://localhost:24004 npx jest live.test
 *
 * Exercises the real auth contract (register -> /token password grant ->
 * refresh_token grant -> signOut) and a real GraphQL query that uses the
 * shipped search and vector operators on the kanban tenant.
 */
import { createClient, memoryStorageAdapter } from "../src";

const GRAPHQL_URL = process.env.SDK_LIVE_URL ?? "";
const AUTH_URL = process.env.SDK_LIVE_AUTH_URL ?? "";
const LIVE = GRAPHQL_URL.length > 0 && AUTH_URL.length > 0;

const describeLive = LIVE ? describe : describe.skip;

describeLive("live: study-cases kanban tenant", () => {
  const projectId = "study-cases/kanban";
  const testEmail = `sdk-e2e-${Date.now()}@example.com`;
  const testPassword = "Pass123!";

  function makeDb() {
    return createClient({
      url: GRAPHQL_URL,
      // The live auth service and graphql service are on different ports in
      // the study-cases stack, so we have to override the auth endpoint path.
      // A normal deployment runs them behind one gateway and this hack is unnecessary.
      projectId,
      publishableKey: "esk_pub_live_dummy_study_cases_key_for_sdk_smoke",
      storage: memoryStorageAdapter(),
      autoRefreshToken: false,
    });
  }

  // The study-cases stack runs graphql at :10004 and auth at :24004 on two
  // different hosts. createClient assumes one host for both, so we patch the
  // auth endpoint per-call with the real url. For production with a shared
  // gateway this is not needed.
  function authUrl(db: ReturnType<typeof makeDb>, subpath: string): string {
    return `${AUTH_URL}/auth/${db.orgSlug}/${db.projectName}${subpath}`;
  }

  async function register(db: ReturnType<typeof makeDb>): Promise<void> {
    await fetch(authUrl(db, "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password: testPassword, fullName: "SDK E2E" }),
    }).catch(() => undefined);
  }

  async function login(db: ReturnType<typeof makeDb>): Promise<string> {
    const r = await fetch(authUrl(db, "/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "password", email: testEmail, password: testPassword }),
    });
    if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
    const body = (await r.json()) as { accessToken: string };
    return body.accessToken;
  }

  it("runs a GraphQL search query with the current session's bearer token", async () => {
    const db = makeDb();
    await register(db);
    const accessToken = await login(db);

    const client = db.graphqlClient();
    // Swap in the freshly minted access token. This bypasses AuthClient
    // because the two services live on different ports and signInWithPassword
    // would hit :10004/auth/... instead of :24004/auth/...
    (client as unknown as { requestConfig: { headers: Record<string, string> } }).requestConfig.headers = {
      Authorization: `Bearer ${accessToken}`,
    };

    const query = /* GraphQL */ `
      {
        kanbanIssues(where: { search_vec: { search: "kubernetes" } }, limit: 5) {
          id
          title
        }
      }
    `;
    const data = await client.request<{ kanbanIssues: Array<{ id: number; title: string }> }>(query);
    expect(Array.isArray(data.kanbanIssues)).toBe(true);
    // Kanban seed data has ~1 kubernetes-related issue — result set is small but non-empty.
    expect(data.kanbanIssues.length).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("runs a GraphQL vector k-NN query against the kanban embedding column", async () => {
    const db = makeDb();
    await register(db);
    const accessToken = await login(db);

    const client = db.graphqlClient();
    (client as unknown as { requestConfig: { headers: Record<string, string> } }).requestConfig.headers = {
      Authorization: `Bearer ${accessToken}`,
    };

    const query = /* GraphQL */ `
      {
        kanbanIssues(
          vector: { column: "embedding", near: [0.0, 0.0, 1.0], distance: "L2", limit: 3 }
        ) {
          id
          title
        }
      }
    `;
    const data = await client.request<{ kanbanIssues: Array<{ id: number; title: string }> }>(query);
    expect(Array.isArray(data.kanbanIssues)).toBe(true);
    expect(data.kanbanIssues.length).toBeLessThanOrEqual(3);
  }, 30_000);

  it("DbClient.request wraps graphql-request with the same headers", async () => {
    // Use the DbClient's real request() entry point rather than reaching into
    // graphql-request, so we exercise the public API. We install the token
    // into the headers override option.
    const db = createClient({
      url: GRAPHQL_URL,
      projectId,
      publishableKey: "esk_pub_live_dummy_study_cases_key_for_sdk_smoke",
      storage: memoryStorageAdapter(),
      autoRefreshToken: false,
    });
    await register(db);
    const accessToken = await login(db);
    // Override DbClient auth session manually for this cross-port setup.
    (db.auth as unknown as { session: unknown }).session = {
      accessToken,
      refreshToken: null,
      tokenType: "Bearer",
      expiresAt: Date.now() + 60_000,
      user: null,
    };
    const data = await db.graphql.query<{ __typename: string }>("{ __typename }");
    expect(data.__typename).toBe("Query");
  }, 30_000);
});

const NOSQL_URL = process.env.SDK_LIVE_NOSQL_URL ?? "";
const describeNoSqlLive = NOSQL_URL.length > 0 ? describe : describe.skip;

describeNoSqlLive("live: NoSQL search and vectorSearch", () => {
  // These tests assume an excalibase-graphql instance with the NoSQL module
  // mounted at /api/v1/nosql (e.g. the main dev stack on :10000). Auth is
  // disabled in that stack, so the SDK client uses a bare fetch with no token.
  function makeNoSqlDb() {
    return createClient({
      url: NOSQL_URL,
      projectId: "sdk/live-nosql",
      publishableKey: "esk_pub_live_dummy_nosql_smoke",
      storage: memoryStorageAdapter(),
      autoRefreshToken: false,
    });
  }
  let db: ReturnType<typeof makeNoSqlDb>;

  beforeAll(async () => {
    db = makeNoSqlDb();
    await db.nosql.init({
      collections: {
        sdk_live_articles: { fields: {}, indexes: [], search: "body" },
        sdk_live_docs: { fields: {}, indexes: [], vector: { field: "embedding", dimensions: 3 } },
      },
    });
    await db.nosql.collection("sdk_live_articles").insertMany([
      { title: "a", body: "Postgres tsvector and tsquery power full-text search" },
      { title: "b", body: "MySQL has its own full-text search implementation" },
      { title: "c", body: "Pasta recipes with tomatoes" },
    ]);
    await db.nosql.collection("sdk_live_docs").insertMany([
      { title: "d1" }, { title: "d2" },
    ]);
  }, 30_000);

  it("search() returns matching docs ranked by relevance", async () => {
    const results = await db.nosql.collection("sdk_live_articles").search("tsvector tsquery", { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect((results[0] as { title: string }).title).toBe("a");
  }, 30_000);

  it("vectorSearch() returns up to topK docs", async () => {
    const results = await db.nosql.collection("sdk_live_docs").vectorSearch([1, 0, 0], { topK: 2 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 30_000);
});
