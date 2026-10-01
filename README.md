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
  url: "https://api.example.com",   // the platform's base URL
  projectId: "proj-a1b2c3d4e5",     // the project's id
  key: "esk_pub_live_...",          // publishable key: safe to ship in browser bundles
});

// 1. Password login (email/password user)
await db.auth.signInWithPassword({
  email: "alice@example.com",
  password: "s3cret",
});

// 2. Anonymous API-key login (no user, role "anon")
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

## One client per project

`url` is the platform's base URL, with no project and no service path. The
client builds every path from it and the project id, the way the platform's
edge routes them:

| Surface | Path |
|---|---|
| GraphQL (`db.graphql`, `db.from`) | `{url}/{projectId}/graphql` |
| Realtime (`db.graphql.subscribe`) | `ws(s)://{host}/{projectId}/graphql` |
| REST (`db.rest`) | `{url}/{projectId}/api/v1/...` |
| End-user auth (`db.auth`) | `{url}/auth/{orgSlug}/{projectId}/...` |
| Functions and file uploads (`db.functions`, `db.storage`) | `{url}/functions/v1/{projectId}/{module}.{name}` |

`orgSlug` is optional: auth finds the project by its id, so the org segment
defaults to the project id. `db.graphqlEndpoint()`, `db.restEndpoint(path)`,
`db.authEndpoint(path)`, `db.functionsEndpoint(name)` and
`db.realtimeEndpoint()` return the URLs the client uses.

Older options still work: `publishableKey` is read as `key`, and a
`projectId` of the form `"{orgSlug}/{projectId}"` is read as the org and the
project. A `url` that already ends in a service path (`/graphql`, `/api/v1`)
or in the project id is refused with a `ConfigError` that says what to pass
instead.

## Realtime

`db.graphql.subscribe` opens the project's WebSocket (graphql-transport-ws)
and sends the session's token in `connection_init`; each change reaches only
callers whose permissions cover the row. Turn realtime on for the table in
the project first.

```ts
const sub = db.graphql.subscribe<{ publicOrdersChanges: { operation: string; data: unknown } }>(
  "subscription { publicOrdersChanges { operation table data } }",
  {
    next: (data) => console.log(data.publicOrdersChanges),
    error: (err) => console.warn("updates stopped", err),
  },
);
// later
sub.unsubscribe();
```

Browsers and Node 22+ have a global `WebSocket`. On older Node pass one:
`createClient({ ..., WebSocket })` with `import WebSocket from "ws"`.

## Security

Secret keys (`esk_sec_live_*`) are **rejected** if the SDK is initialized in
a browser context. Secret keys must only be used server-side.

```ts
// This throws ConfigError in a browser:
createClient({ ..., key: "esk_sec_live_..." });
```

## Roles

Every request runs as one role, and the project's permissions for that role
decide which tables, columns, rows and functions exist for it:

- no session, or a publishable-key session (`signInWithApiKey()`): `anon`
- a signed-in account: its role (`user` unless the project gave the account
  another one)
- a secret-key session (server-side only): `service`, which bypasses
  permissions

A token that allows more than one role can pick one per client with the
`X-Excalibase-Role` header; a role the token does not allow is refused with
403 `role_not_allowed`.

```ts
const editor = createClient({ ..., headers: { "X-Excalibase-Role": "editor" } });
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
  url: "https://api.example.com",
  projectId: "proj-a1b2c3d4e5",
  key: "esk_pub_live_...",
  storage: memoryStorageAdapter(),  // or your own { getItem, setItem, removeItem }
});
```

## License

Apache-2.0
