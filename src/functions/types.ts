/**
 * Public type surface for the `db.functions.<module>.<name>(args)` namespace.
 *
 * `FunctionRef<TArgs, TResult>` is a phantom type — at runtime it doesn't
 * exist as a discrete value (the Proxy synthesizes a call), but it lets
 * codegen-emitted `Functions` interfaces give callers fully typed call
 * signatures via the `createClient<DB, F>` generic.
 *
 * Codegen emits a `Functions` interface (see {@link DefaultFunctions} for
 * the fallback shape). Users importing the generated `functions.types.ts`
 * pass that interface as the second generic to `createClient`.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface FunctionRef<TArgs, TResult> {
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
