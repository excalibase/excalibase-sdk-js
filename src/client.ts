import { GraphQLClient } from "graphql-request";
import { AuthClient } from "./auth";
import { AuthError, ConfigError, NetworkError } from "./errors";
import { GraphqlNamespace } from "./graphql-ns";
import { NoSqlNamespace, type CollectionClient, type SchemaDeclaration } from "./nosql";
import { QueryBuilder, type RestDescriptor } from "./query-builder";
import { RestNamespace } from "./rest-ns";
import { defaultStorage, type StorageAdapter } from "./storage";
import type { CreateClientOptions, SchemaMeta, Session } from "./types";

/**
 * Marker constraint for the `Database` generic. A plain `object` so that
 * codegen-emitted interfaces — which carry only explicit table keys without
 * an index signature — satisfy `DB extends DatabaseShape`. Field-level
 * constraints are enforced structurally by {@link RowOf} via conditional
 * types, not by the constraint itself.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DatabaseShape {}

/** Default type when the user doesn't pass a Database generic — unconstrained. */
export type AnyDatabase = Record<string, { Row: unknown; Rest?: { table: string; profile?: string } }>;

/**
 * Helper: the `Row` shape of a given table key on the bound Database.
 * Falls back to `Record<string, unknown>` when `K` isn't a known key OR when
 * the bound Row is the wide `unknown` (untyped fallback case) — keeps
 * `select(...)` usable for callers who don't pass a Database generic.
 */
export type RowOf<DB extends DatabaseShape, K extends string> =
  K extends keyof DB
    ? DB[K] extends { Row: infer R }
      ? unknown extends R
        ? Record<string, unknown>
        : R
      : Record<string, unknown>
    : Record<string, unknown>;

const SECRET_KEY_PREFIX = "esk_sec_";
const PUBLISHABLE_KEY_PREFIX = "esk_pub_";
const DEFAULT_STORAGE_KEY = "excalibase.auth.session";

export class DbClient<DB extends DatabaseShape = AnyDatabase> {
  readonly url: string;
  readonly projectId: string;
  readonly orgSlug: string;
  readonly projectName: string;
  readonly publishableKey: string;
  readonly auth: AuthClient;
  readonly graphql: GraphqlNamespace;
  readonly rest: RestNamespace;
  readonly nosql: NoSqlNamespace;
  readonly storage: StorageAdapter;
  readonly storageKey: string;
  readonly schema: SchemaMeta | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: CreateClientOptions) {
    validateOptions(opts);
    this.url = stripTrailingSlash(opts.url);
    this.projectId = opts.projectId;
    const [orgSlug, projectName] = opts.projectId.split("/");
    this.orgSlug = orgSlug!;
    this.projectName = projectName!;
    this.publishableKey = opts.publishableKey;
    this.storage = opts.storage ?? defaultStorage();
    this.storageKey = opts.storageKey ?? `${DEFAULT_STORAGE_KEY}:${opts.projectId}`;
    this.schema = opts.schema;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch);
    if (typeof this.fetchImpl !== "function") {
      throw new ConfigError("global fetch is not available; pass `fetch` in createClient options");
    }
    this.extraHeaders = { ...(opts.headers ?? {}) };

    this.auth = new AuthClient({
      client: this,
      storage: this.storage,
      storageKey: this.storageKey,
      autoRefreshToken: opts.autoRefreshToken ?? true,
      fetch: this.fetchImpl,
    });
    this.graphql = new GraphqlNamespace(this);
    this.rest = new RestNamespace(this);
    this.nosql = new NoSqlNamespace(this.url, this.fetchImpl, this.extraHeaders);
  }

  graphqlEndpoint(): string {
    return `${this.url}/graphql`;
  }

  restEndpoint(path: string): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${this.url}/api/v1${suffix}`;
  }

  authEndpoint(subpath: string): string {
    const suffix = subpath.startsWith("/") ? subpath : `/${subpath}`;
    return `${this.url}/auth/${this.orgSlug}/${this.projectName}${suffix}`;
  }

  graphqlClient(): GraphQLClient {
    return new GraphQLClient(this.graphqlEndpoint(), {
      headers: this.buildHeaders(),
      fetch: this.fetchImpl as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    });
  }

  /**
   * Executes a raw GraphQL document against the server. Prefer
   * `db.graphql.query()` / `db.graphql.mutation()` — this is the low-level
   * escape hatch used internally and by power users who need custom wiring.
   */
  async rawGraphql<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
    document: string,
    variables?: V,
  ): Promise<T> {
    const client = this.graphqlClient();
    try {
      return (await client.request<T>(document, variables)) as T;
    } catch (error) {
      throw wrapGraphqlError(error);
    }
  }

  buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Excalibase-Publishable-Key": this.publishableKey,
      ...this.extraHeaders,
    };
    const session = this.auth.currentSession();
    if (session?.accessToken != null) {
      headers["Authorization"] = `Bearer ${session.accessToken}`;
    }
    return headers;
  }

  /**
   * Fluent query builder. `db.from("kanbanIssues")` returns a chainable
   * builder that compiles to either a GraphQL document or a PostgREST URL,
   * chosen per-query via `.via("graphql" | "rest")` (default graphql).
   *
   * @example
   *   const todos = await db
   *     .from<KanbanIssue>("kanbanIssues", { table: "issues", profile: "kanban" })
   *     .where({ status: { eq: "todo" } })
   *     .orderBy({ id: "desc" })
   *     .limit(10)
   *     .select("id", "title", "status")
   *     .all();
   */
  from<K extends Extract<keyof DB, string>>(
    graphqlField: K,
    rest?: RestDescriptor,
  ): QueryBuilder<RowOf<DB, K>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(graphqlField: string, rest?: RestDescriptor): QueryBuilder<any> {
    // Auto-derive REST descriptor + enum column hints from the runtime schema
    // metadata when the caller didn't supply one explicitly.
    const meta = this.schema?.[graphqlField];
    const resolvedRest = rest ?? meta?.rest;
    const enumColumns = meta?.enumColumns;
    return new QueryBuilder(this, graphqlField, resolvedRest, enumColumns);
  }

  /**
   * Access a NoSQL document collection.
   * @example
   *   const users = await db.collection("users").find({ status: "active" });
   */
  collection(name: string): CollectionClient {
    return this.nosql.collection(name);
  }

  /**
   * Sync NoSQL schema with the server (creates collections + indexes).
   * Call once at deploy/startup time.
   * @example
   *   await db.init({ collections: { users: { fields: { email: "string" }, indexes: [{ fields: ["email"], unique: true }] } } });
   */
  async init(schema: SchemaDeclaration): Promise<void> {
    return this.nosql.init(schema);
  }

  /**
   * Low-level REST dispatcher. Prefer the typed verb helpers on
   * `db.rest` (`db.rest.get`, `db.rest.post`, etc.) — this method exists
   * as the shared transport that those helpers delegate to.
   */
  async rawRest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.buildHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    };
    let response: Response;
    try {
      const { headers: _ignored, ...restInit } = init ?? {};
      response = await this.fetchImpl(this.restEndpoint(path), {
        ...restInit,
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new NetworkError(`REST request failed for ${method} ${path}`, error);
    }
    const text = await response.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : null;
    if (!response.ok) {
      const message = extractErrorMessage(parsed) ?? `REST ${method} ${path} failed with ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        throw new AuthError(message, `http_${response.status}`, response.status, parsed);
      }
      throw new NetworkError(message, parsed);
    }
    return parsed as T;
  }

  /**
   * Exchanges the current session's refresh token (or re-exchanges the
   * publishable api key) and installs the result. Returns the new session.
   */
  async refreshSession(): Promise<Session | null> {
    return this.auth.refresh();
  }
}

