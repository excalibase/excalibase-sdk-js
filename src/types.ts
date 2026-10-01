export interface User {
  id: number;
  email: string;
  fullName: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: number;
  user: User | null;
}

export interface RawAuthResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn: number;
  user?: User;
}

export type AuthChangeEvent =
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED";

export type AuthChangeHandler = (event: AuthChangeEvent, session: Session | null) => void;

export interface Subscription {
  unsubscribe: () => void;
}

export interface APIKeyInfo {
  id: number;
  keyPrefix: string;
  keyType: "publishable" | "secret";
  name: string;
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface CreateAPIKeyResult extends APIKeyInfo {
  plaintext: string;
}

/**
 * Runtime schema metadata emitted by `@excalibase/sdk codegen`. Lets the
 * builder know which columns are enum-typed (so it can emit bare GraphQL
 * identifiers instead of quoted strings) and which REST table + profile to
 * hit for `.via("rest")` without making the user pass them explicitly.
 */
export interface TableMeta {
  /** GraphQL field on Query, e.g. "kanbanIssues" */
  field: string;
  /** Column names whose type is a GraphQL enum — serialized bare in filters */
  enumColumns: readonly string[];
  /** REST mapping derived from introspection (table + Accept-Profile schema) */
  rest: {
    table: string;
    profile?: string;
  };
}

export type SchemaMeta = Record<string, TableMeta>;

export interface CreateClientOptions {
  /**
   * The platform's base URL, e.g. `https://api.example.com` — no project and
   * no service path. The SDK builds `/{projectId}/graphql`,
   * `/{projectId}/api/v1`, `/auth/{orgSlug}/{projectId}` and
   * `/functions/v1/{projectId}` itself.
   */
  url: string;
  /**
   * The project's id, e.g. `proj-a1b2c3d4e5`. The older
   * `"{orgSlug}/{projectId}"` form is still read as the org and the project.
   */
  projectId: string;
  /**
   * The project's API key: a publishable key (`esk_pub_*`) in a browser, or
   * a secret key (`esk_sec_*`) on a server only.
   */
  key?: string;
  /** @deprecated Use `key`. Still accepted; it must match `key` when both are set. */
  publishableKey?: string;
  /**
   * The org's slug, used as auth's org path segment. Optional: auth finds
   * the project by its id, so it defaults to the project id.
   */
  orgSlug?: string;
  storage?: import("./storage").StorageAdapter;
  storageKey?: string;
  autoRefreshToken?: boolean;
  fetch?: typeof fetch;
  /**
   * WebSocket constructor for `db.graphql.subscribe`. Defaults to the
   * runtime's global `WebSocket` (browsers, Node 22+); on older Node pass the
   * `ws` package's.
   */
  WebSocket?: new (url: string, protocols?: string | string[]) => unknown;
  headers?: Record<string, string>;
  /**
   * Runtime table metadata emitted by `excalibase-codegen`. Optional — when
   * absent the builder falls back to the enum-heuristic `[a-z_][a-z0-9_]*`
   * for filter value serialization.
   */
  schema?: SchemaMeta;
}
