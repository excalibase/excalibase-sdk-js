# Changelog

All notable changes to `@excalibase/sdk`.

## 0.4.0 — 2026-05-12

### BREAKING

- **Removed `db.nosql.collection(...)` and `db.collection(...)`.** The
  collection-style namespace and its top-level shortcut, deprecated in
  0.3.0, are gone. Migrate to typed functions via
  `db.functions.<module>.<name>(args)` — bundles can declare
  `schema.ts` for collection/index creation at deploy time, matching the
  Convex shape the rest of the SDK now follows.
- **Removed `db.init(schema)`.** Schema declaration moved to function
  bundles (`schema.ts`); admin/runbook flows that need a side-channel use
  the internal-only `POST /internal/nosql/schema/sync` endpoint on the
  graphql server.
- **Removed exports** `NoSqlNamespace`, `CollectionClient`,
  `defineSchema`, `defineCollection`, `resetNoSqlDeprecationWarning`,
  `SchemaDeclaration`, `CollectionDef`, `NoSqlIndexDef`, `FindOptions`,
  `UpdateOp`. They no longer have a backing surface on the server.

### Migration

```ts
// Before (0.3.x)
await db.nosql.collection("posts").insertOne({ title: "Hello" });
const posts = await db.nosql.collection("posts").find({ status: "draft" });

// After (0.4.x)
await db.functions.db.insert({ collection: "posts", doc: { title: "Hello" } });
const posts = await db.functions.db.find({
  collection: "posts",
  filter: { status: "draft" },
});
```

## 0.3.0 — 2026-05-11

### Added

- `db.functions.<module>.<name>(args)` — typed HTTP RPC namespace backed by a
  two-level `Proxy`. Each call POSTs to
  `${url}/functions/v1/${projectId}/${moduleName}.${exportName}` with
  `{ args }`. The response `{ data }` is unwrapped; `{ error, issues? }`
  throws `FunctionsError`.
- `createClient<Database, Functions>` — second generic for the new
  `db.functions` namespace. Defaults to `DefaultFunctions` (any module/export).
  Pair with codegen output for full call-signature types.
- `excalibase-codegen functions` — new CLI subcommand. Reads
  `GET /api/projects/{projectId}/functions/_metadata` and emits
  `functions.types.ts` mapping `module → export → FunctionRef<Args, unknown>`.
  Args interfaces are compiled from each export's `argsJsonSchema` via
  `json-schema-to-typescript`.
- `FunctionsNamespace`, `FunctionsError`, `FunctionRef`, `DefaultFunctions`,
  `ValidationIssue` — public types re-exported from `index`.

### Deprecated

- `db.nosql.collection(...)` and `db.collection(...)` now emit a one-shot
  `console.warn` pointing to `db.functions`. The collection API itself
  remains functional — removal is scheduled for the next major release.

### Notes

- `TResult` on `FunctionRef<TArgs, TResult>` is `unknown` for this release;
  return-type metadata lands once the runtime starts emitting it.
- `json-schema-to-typescript` moved from `devDependencies` to `dependencies`
  so `npx excalibase-codegen functions` resolves it at user dev time.
