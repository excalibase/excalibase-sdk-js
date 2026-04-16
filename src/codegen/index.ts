/**
 * Codegen — turns a GraphQL IntrospectionQuery result into a typed
 * `database.types.ts` file: per-table `Row` interfaces, per-enum union types,
 * a `Database` interface for the `createClient<Database>` generic, and a
 * runtime `schema: SchemaMeta` const so the query builder can serialize
 * filter values correctly without a server round trip.
 *
 * Library entry points: {@link parseIntrospection}, {@link emitDatabaseTypes},
 * {@link generateDatabaseFile}. The CLI binary at `src/bin/codegen.ts` wraps
 * these and writes the result to disk.
 */

export interface CodegenOptions {
  /**
   * Multi-schema prefixes used by the running excalibase server (e.g.
   * `["kanban", "ecommerce"]`). When a Query field starts with one of these
   * prefixes, the codegen splits it into `profile = prefix` and
   * `table = snake_case(suffix)`. Pass `[]` for single-schema (public) servers.
   */
  schemas?: string[];
}

export interface IntrospectedColumn {
  name: string;
  tsType: string;
  nullable: boolean;
  isEnum: boolean;
}

export interface IntrospectedTable {
  field: string;
  rowTypeName: string;
  rowInterfaceName: string;
  columns: IntrospectedColumn[];
  enumColumns: string[];
  rest: { table: string; profile?: string };
}

export interface IntrospectedEnum {
  name: string;
  members: string[];
}

export interface IntrospectedSchema {
  tables: IntrospectedTable[];
  enums: IntrospectedEnum[];
}

// ---------- Introspection JSON shape (subset we read) ----------

interface RawTypeRef {
  kind: string;
  name?: string | null;
  ofType?: RawTypeRef | null;
}

interface RawField {
  name: string;
  type: RawTypeRef;
  args?: Array<{ name: string; type: RawTypeRef }>;
}

interface RawEnumValue { name: string }

interface RawType {
  kind: string;
  name: string;
  fields?: RawField[];
  enumValues?: RawEnumValue[];
}

interface RawIntrospection {
  __schema: {
    queryType?: { name: string };
    types: RawType[];
  };
}

// ---------- Parsing ----------

export function parseIntrospection(
  introspection: unknown,
  opts: CodegenOptions = {},
): IntrospectedSchema {
  const schemas = (opts.schemas ?? []).slice().sort((a, b) => b.length - a.length);
  const root = (introspection as RawIntrospection).__schema;
  if (root == null) throw new Error("introspection JSON is missing __schema");

  const typesByName = new Map<string, RawType>();
  for (const t of root.types) typesByName.set(t.name, t);

  const queryTypeName = root.queryType?.name ?? "Query";
  const queryType = typesByName.get(queryTypeName);
  if (queryType == null || !queryType.fields) {
    throw new Error(`introspection has no Query type "${queryTypeName}"`);
  }

  // First pass — collect enum types so the column extractor can flag them.
  const enums: IntrospectedEnum[] = [];
  const enumNames = new Set<string>();
  for (const t of root.types) {
    if (t.kind !== "ENUM") continue;
    if (t.name.startsWith("__")) continue;
    enums.push({ name: t.name, members: (t.enumValues ?? []).map((v) => v.name) });
    enumNames.add(t.name);
  }

  // Second pass — table fields on Query.
  const tables: IntrospectedTable[] = [];
  for (const f of queryType.fields) {
    if (f.name.startsWith("__")) continue;
    if (f.name.endsWith("Aggregate") || f.name.endsWith("Connection")) continue;
    const objectName = unwrapListObject(f.type);
    if (objectName == null) continue;
    const rowType = typesByName.get(objectName);
    if (rowType == null || rowType.kind !== "OBJECT") continue;
    if (rowType.name === "Query" || rowType.name === "Mutation") continue;

    const columns = extractColumns(rowType, enumNames);
    if (columns.length === 0) continue;
    const enumCols = columns.filter((c) => c.isEnum).map((c) => c.name).sort();

    tables.push({
      field: f.name,
      rowTypeName: objectName,
      rowInterfaceName: `${objectName}Row`,
      columns,
      enumColumns: enumCols,
      rest: deriveRestMapping(f.name, schemas),
    });
  }

  return { tables: tables.sort((a, b) => a.field.localeCompare(b.field)), enums };
}

function unwrapListObject(ref: RawTypeRef | null | undefined): string | null {
  // Look for [<Object>!]! shape — strip NON_NULL and LIST wrappers.
  let t: RawTypeRef | null | undefined = ref;
  while (t != null && (t.kind === "NON_NULL" || t.kind === "LIST")) {
    if (t.kind === "LIST") {
      // After unwrapping LIST, the inner must be the row type
      let inner: RawTypeRef | null | undefined = t.ofType;
      while (inner != null && inner.kind === "NON_NULL") inner = inner.ofType;
      if (inner != null && inner.kind === "OBJECT" && typeof inner.name === "string") return inner.name;
      return null;
    }
    t = t.ofType;
  }
  return null;
}

