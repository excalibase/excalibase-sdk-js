import type { DbClient } from "./client";
import { ConfigError } from "./errors";

/**
 * `db.from(table)` — fluent query builder that compiles a chainable
 * description into either a GraphQL document or a PostgREST URL. Same chain,
 * two transports. Pick per-query with `.via("graphql" | "rest")`; default is
 * GraphQL because it supports co-fetch, nested projections, and the vector /
 * search operators.
 *
 * Not a full ORM — the builder covers the 80% case (select, where, orderBy,
 * limit, offset, first/all/count). Anything exotic (aggregates, pagination
 * cursors, vector k-NN, relay connections, mutations with returning, stored
 * procs) still belongs in `db.graphql.query()` / `db.rest.get()` until we
 * grow explicit builders for each.
 *
 * Filter values are emitted as GraphQL literals:
 *   - numbers, booleans, null, arrays: JSON-ish inline
 *   - strings: the server's where-input is typed, so we serialize strings
 *     unquoted when they look like an identifier (`[a-z_][a-z0-9_]*`) —
 *     that covers enum values like `todo` / `in_progress` which the server
 *     rejects if quoted. Strings with spaces / punctuation / uppercase get
 *     JSON-quoted. Force-quote via `str("value")`, force-unquote via
 *     `unquoted("value")`.
 */

// ---------- Filter value helpers ----------

const FORCE_QUOTED = Symbol("forceQuoted");
const FORCE_UNQUOTED = Symbol("forceUnquoted");

export interface ForceQuoted {
  [FORCE_QUOTED]: true;
  value: string;
}
export interface ForceUnquoted {
  [FORCE_UNQUOTED]: true;
  value: string;
}

/** Force a string to be emitted as a quoted GraphQL string literal. */
export function str(value: string): ForceQuoted {
  return { [FORCE_QUOTED]: true, value };
}

/** Force a string to be emitted as a bare GraphQL identifier (enum value). */
export function unquoted(value: string): ForceUnquoted {
  return { [FORCE_UNQUOTED]: true, value };
}

function isForceQuoted(v: unknown): v is ForceQuoted {
  return typeof v === "object" && v !== null && (v as ForceQuoted)[FORCE_QUOTED] === true;
}
function isForceUnquoted(v: unknown): v is ForceUnquoted {
  return typeof v === "object" && v !== null && (v as ForceUnquoted)[FORCE_UNQUOTED] === true;
}

const ENUM_LIKE = /^[a-z_][a-z0-9_]*$/;
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const KEYWORD_LITERALS = new Set(["true", "false", "null"]);

/**
 * Every field, column, operator and enum name is written into the query text,
 * so each one must be a plain GraphQL name. Anything else throws before a
 * request is built.
 */
function assertName(name: unknown, what: string): string {
  if (typeof name !== "string" || !GRAPHQL_NAME.test(name)) {
    const shown = String(name).length > 40 ? `${String(name).slice(0, 40)}...` : String(name);
    throw new ConfigError(`Invalid ${what} "${shown}": must match ${GRAPHQL_NAME.source}`);
  }
  return name;
}

/** Walks a value fully: JSON serialization would turn a nested `undefined` into a missing key or `null`. */
function assertDefined(value: unknown, what: string, depth = 0): void {
  if (value === undefined) {
    throw new ConfigError(`${what} contains undefined; use null for NULL or leave the key out`);
  }
  if (depth > 32) throw new ConfigError(`${what} is nested too deeply`);
  if (Array.isArray(value)) {
    for (const item of value) assertDefined(item, what, depth + 1);
  } else if (isForceQuoted(value) || isForceUnquoted(value)) {
    assertDefined(value.value, what, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) assertDefined(item, what, depth + 1);
  }
}

/** Top-level undefined keys are dropped (as on GraphQL); nested ones are refused. */
function assertRowsDefined(rows: ReadonlyArray<Record<string, unknown>>): void {
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (value !== undefined) assertDefined(value, `column "${key}"`);
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateColumnFilter(col: string, ops: unknown): void {
  if (!isPlainObject(ops) || Object.keys(ops).length === 0) {
    throw new ConfigError(`Filter on "${col}" must be an object with at least one operator`);
  }
  if ("not" in ops) {
    const inner = ops.not;
    if (!isPlainObject(inner) || Object.keys(inner).length === 0 || "not" in inner) {
      throw new ConfigError(`"not" on "${col}" must be an object with at least one operator and no nested "not"`);
    }
  }
}

function validateOrList(list: unknown): void {
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError("_or / .or() must be a non-empty array of filters");
  }
  for (const condition of list) validateWhere(condition, true);
}

