---
"@excalibase/sdk": minor
---

One client per project: `createClient({ url, projectId, key })` takes the platform's base URL and builds every service path the edge serves — GraphQL and REST at `/{projectId}/graphql` and `/{projectId}/api/v1`, end-user auth at `/auth/{orgSlug}/{projectId}`, functions and file uploads at `/functions/v1/{projectId}`. Apps no longer need a custom `fetch` that rewrites URLs.

- BREAKING: GraphQL and REST calls now name the project in the path (they went to `{url}/graphql` and `{url}/api/v1`, which the platform does not serve). A `projectId` of the form `"{orgSlug}/{projectId}"` is still read, as the org and the project, so `db.projectId` is now the project id alone; functions and uploads go to `/functions/v1/{projectId}`.
- BREAKING: `projectId` must be one path segment of letters, digits, `-` or `_` (or the `org/project` form); a `url` that already ends in a service path or in the project id is refused with a `ConfigError` saying what to pass.
- `key` is the new name of the API key option; `publishableKey` still works. `orgSlug` is an optional option (auth's org segment, defaulting to the project id).
- New: `db.graphql.subscribe(document, { next, error, complete }, variables)` for realtime over the project's WebSocket (graphql-transport-ws, token in `connection_init`), with a `WebSocket` option for runtimes without a global one; `db.functionsEndpoint(name)` and `db.realtimeEndpoint()`.
- `excalibase-codegen` requires `--project` and introspects `{url}/{project}/graphql`.
