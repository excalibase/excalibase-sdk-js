/**
 * Public type surface for the `db.functions.<module>.<name>(args)` namespace
 * and the codegen-emitted `api.<module>.<export>` reference graph (Phase 7.1).
 *
 * `FunctionRef<TArgs, TResult>` is BOTH a callable phantom (used by the
 * `Functions` interface in `functions.types.ts` — Phase 2) AND a value-shape
 * record (used by the `api`/`internal` value graph in `api.ts` — Phase 7.1).
 *
 *   - Phase 2 path: `db.functions.users.list(args)` — the Proxy synthesizes a
 *     callable; TS sees a `FunctionRef<Args, R>` (callable) and type-checks
 *     args/result.
 *   - Phase 7.1 path: `ctx.runQuery(api.users.list, args)` — `api.users.list`
 *     is a literal `{moduleName, exportName, kind}` value annotated with
 *     `as FunctionRef<Args, R>`. The phantom `__args`/`__result` props carry
 *     types through so `ctx.runQuery` can infer them.
 *
 * The phantom props (`__args`, `__result`) never exist at runtime — they are
 * pure type carriers.
 */

/** Tag returned by the function bundler for each export. */
export type FunctionKind =
  | "query"
  | "mutation"
  | "action"
  | "internalQuery"
  | "internalMutation"
  | "internalAction";

/**
 * Canonical reference to a deployed function export.
 *
 * Runtime shape: `{ moduleName, exportName, kind? }` (other props are phantom).
 * Type shape: also callable as `(args) => Promise<TResult>` to preserve the
 * Phase 2 `db.functions.<m>.<n>(args)` ergonomics.
 */
export interface FunctionRef<TArgs, TResult> {
  /** Module name — first path segment of the function URL (e.g. `"users"`). */
  readonly moduleName: string;
  /** Export name — second path segment (e.g. `"list"`). */
  readonly exportName: string;
  /** Optional kind tag — present on codegen-emitted refs (Phase 7.1). */
  readonly kind?: FunctionKind;
  /** Phantom: never set at runtime; carries the args type for inference. */
  readonly __args?: TArgs;
  /** Phantom: never set at runtime; carries the result type for inference. */
  readonly __result?: TResult;
  /** Phase 2 callable form — Proxy synthesizes this; api.ts refs do not. */
  (args: TArgs): Promise<TResult>;
}

/**
 * Default shape used when the user does not pass a `Functions` generic to
 * `createClient`. Permissive — any module / export, args/result are loose.
 */
export interface DefaultFunctions {
  [moduleName: string]: {
    [exportName: string]: FunctionRef<Record<string, unknown>, unknown>;
  };
}
