import { GraphQLClient } from "graphql-request";
import { AuthClient } from "./auth";
import { AuthError, ConfigError, NetworkError } from "./errors";
import { FunctionsNamespace } from "./functions/namespace";
import type { DefaultFunctions } from "./functions/types";
import { GraphqlNamespace } from "./graphql-ns";
import {
  authUrl,
  functionsUrl,
  graphqlUrl,
  realtimeUrl,
  resolveProjectTarget,
  restUrl,
  type ProjectTarget,
} from "./project";
import { QueryBuilder, type RestDescriptor } from "./query-builder";
import { RestNamespace } from "./rest-ns";
import { defaultStorage, type StorageAdapter } from "./storage";
import { FileStorageClient } from "./storage/client";
import { resolveWebSocket, type WebSocketConstructor } from "./realtime";
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

export class DbClient<
  DB extends DatabaseShape = AnyDatabase,
  Functions = DefaultFunctions,
> {
  /** The platform's base URL. */
  readonly url: string;
  /** The project's id: the path segment every service names it by. */
  readonly projectId: string;
  /** Auth's org path segment (the project id unless `orgSlug` was given). */
  readonly orgSlug: string;
  /** @deprecated The project id; kept for older callers. */
  readonly projectName: string;
  /** The API key sent as `X-Excalibase-Publishable-Key` (publishable or, server-side, secret). */
  readonly publishableKey: string;
  readonly auth: AuthClient;
  readonly graphql: GraphqlNamespace;
  readonly rest: RestNamespace;
  /**
   * Typed RPC namespace: `db.functions.<module>.<name>(args)`. The proxy
   * resolves `.<module>.<name>` to a POST against
   * `{url}/functions/v1/{projectId}/{module}.{name}` with `{ args }`.
   */
  readonly functions: Functions;
  /**
   * File-storage client. `uploadFile` mints a signed URL for the blob's
   * declared size and type, PUTs the bytes, completes the upload, and
   * returns the storageId.
   *
   *   const { storageId } = await db.storage.uploadFile(blob);
   *
   * The auth-token persistence adapter is now on `tokenStorage`; this
   * field was previously the StorageAdapter and is now the file client.
   */
  readonly storage: FileStorageClient;
  /**
   * Backing adapter for auth-session persistence (previously `db.storage`
   * before Phase 10 reclaimed that slot for the file-storage client).
   * Defaults to `localStorage` in a browser and an in-memory shim in
   * Node.
   */
  readonly tokenStorage: StorageAdapter;
  readonly storageKey: string;
  readonly schema: SchemaMeta | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly target: ProjectTarget;
  private readonly webSocketOption: unknown;

  constructor(opts: CreateClientOptions) {
    if (opts == null || typeof opts !== "object") {
      throw new ConfigError("createClient requires an options object: { url, projectId, key }");
    }
    this.target = resolveProjectTarget(opts);
    this.publishableKey = resolveKey(opts);
    this.url = this.target.url;
    this.projectId = this.target.projectId;
    this.orgSlug = this.target.orgSlug;
    this.projectName = this.target.projectId;
    this.webSocketOption = opts.WebSocket;
    this.tokenStorage = opts.storage ?? defaultStorage();
    // Keyed as before (by the projectId option) so a stored session survives the upgrade.
    this.storageKey = opts.storageKey ?? `${DEFAULT_STORAGE_KEY}:${opts.projectId}`;
    this.schema = opts.schema;
    // Bind fetch to globalThis. Calling `globalThis.fetch` via a property
    // (`this.fetchImpl(url, init)`) detaches it from its Window receiver,
    // which the browser rejects with "TypeError: Failed to execute 'fetch'
    // on 'Window': Illegal invocation". Bind once at construction.
    const rawFetch = opts.fetch ?? (globalThis.fetch as typeof fetch);
    if (typeof rawFetch !== "function") {
      throw new ConfigError("global fetch is not available; pass `fetch` in createClient options");
    }
    this.fetchImpl = rawFetch.bind(globalThis) as typeof fetch;
    this.extraHeaders = { ...(opts.headers ?? {}) };

    this.auth = new AuthClient({
      client: this,
      storage: this.tokenStorage,
      storageKey: this.storageKey,
      autoRefreshToken: opts.autoRefreshToken ?? true,
      fetch: this.fetchImpl,
    });
    this.graphql = new GraphqlNamespace(this);
    this.rest = new RestNamespace(this);
    const fnsNs = new FunctionsNamespace<Functions>({
      url: this.url,
      projectId: this.projectId,
      headersFactory: () => this.buildHeaders(),
      fetchImpl: this.fetchImpl,
    });
    this.functions = fnsNs as unknown as Functions;

    // Phase 10: file-storage client. Lives at `db.storage`. The token
    // adapter persistence lives at `db.tokenStorage` from Phase 10
    // onward (was `db.storage` before).
    this.storage = new FileStorageClient({
      url: this.url,
      projectId: this.projectId,
      fetchImpl: this.fetchImpl,
      headersFactory: () => this.buildHeaders(),
    });
  }

  /** `{url}/{projectId}/graphql` */
  graphqlEndpoint(): string {
    return graphqlUrl(this.target);
  }

  /** `{url}/{projectId}/api/v1{path}` */
  restEndpoint(path: string): string {
    return restUrl(this.target, path);
  }

  /** `{url}/auth/{orgSlug}/{projectId}{subpath}` */
  authEndpoint(subpath: string): string {
    return authUrl(this.target, subpath);
  }

  /** `{url}/functions/v1/{projectId}/{name}`, where name is `module.export` */
  functionsEndpoint(name: string): string {
    return functionsUrl(this.target, name);
  }

  /** `ws(s)://{host}/{projectId}/graphql`: GraphQL subscriptions (graphql-transport-ws). */
  realtimeEndpoint(): string {
    return realtimeUrl(this.target);
  }

  /** The WebSocket constructor subscriptions use: the `WebSocket` option, else the runtime's. */
  webSocketConstructor(): WebSocketConstructor {
    return resolveWebSocket(this.webSocketOption);
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

function resolveKey(opts: CreateClientOptions): string {
  const { key, publishableKey } = opts;
  if (key != null && publishableKey != null && key !== publishableKey) {
    throw new ConfigError("Pass the project's API key once, as `key` (`publishableKey` is its older name).");
  }
  const value = key ?? publishableKey;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(
      "`key` is required: the project's publishable key (esk_pub_*), or a secret key (esk_sec_*) on a server only.",
    );
  }
  if (value.startsWith(SECRET_KEY_PREFIX)) {
    if (typeof window !== "undefined") {
      throw new ConfigError(
        "Secret API keys (esk_sec_*) must never be used in a browser. Use a publishable key (esk_pub_*) on the client and keep secret keys server-side only.",
      );
    }
  } else if (!value.startsWith(PUBLISHABLE_KEY_PREFIX) && value.length < 16) {
    // Custom keys are allowed for dev/test; a short one is almost always a typo.
    throw new ConfigError(
      `\`key\` does not look like an excalibase key (expected prefix 'esk_pub_' or 'esk_sec_'). Got '${value.slice(0, 8)}...'`,
    );
  }
  return value;
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

export function createClient<
  DB extends DatabaseShape = AnyDatabase,
  Functions = DefaultFunctions,
>(opts: CreateClientOptions): DbClient<DB, Functions> {
  return new DbClient<DB, Functions>(opts);
}
