/**
 * Phase 2 + Phase 7.1 codegen — turns the
 * `GET /api/projects/{projectId}/functions/_metadata` response into:
 *
 *   1. `functions.types.ts` — type-only `Functions` interface used as the
 *      second generic of `createClient<DB, F>`. Drives the Phase 2 surface
 *      `db.functions.<module>.<name>(args)`.
 *   2. `api.ts` (Phase 7.1) — a RUNTIME value module exporting an `api` and
 *      `internal` object graph. Each leaf is a literal
 *      `{ moduleName, exportName, kind }` annotated with
 *      `as FunctionRef<Args, unknown>`, so call sites like
 *      `ctx.runQuery(api.users.list, args)` are end-to-end typed.
 *
 * Internal exports (`internalQuery`/`internalMutation`/`internalAction`) are
 * routed to the `internal` namespace; public ones go to `api`. This matches
 * Convex's separation of "user-callable" vs "function-to-function" surfaces.
 *
 * `TResult` is still `unknown` (Phase 2 limitation). Return-type metadata
 * extraction lands in Phase 7.2 — requires the bundler to emit return-shape
 * JSON Schema alongside `argsJsonSchema`.
 */

import { compile, type JSONSchema } from "json-schema-to-typescript";

export type FunctionKind =
  | "query"
  | "mutation"
  | "action"
  | "internalQuery"
  | "internalMutation"
  | "internalAction";

const INTERNAL_KINDS: ReadonlySet<FunctionKind> = new Set<FunctionKind>([
  "internalQuery",
  "internalMutation",
  "internalAction",
]);

export interface FunctionExportMeta {
  /** Export name (e.g. `"list"`). */
  name: string;
  /** Tagged kind — public + internal variants. */
  kind: FunctionKind;
  /** JSON Schema for the `args` payload. */
  argsJsonSchema: JSONSchema;
}

export interface FunctionMeta {
  /** Server-side function id (filesystem key). */
  id: string;
  /** Module name — first path segment of the function URL. */
  name: string;
  runtimeShape: "v1" | "v2" | string;
  exports: FunctionExportMeta[];
  lastDeployedAt: string;
}

export type FunctionsMetadataResponse = FunctionMeta[];

const COMPILE_OPTS = {
  bannerComment: "",
  declareExternallyReferenced: false,
  enableConstEnums: false,
  format: false,
  strictIndexSignatures: false,
};