function validateOptions(opts: CreateClientOptions): void {
  if (opts == null || typeof opts !== "object") {
    throw new ConfigError("createClient requires an options object");
  }
  if (typeof opts.url !== "string" || opts.url.length === 0) {
    throw new ConfigError("`url` is required");
  }
  if (!/^https?:\/\//.test(opts.url)) {
    throw new ConfigError("`url` must start with http:// or https://");
  }
  if (typeof opts.projectId !== "string" || !/^[^/]+\/[^/]+$/.test(opts.projectId)) {
    throw new ConfigError("`projectId` must be in the form '{orgSlug}/{projectName}'");
  }
  if (typeof opts.publishableKey !== "string" || opts.publishableKey.length === 0) {
    throw new ConfigError("`publishableKey` is required");
  }
  if (opts.publishableKey.startsWith(SECRET_KEY_PREFIX)) {
    if (typeof window !== "undefined") {
      throw new ConfigError(
        "Secret API keys (esk_sec_*) must never be used in a browser. Use a publishable key (esk_pub_*) on the client and keep secret keys server-side only.",
      );
    }
  } else if (!opts.publishableKey.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    // Allow custom keys for dev/test, but the common case is a typo — warn
    // loudly via a thrown error only when the key looks clearly malformed.
    if (opts.publishableKey.length < 16) {
      throw new ConfigError(
        `'publishableKey' does not look like an excalibase key (expected prefix 'esk_pub_' or 'esk_sec_'). Got '${opts.publishableKey.slice(0, 8)}...'`,
      );
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(parsed: unknown): string | null {
  if (parsed != null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
  }
  return null;
}

function wrapGraphqlError(error: unknown): Error {
  if (error instanceof Error) {
    const maybeResponse = (error as unknown as { response?: { status?: number } }).response;
    const status = maybeResponse?.status;
    if (status === 401 || status === 403) {
      return new AuthError(error.message, `http_${status}`, status, error);
    }
    return new NetworkError(error.message, error);
  }
  return new NetworkError("Unknown GraphQL error", error);
}

export function createClient<DB extends DatabaseShape = AnyDatabase>(
  opts: CreateClientOptions,
): DbClient<DB> {
  return new DbClient<DB>(opts);
}
