export { createClient, DbClient } from "./client";
export type { DatabaseShape, AnyDatabase, RowOf } from "./client";
export { AuthClient } from "./auth";
export { GraphqlNamespace } from "./graphql-ns";
export { RestNamespace } from "./rest-ns";
export { QueryBuilder, str, unquoted } from "./query-builder";
export type {
  FilterOp,
  FilterValue,
  ColumnFilter,
  WhereInput,
  OrderBySpec,
  RestDescriptor,
  Transport,
} from "./query-builder";
export { TokenManager, computeExpiresAt } from "./token-manager";
export {
  memoryStorageAdapter,
  localStorageAdapter,
  defaultStorage,
  type StorageAdapter,
} from "./storage";
export { ExcalibaseError, AuthError, NetworkError, ConfigError } from "./errors";
export type {
  User,
  Session,
  AuthChangeEvent,
  AuthChangeHandler,
  Subscription,
  APIKeyInfo,
  CreateAPIKeyResult,
  CreateClientOptions,
  RawAuthResponse,
  SchemaMeta,
  TableMeta,
} from "./types";
export type {
  SignInWithPasswordCredentials,
  SignUpCredentials,
} from "./auth";
