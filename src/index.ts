export { createClient, DbClient } from "./client";
export { defineSchema, defineCollection, CollectionClient, NoSqlNamespace, resetNoSqlDeprecationWarning } from "./nosql";
export type { SchemaDeclaration, CollectionDef, IndexDef as NoSqlIndexDef, FindOptions, UpdateOp } from "./nosql";
export { FunctionsNamespace } from "./functions/namespace";
export { FunctionsError } from "./functions/error";
export type { ValidationIssue } from "./functions/error";
export type { FunctionRef, DefaultFunctions } from "./functions/types";
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
  VectorSearchInput,
  AggregateInput,
  MutationKind,
  ForceQuoted,
  ForceUnquoted,
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
