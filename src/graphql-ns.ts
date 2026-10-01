import type { DbClient } from "./client";
import { subscribe, type SubscriptionHandlers } from "./realtime";
import type { Subscription } from "./types";

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
  constructor(private readonly db: DbClient<any, any>) {}

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

  /**
   * Subscribe over the project's realtime WebSocket
   * (`{projectId}/graphql`, graphql-transport-ws). The current session's
   * token and the client's headers go in `connection_init`; each change
   * reaches only callers whose permissions cover the row.
   *
   * @example
   *   const sub = db.graphql.subscribe<{ publicOrdersChanges: Change }>(
   *     "subscription { publicOrdersChanges { operation data } }",
   *     { next: (data) => console.log(data.publicOrdersChanges), error: console.warn },
   *   );
   *   sub.unsubscribe();
   */
  subscribe<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
    document: string,
    handlers: SubscriptionHandlers<T>,
    variables?: V,
  ): Subscription {
    const WebSocket = this.db.webSocketConstructor();
    return subscribe<T>(
      {
        url: this.db.realtimeEndpoint(),
        query: document,
        variables,
        connectionPayload: () => connectionPayload(this.db.buildHeaders()),
        WebSocket,
      },
      handlers,
    );
  }
}

function connectionPayload(headers: Record<string, string>): Record<string, unknown> {
  const { Authorization, ...rest } = headers;
  return Authorization === undefined ? { headers: rest } : { Authorization, headers: rest };
}