/** Every part of a where is sent or refused, never dropped. */
function validateWhere(where: unknown, requireColumns = false): void {
  if (!isPlainObject(where)) throw new ConfigError("A where filter must be an object");
  for (const [col, ops] of Object.entries(where)) {
    if (col === "_or") validateOrList(ops);
    else validateColumnFilter(col, ops);
  }
  if (requireColumns && Object.keys(where).length === 0) throw new ConfigError("An _or condition cannot be empty");
}

/** An enum value is a bare name, and `null`, `true` and `false` would read as keywords. */
function assertEnumValue(value: unknown): string {
  const name = assertName(value, "enum value");
  if (KEYWORD_LITERALS.has(name)) throw new ConfigError(`Invalid enum value "${name}": reserved word`);
  return name;
}

function assertWholeNumber(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new ConfigError(`${what} must be an integer`);
  }
  return n;
}

function finiteNumber(n: number, what: string): string {
  if (!Number.isFinite(n)) throw new ConfigError(`${what} must be a finite number`);
  return String(n);
}

function serializeGraphqlValue(v: unknown): string {
  if (v === undefined) throw new ConfigError("undefined is not a valid value; use null for NULL or leave the key out");
  if (v === null) return "null";
  if (typeof v === "number") return finiteNumber(v, "filter value");
  if (typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return v.toString();
  if (isForceQuoted(v)) return JSON.stringify(v.value);
  if (isForceUnquoted(v)) return assertEnumValue(v.value);
  if (Array.isArray(v)) return `[${v.map(serializeGraphqlValue).join(", ")}]`;
  if (typeof v === "string") {
    return ENUM_LIKE.test(v) && !KEYWORD_LITERALS.has(v) ? v : JSON.stringify(v);
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${assertName(k, "filter key")}: ${serializeGraphqlValue(val)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  throw new ConfigError(`Unsupported value of type ${typeof v}`);
}

function projectionOf(columns: readonly string[]): string {
  return columns.map((c) => assertName(c, "column")).join(" ");
}

// ---------- Types ----------

export type FilterOp =
  // Comparison
  | "eq" | "neq"
  | "gt" | "gte" | "lt" | "lte"
  | "in" | "notIn"
  | "isNull" | "isNotNull"
  // String
  | "contains" | "startsWith" | "endsWith"
  | "like" | "ilike"
  // Regex
  | "regex" | "iregex"
  // Full-text search
  | "search" | "webSearch" | "phraseSearch" | "rawSearch"
  // JSON
  | "jsonContains" | "containedBy"
  | "hasKey" | "hasKeys" | "hasAnyKeys"
  // Array
  | "arrayContains" | "arrayHasAny" | "arrayHasAll"
  // Logical
  | "not";

export type FilterValue =
  | string | number | boolean | null
  | ForceQuoted | ForceUnquoted
  | Array<string | number | boolean>
  | Record<string, unknown>;

export type ColumnFilter = Partial<Record<FilterOp, FilterValue>>;

export type WhereInput = Record<string, ColumnFilter> & {
  _or?: WhereInput[];
};

export interface VectorSearchInput {
  column: string;
  near: number[];
  distance?: "L2" | "COSINE" | "IP";
  limit?: number;
}

export interface AggregateInput {
  count?: boolean;
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
}

export type OrderBySpec = Record<string, "asc" | "desc" | "ASC" | "DESC">;

export interface RestDescriptor {
  table: string;
  profile?: string;
}

export type Transport = "graphql" | "rest";

// ---------- Builder ----------

/**
 * Mutation kind set by `.insert()` / `.update()` / `.delete()`. `null` means
 * the chain is still a SELECT — terminal methods like `.all()` route through
 * the read path. A non-null kind switches the chain to a write and the
 * terminal becomes `.execute()`.
 */
export type MutationKind = "insert" | "update" | "delete";

type ModifierKey = "_vector" | "_aggregate" | "_orderBy" | "_limit" | "_offset";

export class QueryBuilder<T = Record<string, unknown>> {
  private _select: string[] = [];
  private _where: WhereInput | null = null;
  private _orderBy: OrderBySpec | null = null;
  private _limit: number | null = null;
  private _offset: number | null = null;
  private _transport: Transport = "graphql";
  private _mutationKind: MutationKind | null = null;
  private _insertRows: ReadonlyArray<Partial<T>> | null = null;
  private _updatePatch: Partial<T> | null = null;
  private _returning: string[] = [];
  private _or: WhereInput[] | null = null;
  private _vector: VectorSearchInput | null = null;
  private _aggregate: AggregateInput | null = null;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: DbClient<any, any>,
    private readonly graphqlField: string,
    private readonly rest?: RestDescriptor,
    /**
     * Enum-typed column names from the runtime SchemaMeta. When `undefined`
     * the builder has no type info and falls back to the bare-identifier
     * heuristic for every string. When `[]` (or populated) the builder
     * trusts the schema: only listed columns get bare identifiers.
     */
    private readonly enumColumns?: readonly string[],
  ) {}

  select(...columns: Array<keyof T & string>): this {
    this._select = columns as string[];
    return this;
  }

  where(filter: WhereInput): this {
    this._where = filter;
    return this;
  }

  orderBy(spec: OrderBySpec): this {
    this._orderBy = spec;
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  offset(n: number): this {
    this._offset = n;
    return this;
  }

  or(conditions: WhereInput[]): this {
    this._or = conditions;
    return this;
  }

  vector(input: VectorSearchInput): this {
    this._vector = input;
    return this;
  }

  aggregate(input: AggregateInput): this {
    this._aggregate = input;
    return this;
  }

  via(transport: Transport): this {
    if (transport === "rest" && this.rest == null) {
      throw new ConfigError(
        `db.from("${this.graphqlField}") has no REST descriptor. Pass one via db.from("${this.graphqlField}", { table: "...", profile: "..." }).`,
      );
    }
    this._transport = transport;
    return this;
  }

  // ---------- Mutation entry points ----------

  /**
   * Begins an INSERT mutation. Pass a single row object or an array for
   * bulk insert. The chain is terminated with `.execute()`; default
   * projection is `__typename` unless `.returning(...)` is called.
   */
  insert(input: Partial<T> | ReadonlyArray<Partial<T>>): this {
    this._mutationKind = "insert";
    this._insertRows = Array.isArray(input) ? input : [input as Partial<T>];
    return this;
  }

  /**
   * Begins an UPDATE mutation. Must be paired with `.where(...)` — the
   * builder refuses to compile an unfiltered update as a safety net.
   */
  update(patch: Partial<T>): this {
    this._mutationKind = "update";
    this._updatePatch = patch;
    return this;
  }

  /**
   * Begins a DELETE mutation. Must be paired with `.where(...)`.
   */
  delete(): this {
    this._mutationKind = "delete";
    return this;
  }

  /**
   * Sets the projection on a mutation result (analogous to PostgreSQL's
   * `RETURNING` clause). When omitted the mutation returns `__typename`.
   */
  returning(...columns: Array<keyof T & string>): this {
    this._returning = columns as string[];
    return this;
  }

  /**
   * Terminal for mutations. Returns the written rows when the server
   * supports it (PostgREST `Prefer: return=representation` is implicit;
   * GraphQL mutations always return the rows projected by `.returning()`).
   */
  async execute(): Promise<T[]> {
    if (this._mutationKind == null) {
      throw new ConfigError("execute() called without a mutation — use .all() / .first() for reads");
    }
    if (this._transport === "rest") {
      return this.executeRest();
    }
    const { document } = this.toGraphql();
    const data = await this.db.graphql.query<Record<string, T[]>>(document);
    const responseField = this.graphqlMutationField();
    const result = data[responseField];
    if (Array.isArray(result)) return result;
    if (result != null) return [result as T];
    return [];
  }

  // ---------- Terminal methods ----------

  async all(): Promise<T[]> {
    if (this._transport === "rest") {
      const { path, headers } = this.toRest();
      const response = await this.db.rest.get<{ data: T[] }>(path, { headers });
      return response.data ?? [];
    }
    const { document } = this.toGraphql();
    const data = await this.db.graphql.query<Record<string, T[]>>(document);
    return (data[this.graphqlField] ?? []) as T[];
  }

  async first(): Promise<T | null> {
    // Work on a copy so the caller's builder keeps its own limit.
    const copy: QueryBuilder<T> = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    copy._limit = 1;
    const rows = await copy.all();
    return rows[0] ?? null;
  }

  async count(): Promise<number> {
    this.assertOnlyConditionsOf("count()", ["_vector", "_aggregate", "_orderBy", "_limit", "_offset"]);
    if (this._transport === "rest") {
      // PostgREST `Prefer: count=exact` returns total in the pagination envelope.
      const builder = this.cloneForCount();
      const { path } = builder.toRest();
      const response = await this.db.rest.get<{ pagination?: { total: number } }>(path, {
        headers: {
          ...this.restHeaders(),
          Prefer: "count=exact",
        },
      });
      return response.pagination?.total ?? 0;
    }
    // GraphQL: use the sibling <Field>Aggregate field with the same where.
    const aggregateField = `${assertName(this.graphqlField, "field name")}Aggregate`;
    const whereParts = this.buildWhereParts();
    const whereClause = whereParts != null ? `(where: ${whereParts})` : "";
    const document = `{ ${aggregateField}${whereClause} { count } }`;
    const data = await this.db.graphql.query<Record<string, { count: number }>>(document);
    return data[aggregateField]?.count ?? 0;
  }

  // ---------- Compilers (testable in isolation) ----------

  toGraphql(): { document: string } {
    if (this._mutationKind != null) return this.toGraphqlMutation();
    if (this._aggregate != null) {
      this.assertOnlyConditionsOf("an aggregate", ["_vector", "_orderBy", "_limit", "_offset"]);
      return this.toGraphqlAggregate();
    }

    const field = assertName(this.graphqlField, "field name");
    const args: string[] = [];
    const whereParts = this.buildWhereParts();
    if (whereParts != null) args.push(`where: ${whereParts}`);
    if (this._vector != null) args.push(`vector: ${serializeVectorInput(this._vector)}`);
    if (this._orderBy != null) args.push(`orderBy: ${serializeOrderBy(this._orderBy)}`);
    if (this._limit != null) args.push(`limit: ${assertWholeNumber(this._limit, "limit")}`);
    if (this._offset != null) args.push(`offset: ${assertWholeNumber(this._offset, "offset")}`);
    const argString = args.length > 0 ? `(${args.join(", ")})` : "";
    const projection = this._select.length > 0 ? projectionOf(this._select) : "__typename";
    const document = `{ ${field}${argString} { ${projection} } }`;
    return { document };
  }

  private toGraphqlAggregate(): { document: string } {
    const agg = this._aggregate!;
    const parts: string[] = [];
    if (agg.count) parts.push("count");
    for (const fn of ["sum", "avg", "min", "max"] as const) {
      const cols = agg[fn];
      if (cols != null && cols.length > 0) {
        parts.push(`${fn} { ${projectionOf(cols)} }`);
      }
    }
    const whereParts = this.buildWhereParts();
    const whereArg = whereParts != null ? `(where: ${whereParts})` : "";
    const document = `{ ${assertName(this.graphqlField, "field name")}Aggregate${whereArg} { ${parts.join(" ")} } }`;
    return { document };
  }

  private buildWhereParts(): string | null {
    if (this._where != null) validateWhere(this._where);
    if (this._or != null) validateOrList(this._or);
    const { _or: whereOr, ...columns } = (this._where ?? {}) as WhereInput;
    if (this._or != null && whereOr != null) {
      throw new ConfigError("Use either .or() or where({ _or }), not both");
    }
    const entries = Object.entries(columns).map(([col, ops]) => this.serializeColumnFilter(col, ops));
    const orConditions = this._or ?? whereOr;
    if (orConditions != null) {
      entries.push(`_or: [${orConditions.map((w) => this.serializeWhereTyped(w)).join(", ")}]`);
    }
    return entries.length > 0 ? `{ ${entries.join(", ")} }` : null;
  }

  /** Mutations send only a where (update, delete) and their rows; anything else set would be dropped. */
  private assertMutationModifiers(): void {
    this.assertOnlyConditionsOf("a mutation", ["_vector", "_aggregate", "_orderBy", "_limit", "_offset"]);
    if (this._mutationKind === "insert" && (this._where != null || this._or != null)) {
      throw new ConfigError("insert does not take .where() or .or()");
    }
  }

  private assertOnlyConditionsOf(what: string, unsupported: ReadonlyArray<ModifierKey>): void {
    for (const key of unsupported) {
      if (this[key as ModifierKey] != null) {
        throw new ConfigError(`${String(key).slice(1)} is not supported on ${what} and would be ignored`);
      }
    }
  }

  private toGraphqlMutation(): { document: string } {
    this.assertMutationModifiers();
    const projection = this._returning.length > 0 ? projectionOf(this._returning) : "__typename";
    const field = this.graphqlMutationField();
    let args = "";
    if (this._mutationKind === "insert") {
      const rows = this._insertRows ?? [];
      if (rows.length === 1) {
        args = `input: ${serializeRecord(rows[0]!, this.enumColumns)}`;
      } else {
        const inputs = rows.map((r) => serializeRecord(r, this.enumColumns)).join(", ");
        args = `inputs: [${inputs}]`;
      }
    } else if (this._mutationKind === "update") {
      const whereParts = this.buildWhereParts();
      if (whereParts == null) {
        throw new ConfigError(`update on "${this.graphqlField}" requires a .where(...) filter (refusing unfiltered update)`);
      }
      const patch = serializeRecord(this._updatePatch ?? {}, this.enumColumns);
      if (patch === "{  }") throw new ConfigError(`update on "${this.graphqlField}" has no values to set`);
      args = `where: ${whereParts}, input: ${patch}`;
    } else if (this._mutationKind === "delete") {
      const whereParts = this.buildWhereParts();
      if (whereParts == null) {
        throw new ConfigError(`delete on "${this.graphqlField}" requires a .where(...) filter (refusing unfiltered delete)`);
      }
      args = `where: ${whereParts}`;
    }
    const document = `mutation { ${field}(${args}) { ${projection} } }`;
    return { document };
  }

  private graphqlMutationField(): string {
    // GraphQL field names follow the same Capitalize convention used by the
    // server: `kanbanIssues` → `createKanbanIssues` / `updateKanbanIssues` /
    // `deleteKanbanIssues`. Bulk insert uses `createMany<Type>`.
    const cap = assertName(this.graphqlField, "field name").charAt(0).toUpperCase() + this.graphqlField.slice(1);
    if (this._mutationKind === "insert") {
      const isBulk = (this._insertRows?.length ?? 0) > 1;
      return isBulk ? `createMany${cap}` : `create${cap}`;
    }
    if (this._mutationKind === "update") return `update${cap}`;
    if (this._mutationKind === "delete") return `delete${cap}`;
    throw new ConfigError("graphqlMutationField called without a mutation kind");
  }

  private async executeRest(): Promise<T[]> {
    if (this.rest == null) {
      throw new ConfigError(`REST mutation on "${this.graphqlField}" needs a REST descriptor`);
    }
    this.assertMutationModifiers();
    if (this._returning.length > 0) {
      throw new ConfigError("returning() is not supported over REST writes; use the GraphQL transport");
    }
    if (this._mutationKind === "insert") {
      const rows = this._insertRows ?? [];
      assertRowsDefined(rows as ReadonlyArray<Record<string, unknown>>);
      const body = rows.length === 1 ? rows[0] : rows;
      const result = await this.db.rest.post<{ data?: T[] } | T[]>(
        `/${this.rest.table}`,
        body,
        { headers: this.contentProfileHeaders() },
      );
      return Array.isArray(result) ? result : (result.data ?? []);
    }
    if (this._mutationKind === "update") {
      if (this._where == null) {
        throw new ConfigError(`update via REST on "${this.graphqlField}" requires a .where(...) filter`);
      }
      assertNoRestOr(this._where, this._or);
      const qs = serializeRestWhere(this._where);
      if (qs === "") throw new ConfigError(`${this._mutationKind} via REST on "${this.graphqlField}" needs a non-empty filter`);
      assertRowsDefined([(this._updatePatch ?? {}) as Record<string, unknown>]);
      if (Object.values(this._updatePatch ?? {}).every((v) => v === undefined)) {
        throw new ConfigError(`update on "${this.graphqlField}" has no values to set`);
      }
      const result = await this.db.rest.patch<{ data?: T[] } | T[]>(
        `/${this.rest.table}?${qs}`,
        this._updatePatch ?? {},
        { headers: this.contentProfileHeaders() },
      );
      return Array.isArray(result) ? result : (result.data ?? []);
    }
    if (this._mutationKind === "delete") {
      if (this._where == null) {
        throw new ConfigError(`delete via REST on "${this.graphqlField}" requires a .where(...) filter`);
      }
      assertNoRestOr(this._where, this._or);
      const qs = serializeRestWhere(this._where);
      if (qs === "") throw new ConfigError(`${this._mutationKind} via REST on "${this.graphqlField}" needs a non-empty filter`);
      const result = await this.db.rest.delete<{ data?: T[] } | T[]>(
        `/${this.rest.table}?${qs}`,
        { headers: this.contentProfileHeaders() },
      );
      return Array.isArray(result) ? result : (result.data ?? []);
    }
    return [];
  }

  private contentProfileHeaders(): Record<string, string> {
    if (this.rest?.profile != null) return { "Content-Profile": this.rest.profile };
    return {};
  }

  /**
   * Type-aware where serializer — when {@link enumColumns} is populated
   * (from runtime SchemaMeta), enum-typed columns force bare identifier
   * serialization for all filter values regardless of the heuristic. Other
   * columns fall back to {@link serializeGraphqlValue} which quotes strings
   * unless they look identifier-like.
   */
  private serializeWhereTyped(where: WhereInput): string {
    const { _or, ...rest } = where;
    const entries = Object.entries(rest).map(([col, ops]) => this.serializeColumnFilter(col, ops));
    if (_or != null && _or.length > 0) {
      const orParts = _or.map((w) => this.serializeWhereTyped(w));
      entries.push(`_or: [${orParts.join(", ")}]`);
    }
    return `{ ${entries.join(", ")} }`;
  }

  private serializeColumnFilter(col: string, ops: ColumnFilter): string {
    const schemaKnown = this.enumColumns !== undefined;
    const enumSet = new Set(this.enumColumns ?? []);
    const isEnum = enumSet.has(col);
    const opEntries = Object.entries(ops).map(([op, value]) => {
      // "not" wraps a nested ColumnFilter
      if (op === "not" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        const inner = Object.entries(value as Record<string, unknown>)
          .map(([k, v]) => `${assertName(k, "operator")}: ${this.serializeValue(col, v, isEnum, schemaKnown)}`)
          .join(", ");
        return `not: { ${inner} }`;
      }
      return `${assertName(op, "operator")}: ${this.serializeValue(col, value, isEnum, schemaKnown)}`;
    });
    return `${assertName(col, "column")}: { ${opEntries.join(", ")} }`;
  }

  private serializeValue(_col: string, value: unknown, isEnum: boolean, schemaKnown: boolean): string {
    if (isEnum) return serializeEnum(value);
    if (schemaKnown && typeof value === "string" && !isForceQuoted(value) && !isForceUnquoted(value)) {
      return JSON.stringify(value);
    }
    return serializeGraphqlValue(value);
  }

  toRest(): { path: string; headers: Record<string, string> } {
    if (this.rest == null) {
      throw new ConfigError(`toRest() called without a REST descriptor on db.from("${this.graphqlField}")`);
    }
    assertNoRestOr(this._where, this._or);
    this.assertOnlyConditionsOf("REST", ["_vector", "_aggregate"]);
    const params = new URLSearchParams();
    if (this._select.length > 0) params.set("select", this._select.join(","));
    if (this._where != null) {
      for (const [col, filter] of restFilterParams(this._where)) params.append(col, filter);
    }
    if (this._orderBy != null) {
      const parts = Object.entries(this._orderBy).map(([col, dir]) => `${col}.${String(dir).toLowerCase()}`);
      params.set("order", parts.join(","));
    }
    if (this._limit != null) params.set("limit", String(this._limit));
    if (this._offset != null) params.set("offset", String(this._offset));

    const qs = params.toString();
    const path = `/${this.rest.table}${qs.length > 0 ? "?" + qs : ""}`;
    return { path, headers: this.restHeaders() };
  }

  private restHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.rest?.profile != null) h["Accept-Profile"] = this.rest.profile;
    return h;
  }

  private cloneForCount(): QueryBuilder<T> {
    const clone = new QueryBuilder<T>(this.db, this.graphqlField, this.rest, this.enumColumns);
    clone._where = this._where;
    clone._or = this._or;
    clone._limit = 1;
    clone._offset = 0;
    clone._transport = this._transport;
    return clone;
  }
}

// ---------- Serializers ----------

/**
 * Serializes a row record (for insert/update input). Enum-typed columns
 * are emitted as bare GraphQL identifiers; everything else uses
 * {@link serializeGraphqlValue} which keeps strings quoted.
 */
const VECTOR_DISTANCES = new Set(["L2", "COSINE", "IP"]);

function badVector(): never {
  throw new ConfigError("vector near must be an array of numbers");
}

function serializeVectorInput(v: VectorSearchInput): string {
  const parts: string[] = [];
  parts.push(`column: ${JSON.stringify(String(v.column))}`);
  parts.push(`near: [${v.near.map((n) => (typeof n === "number" ? finiteNumber(n, "vector component") : badVector())).join(", ")}]`);
  if (v.distance != null) {
    if (!VECTOR_DISTANCES.has(v.distance)) throw new ConfigError("vector distance must be L2, COSINE or IP");
    parts.push(`distance: ${v.distance}`);
  }
  if (v.limit != null) parts.push(`limit: ${assertWholeNumber(v.limit, "vector limit")}`);
  return `{ ${parts.join(", ")} }`;
}

function serializeRecord(record: Record<string, unknown>, enumColumns?: readonly string[]): string {
  const enumSet = new Set(enumColumns ?? []);
  const schemaKnown = enumColumns !== undefined;
  const entries = Object.entries(record).filter(([, value]) => value !== undefined).map(([col, value]) => {
    let serialized: string;
    if (enumSet.has(col) && typeof value === "string") {
      serialized = assertEnumValue(value);
    } else if (schemaKnown && typeof value === "string" && !isForceQuoted(value) && !isForceUnquoted(value)) {
      serialized = JSON.stringify(value);
    } else {
      serialized = serializeGraphqlValue(value);
    }
    return `${assertName(col, "column")}: ${serialized}`;
  });
  return `{ ${entries.join(", ")} }`;
}

function orderDirection(dir: unknown): string {
  const upper = String(dir).toUpperCase();
  if (upper !== "ASC" && upper !== "DESC") throw new ConfigError(`orderBy direction must be asc or desc`);
  return upper;
}

function serializeEnum(value: unknown): string {
  if (typeof value === "string") return assertEnumValue(value);
  if (Array.isArray(value)) return `[${value.map(serializeEnum).join(", ")}]`;
  return serializeGraphqlValue(value);
}

function assertNoRestOr(where: WhereInput | null, or: WhereInput[] | null): void {
  if (or != null || (where != null && "_or" in where)) {
    throw new ConfigError("REST cannot send an or-group; use the GraphQL transport for .or() and _or");
  }
}

/**
 * Flattens a where into `[column, filter]` pairs. The engine's REST handlers
 * keep one value per parameter name, so a second filter on the same column
 * would be dropped and the call would match more rows than asked: refuse it.
 */
function restFilterParams(where: WhereInput): Array<[string, string]> {
  validateWhere(where);
  const pairs: Array<[string, string]> = [];
  for (const [col, ops] of Object.entries(where)) {
    if (col === "_or") continue; // refused by assertNoRestOr before this runs
    const columnPairs: Array<[string, string]> = [];
    for (const [op, value] of Object.entries(ops) as Array<[FilterOp, FilterValue]>) {
      if (op === "not") {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          for (const [innerOp, innerVal] of Object.entries(value) as Array<[FilterOp, FilterValue]>) {
            columnPairs.push([col, `not.${serializeRestFilter(innerOp, innerVal)}`]);
          }
        }
        continue;
      }
      columnPairs.push([col, serializeRestFilter(op, value)]);
    }
    if (columnPairs.length > 1) {
      throw new ConfigError(`REST can send only one filter per column; "${col}" has ${columnPairs.length}. Use the GraphQL transport.`);
    }
    pairs.push(...columnPairs);
  }
  return pairs;
}

