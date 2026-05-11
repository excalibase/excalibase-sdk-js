/**
 * Error thrown when a `db.functions.<module>.<name>(args)` call fails.
 *
 * Two failure modes:
 *   - validation: server returned `{ error: "validation", issues: [...] }`.
 *     `issues` is the zod-style array surfaced via the v2 dispatch.
 *   - runtime: server returned `{ error: <string> }` (no `issues`). Treated
 *     as a generic runtime failure; the message is preserved on `.message`.
 */
export interface ValidationIssue {
  path?: ReadonlyArray<string | number>;
  message?: string;
  code?: string;
  [key: string]: unknown;
}

export class FunctionsError extends Error {
  readonly name = "FunctionsError" as const;
  readonly code: string;
  readonly status: number;
  readonly issues?: ReadonlyArray<ValidationIssue>;

  constructor(
    message: string,
    opts: { code?: string; status?: number; issues?: ReadonlyArray<ValidationIssue> } = {},
  ) {
    super(message);
    this.code = opts.code ?? "functions_error";
    this.status = opts.status ?? 0;
    if (opts.issues != null) this.issues = opts.issues;
  }
}