function extractColumns(rowType: RawType, enumNames: Set<string>): IntrospectedColumn[] {
  if (!rowType.fields) return [];
  const cols: IntrospectedColumn[] = [];
  for (const f of rowType.fields) {
    if (f.name.startsWith("__")) continue;
    const info = resolveColumnType(f.type, enumNames);
    if (info == null) continue;
    cols.push({ name: f.name, ...info });
  }
  return cols;
}

interface ColumnTypeInfo { tsType: string; nullable: boolean; isEnum: boolean }

function resolveColumnType(ref: RawTypeRef, enumNames: Set<string>): ColumnTypeInfo | null {
  // Skip nested OBJECT fields (FK relationships) — only emit scalar/enum columns.
  let nullable = true;
  let t: RawTypeRef | null | undefined = ref;
  if (t.kind === "NON_NULL") {
    nullable = false;
    t = t.ofType;
  }
  if (t == null) return null;
  if (t.kind === "LIST") return null; // list-typed column — not supported in v0.1 Row codegen
  if (t.kind === "OBJECT") return null; // nested relationship, not a scalar column
  if (t.kind === "ENUM" && t.name) {
    return { tsType: t.name, nullable, isEnum: enumNames.has(t.name) };
  }
  if (t.kind === "SCALAR" && t.name) {
    return { tsType: scalarToTs(t.name), nullable, isEnum: false };
  }
  return null;
}

function scalarToTs(scalar: string): string {
  switch (scalar) {
    case "Int":
    case "Float":
    case "BigInt":
      return "number";
    case "Boolean":
      return "boolean";
    case "ID":
    case "String":
    case "Date":
    case "DateTime":
    case "Time":
    case "JSON":
    case "JSONObject":
      return "string";
    default:
      // Unknown scalars become `string` — safe default for v0.1
      return "string";
  }
}

function deriveRestMapping(field: string, schemas: string[]): { table: string; profile?: string } {
  for (const prefix of schemas) {
    if (!field.startsWith(prefix)) continue;
    const suffix = field.slice(prefix.length);
    if (suffix.length === 0) continue;
    // Suffix is upperCamelCase (e.g. "Issues") — convert to snake_case
    const table = camelToSnake(suffix);
    return { table, profile: prefix };
  }
  // No prefix matched — treat the whole field as the table name.
  return { table: camelToSnake(field) };
}

function camelToSnake(s: string): string {
  if (s.length === 0) return s;
  // Lowercase the leading char so "Issues" → "issues"
  const head = s[0]!.toLowerCase() + s.slice(1);
  return head.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

// ---------- Emission ----------

export function emitDatabaseTypes(parsed: IntrospectedSchema): string {
  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @excalibase/sdk codegen — do not edit.");
  lines.push("// Run `npx excalibase-codegen` to regenerate.");
  lines.push("");
  lines.push('import type { SchemaMeta } from "@excalibase/sdk";');
  lines.push("");

  // Per-enum union types
  for (const e of parsed.enums) {
    const members = e.members.map((m) => JSON.stringify(m)).join(" | ");
    lines.push(`export type ${e.name} = ${members};`);
  }
  if (parsed.enums.length > 0) lines.push("");

  // Per-table Row interfaces
  for (const t of parsed.tables) {
    lines.push(`export interface ${t.rowInterfaceName} {`);
    for (const col of t.columns) {
      const nullSuffix = col.nullable ? " | null" : "";
      lines.push(`  ${col.name}: ${col.tsType}${nullSuffix};`);
    }
    lines.push("}");
    lines.push("");
  }

  // Database interface
  lines.push("export interface Database {");
  for (const t of parsed.tables) {
    lines.push(`  ${t.field}: {`);
    lines.push(`    Row: ${t.rowInterfaceName};`);
    lines.push(`    Rest: ${restTypeLiteral(t.rest)};`);
    lines.push(`  };`);
  }
  lines.push("}");
  lines.push("");

  // Runtime schema const
  lines.push("export const schema: SchemaMeta = {");
  for (const t of parsed.tables) {
    lines.push(`  ${t.field}: {`);
    lines.push(`    field: ${JSON.stringify(t.field)},`);
    lines.push(`    enumColumns: ${formatStringArray(t.enumColumns)},`);
    lines.push(`    rest: ${restValueLiteral(t.rest)},`);
    lines.push(`  },`);
  }
  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

function restTypeLiteral(r: { table: string; profile?: string }): string {
  if (r.profile != null) {
    return `{ table: ${JSON.stringify(r.table)}; profile: ${JSON.stringify(r.profile)} }`;
  }
  return `{ table: ${JSON.stringify(r.table)} }`;
}

function formatStringArray(arr: readonly string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map((s) => JSON.stringify(s)).join(", ")}]`;
}

function restValueLiteral(r: { table: string; profile?: string }): string {
  if (r.profile != null) {
    return `{ table: ${JSON.stringify(r.table)}, profile: ${JSON.stringify(r.profile)} }`;
  }
  return `{ table: ${JSON.stringify(r.table)} }`;
}

export function generateDatabaseFile(introspection: unknown, opts: CodegenOptions = {}): string {
  return emitDatabaseTypes(parseIntrospection(introspection, opts));
}