function serializeRestWhere(where: WhereInput): string {
  const params = new URLSearchParams();
  for (const [col, filter] of restFilterParams(where)) params.append(col, filter);
  return params.toString();
}

function serializeOrderBy(spec: OrderBySpec): string {
  const entries = Object.entries(spec).map(
    ([col, dir]) => `${assertName(col, "orderBy column")}: ${orderDirection(dir)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function serializeRestFilter(op: FilterOp, value: FilterValue): string {
  const v = extractRaw(value);
  assertDefined(v, `${op} filter value`);
  switch (op) {
    case "in":
    case "notIn":
      if (!Array.isArray(v)) throw new ConfigError(`${op} expects an array value`);
      if (v.length === 0) throw new ConfigError(`${op} over REST needs at least one value`);
      return `${restOp(op)}.(${v.map(inListItem).join(",")})`;
    case "isNull":
      return v ? "is.null" : "not.is.null";
    case "isNotNull":
      return v ? "not.is.null" : "is.null";
    case "arrayContains":
    case "arrayHasAll":
    case "arrayHasAny":
      if (!Array.isArray(v)) throw new ConfigError(`${op} expects an array value`);
      return `${restOp(op)}.{${v.map(restListItem).join(",")}}`;
    case "hasKeys":
    case "hasAnyKeys":
      if (!Array.isArray(v)) throw new ConfigError(`${op} expects an array value`);
      return `${restOp(op)}.(${v.map(inListItem).join(",")})`;
    case "contains":
      return `ilike.%${escapeLike(String(v))}%`;
    case "jsonContains":
    case "containedBy":
      return `${restOp(op)}.${typeof v === "object" ? JSON.stringify(v) : String(v)}`;
    default:
      return `${restOp(op)}.${String(v)}`;
  }
}

/**
 * One member of a PostgREST list (`in.(...)`, `cs.{...}`). A value holding a
 * separator, bracket, quote, backslash or whitespace is double-quoted with
 * `"` and `\\` escaped, so it stays one member and cannot add filters.
 */
function restListItem(x: unknown): string {
  const text = String(x);
  if (text !== "" && !/[,()"\\{}\s]/.test(text)) return text;
  return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The engine splits an `in.(...)` list on every comma and never strips quotes,
 * so a value holding a comma would become extra members. Refuse it.
 */
function inListItem(x: unknown): string {
  const text = String(x);
  if (text.includes(",")) throw new ConfigError(`in/notIn values cannot contain a comma: "${text.slice(0, 40)}"`);
  return text;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

function restOp(op: FilterOp): string {
  switch (op) {
    case "eq": return "eq";
    case "neq": return "neq";
    case "gt": return "gt";
    case "gte": return "gte";
    case "lt": return "lt";
    case "lte": return "lte";
    case "in": return "in";
    case "notIn": return "not.in";
    case "contains": return "ilike";
    case "startsWith": return "startswith";
    case "endsWith": return "endswith";
    case "like": return "like";
    case "ilike": return "ilike";
    case "isNull": return "is";
    case "isNotNull": return "is";
    case "regex": return "match";
    case "iregex": return "imatch";
    case "search": return "plfts";
    case "webSearch": return "wfts";
    case "phraseSearch": return "phfts";
    case "rawSearch": return "fts";
    case "jsonContains": return "jsoncontains";
    case "containedBy": return "jsoncontained";
    case "hasKey": return "haskey";
    case "hasKeys": return "haskeys";
    case "hasAnyKeys": return "hasanykeys";
    case "arrayContains": return "cs";
    case "arrayHasAny": return "ov";
    case "arrayHasAll": return "cs";
    case "not": return "not";
  }
}

function extractRaw(v: FilterValue): unknown {
  if (isForceQuoted(v) || isForceUnquoted(v)) return v.value;
  return v;
}
