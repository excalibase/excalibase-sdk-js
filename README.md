# @excalibase/sdk

Official TypeScript client for [Excalibase](https://github.com/excalibase/excalibase-graphql) —
auto-generated GraphQL + REST APIs over PostgreSQL and MySQL.

- Works in both browser and Node.js (≥18)
- Persistent session with automatic refresh before JWT expiry
- Password login, publishable/secret API keys, OAuth2-style `/token` flow
- First-class typings for the full-text search (`search` / `webSearch`) and
  pgvector k-NN (`vector`) operators exposed by excalibase-graphql

## Install

```bash
npm install @excalibase/sdk graphql-request
```

## API shape

Two raw surfaces, no query-builder, no RPC wrapper — you write GraphQL or REST
directly and the SDK handles auth, session, and error wrapping:

```ts
// GraphQL
await db.graphql.query<T>("{ kanbanIssues(limit: 5) { id title } }");
await db.graphql.mutation<T>(`
  mutation ($input: CreateKanbanIssueInput!) {
    createKanbanIssue(input: $input) { id }
  }
`, { input: { title: "x" } });

// REST (PostgREST-compatible)
await db.rest.get<T>("/issues?select=id,title&limit=5");
await db.rest.post<T>("/issues", { title: "x" });
await db.rest.patch<T>("/issues?id=eq.1", { title: "y" });
await db.rest.put<T>("/issues?id=eq.1", full);
await db.rest.delete("/issues?id=eq.1");
```

Both namespaces automatically fold in the current session's bearer token +
publishable key headers, wrap 401/403 in `AuthError`, and wrap other failures
in `NetworkError`. Pick `db.graphql` for shape control / nested projections /
TS codegen; pick `db.rest` for HTTP-cacheable URLs / `Prefer: count=exact`
pagination / piping through CDNs.

## Quick start

```ts
import { createClient } from "@excalibase/sdk";

const db = createClient({
  url: "http://localhost:10000",
  projectId: "acme/prod",               // "{orgSlug}/{projectName}"
  publishableKey: "esk_pub_live_...",   // safe to ship in browser bundles
});

// 1. Password login (email/password user)
await db.auth.signInWithPassword({
  email: "alice@example.com",
  password: "s3cret",
});

// 2. Anonymous API-key login (no user, scope="public")
await db.auth.signInWithApiKey();

// 3. Run a GraphQL query with the current session
const data = await db.graphql.query<{ hanaCustomer: Array<{ first_name: string }> }>(`
  { hanaCustomer(limit: 5) { first_name last_name email } }
`);

// 4. React to auth state changes
const { unsubscribe } = db.auth.onAuthStateChange((event, session) => {
  console.log(event, session?.user?.email ?? "anon");
});
```

## Security

Secret keys (`esk_sec_live_*`) are **rejected** if the SDK is initialized in
a browser context. Secret keys must only be used server-side.

```ts
// This throws ConfigError in a browser:
createClient({ ..., publishableKey: "esk_sec_live_..." });
```

## Full-text and vector search

Excalibase exposes both as native GraphQL arguments on tables with `tsvector`
or `pgvector` columns. The SDK has no special wrappers — just use the native
GraphQL surface:

```ts
// Plain search (safe for any user input)
await db.graphql.query(`
  { kanbanIssues(where: { search_vec: { search: "stripe payment" } }) {
      id title
  } }
`);

// Google-style search (quoted phrases, OR, -exclusion)
await db.graphql.query(`
  { kanbanIssues(where: { search_vec: { webSearch: "stripe OR benchmarks -refund" } }) {
      id title
  } }
`);

// Vector k-NN (pgvector)
await db.graphql.query(`
  { kanbanIssues(vector: {
      column: "embedding"
      near: [0.12, -0.34, 0.87]
      distance: "COSINE"
      limit: 5
  }) { id title } }
`);
```

See the [excalibase-graphql search & vector guide](https://github.com/excalibase/excalibase-graphql/blob/main/docs/features/search-and-vector.md) for the full operator reference.

## API key management

Authenticated users can mint and revoke API keys for the current project:

```ts
// Requires an authenticated session (password login)
await db.auth.signInWithPassword({ email, password });

const created = await db.auth.createApiKey({
  name: "web-frontend",
  keyType: "publishable",   // or "secret"
});
console.log("Save this once, never again:", created.plaintext);

const keys = await db.auth.listApiKeys();
await db.auth.revokeApiKey(created.id);
```

## Session persistence

By default the SDK stores the session in `localStorage` when a browser is
detected, and in memory otherwise. Pass a custom `StorageAdapter` to integrate
with secure storage:

```ts
import { createClient, memoryStorageAdapter } from "@excalibase/sdk";

const db = createClient({
  url: "...",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_...",
  storage: memoryStorageAdapter(),  // or your own { getItem, setItem, removeItem }
});
```

## License

Apache-2.0