/** Capitalize first letter; rest unchanged. Used for type-name segments. */
function pascalSegment(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Lowercase + sanitize a path segment for use in a generated type name. */
function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/** `${Module}_${Export}_Args` — generated arg type name. */
function argsTypeName(moduleName: string, exportName: string): string {
  return `${pascalSegment(safeSegment(moduleName))}_${pascalSegment(safeSegment(exportName))}_Args`;
}

/** True iff the export should land in the `internal` graph rather than `api`. */
function isInternalKind(kind: FunctionKind): boolean {
  return INTERNAL_KINDS.has(kind);
}

/**
 * Compile each export's `argsJsonSchema` to TS. `json-schema-to-typescript`
 * emits a single `export interface <Name> { ... }` per call; we just
 * concatenate them. Schemas with no properties still produce a valid (empty)
 * interface.
 */
async function emitArgInterfaces(metadata: FunctionsMetadataResponse): Promise<string> {
  const chunks: string[] = [];
  for (const fn of metadata) {
    for (const exp of fn.exports) {
      const name = argsTypeName(fn.name, exp.name);
      // json-schema-to-typescript respects the schema's `title` for the
      // emitted interface name — set it explicitly so the output matches
      // what the Functions interface references below.
      const schema: JSONSchema = { ...exp.argsJsonSchema, title: name };
      const rendered = (await compile(schema, name, COMPILE_OPTS)).trim();
      chunks.push(rendered);
    }
  }
  return chunks.join("\n\n");
}

/**
 * Emit the `Functions` interface body — module → export → FunctionRef. ALL
 * exports (public + internal) are surfaced here so existing `db.functions`
 * callers continue to compile against the same generic.
 *
 * Modules with no exports render as `module: {};`.
 */
function emitFunctionsInterface(metadata: FunctionsMetadataResponse): string {
  const lines: string[] = ["export interface Functions {"];
  for (const fn of metadata) {
    if (fn.exports.length === 0) {
      lines.push(`  ${fn.name}: {};`);
      continue;
    }
    lines.push(`  ${fn.name}: {`);
    for (const exp of fn.exports) {
      const t = argsTypeName(fn.name, exp.name);
      lines.push(`    ${exp.name}: FunctionRef<${t}, unknown>;`);
    }
    lines.push("  };");
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Render the full `functions.types.ts` body. Imports `FunctionRef` from
 * `@excalibase/sdk` so callers can pass `Functions` as the second generic to
 * `createClient`.
 */
export async function emitFunctionsTypes(metadata: FunctionsMetadataResponse): Promise<string> {
  const argInterfaces = await emitArgInterfaces(metadata);
  const functionsInterface = emitFunctionsInterface(metadata);

  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @excalibase/sdk codegen — do not edit.");
  lines.push("// Run `npx excalibase-codegen functions` to regenerate.");
  lines.push("");
  lines.push('import type { FunctionRef } from "@excalibase/sdk";');
  lines.push("");
  if (argInterfaces.length > 0) {
    lines.push(argInterfaces);
    lines.push("");
  }
  lines.push(functionsInterface);
  lines.push("");
  return lines.join("\n");
}

export async function generateFunctionsFile(
  metadata: FunctionsMetadataResponse,
): Promise<string> {
  return emitFunctionsTypes(metadata);
}

// ============================================================================
// Phase 7.1 — `api.ts` value graph
// ============================================================================

/** One ref entry rendered as a JSON-ish literal with a `FunctionRef` cast. */
function emitRefLiteral(moduleName: string, exp: FunctionExportMeta, indent: string): string {
  const t = argsTypeName(moduleName, exp.name);
  return (
    `${indent}${exp.name}: { ` +
    `moduleName: "${moduleName}", ` +
    `exportName: "${exp.name}", ` +
    `kind: "${exp.kind}" ` +
    `} as FunctionRef<${t}, unknown>`
  );
}

/**
 * Emit `export const api = { ... } as const` (or `export const internal = ...`).
 * Renders only the exports matching the requested namespace.
 */
function emitNamespaceConst(
  metadata: FunctionsMetadataResponse,
  constName: "api" | "internal",
  wantInternal: boolean,
): string {
  const moduleBlocks: string[] = [];
  for (const fn of metadata) {
    const matching = fn.exports.filter((e) => isInternalKind(e.kind) === wantInternal);
    if (matching.length === 0) continue;
    const refLines = matching.map((exp) => emitRefLiteral(fn.name, exp, "    "));
    moduleBlocks.push(`  ${fn.name}: {\n${refLines.join(",\n")},\n  }`);
  }
  if (moduleBlocks.length === 0) {
    return `export const ${constName} = {} as const;`;
  }
  return `export const ${constName} = {\n${moduleBlocks.join(",\n")},\n} as const;`;
}

/**
 * Render the full `api.ts` body — the Phase 7.1 value graph.
 *
 * Layout:
 *   1. Header banner
 *   2. `import type { FunctionRef } from "@excalibase/sdk";`
 *   3. Per-export Args interfaces (compiled from JSON Schema)
 *   4. `export const api = { ... } as const;` (public exports)
 *   5. `export const internal = { ... } as const;` (internal exports)
 */
export async function emitApiFile(metadata: FunctionsMetadataResponse): Promise<string> {
  const argInterfaces = await emitArgInterfaces(metadata);
  const apiConst = emitNamespaceConst(metadata, "api", false);
  const internalConst = emitNamespaceConst(metadata, "internal", true);

  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @excalibase/sdk codegen — do not edit.");
  lines.push("// Run `npx excalibase-codegen functions` to regenerate.");
  lines.push("");
  lines.push('import type { FunctionRef } from "@excalibase/sdk";');
  lines.push("");
  if (argInterfaces.length > 0) {
    lines.push(argInterfaces);
    lines.push("");
  }
  lines.push(apiConst);
  lines.push("");
  lines.push(internalConst);
  lines.push("");
  return lines.join("\n");
}

export async function generateApiFile(
  metadata: FunctionsMetadataResponse,
): Promise<string> {
  return emitApiFile(metadata);
}
