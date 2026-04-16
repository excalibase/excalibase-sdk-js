import type { DbClient } from "./client";

/**
 * `db.rest` — clean namespace for the PostgREST-compatible surface.
 * One verb per method so call sites don't have to repeat the HTTP verb
 * string on every call and the types can be tighter per-verb.
 *
 * All methods fold in the current session's bearer token + publishable
 * key headers automatically, and wrap 401/403 responses in `AuthError`
 * and other failures in `NetworkError`. The `init` parameter is passed
 * straight through to `fetch` so you can set custom headers (like
 * `Accept-Profile` for multi-schema routing or `Prefer: count=exact`
 * for total-row-count pagination).
 *
 * Paths are relative to `/api/v1` — you don't repeat the prefix.
 */
export class RestNamespace {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: DbClient<any>) {}

  /**
   * @example
   *   const page = await db.rest.get<{
   *     data: Issue[]; pagination: { total: number };
   *   }>("/issues?select=id,title&limit=5", {
   *     headers: { "Accept-Profile": "kanban", Prefer: "count=exact" },
   *   });
   */
  get<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return this.db.rawRest<T>("GET", path, undefined, init);
  }

  /**
   * @example
   *   const created = await db.rest.post<Issue>("/issues", { title: "x" });
   */
  post<T = unknown>(path: string, body: unknown, init?: RequestInit): Promise<T> {
    return this.db.rawRest<T>("POST", path, body, init);
  }

  /**
   * @example
   *   const updated = await db.rest.patch<Issue>("/issues?id=eq.1", { title: "y" });
   */
  patch<T = unknown>(path: string, body: unknown, init?: RequestInit): Promise<T> {
    return this.db.rawRest<T>("PATCH", path, body, init);
  }

  /**
   * @example
   *   const replaced = await db.rest.put<Issue>("/issues?id=eq.1", full);
   */
  put<T = unknown>(path: string, body: unknown, init?: RequestInit): Promise<T> {
    return this.db.rawRest<T>("PUT", path, body, init);
  }

  /**
   * @example
   *   await db.rest.delete("/issues?id=eq.1");
   */
  delete<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return this.db.rawRest<T>("DELETE", path, undefined, init);
  }
}
