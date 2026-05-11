# Changelog

All notable changes to `@excalibase/sdk`.

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
