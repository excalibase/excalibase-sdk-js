import type { DbClient } from "./client";

/**
 * `db.graphql` — clean namespace for executing raw GraphQL documents.
 * Split into `query()` and `mutation()` so call sites read naturally and
 * so a future caching layer can key on intent without parsing the document.
 *
 * Both methods are thin passthroughs to the underlying graphql-request
 * client with the current session's auth headers folded in automatically.
 * No query-builder, no RPC wrapper — you write GraphQL, the SDK sends it.
 */
export class GraphqlNamespace {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: DbClient<any>) {}

  /**
   * Execute a GraphQL query document.
   *
   * @example
   *   const data = await db.graphql.query<{ kanbanIssues: Issue[] }>(`
   *     { kanbanIssues(limit: 5) { id title status } }
   *   `);
   */
  query<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
    document: string,
    variables?: V,
  ): Promise<T> {
    return this.db.rawGraphql<T, V>(document, variables);
  }

  /**
   * Execute a GraphQL mutation document. Behaviorally identical to `query()`
   * — the split exists so call sites read naturally and a future caching
   * layer can skip mutations without parsing.
   *
   * @example
   *   const out = await db.graphql.mutation<{ createKanbanIssue: Issue }>(`
   *     mutation ($input: CreateKanbanIssueInput!) {
   *       createKanbanIssue(input: $input) { id title }
   *     }
   *   `, { input: { title: "New issue" } });
   */
  mutation<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
    document: string,
    variables?: V,
  ): Promise<T> {
    return this.db.rawGraphql<T, V>(document, variables);
  }
}
