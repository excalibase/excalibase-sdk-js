import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";
import type { SchemaMeta } from "../src/types";

interface Issue {
  id: number;
  title: string;
  status: "todo" | "in_progress" | "done";
  priority?: "low" | "medium" | "high";
}

interface TestDb {
  kanbanIssues: { Row: Issue; Rest: { table: "issues"; profile: "kanban" } };
}

const schema: SchemaMeta = {
  kanbanIssues: {
    field: "kanbanIssues",
    enumColumns: ["status", "priority"],
    rest: { table: "issues", profile: "kanban" },
  },
};

const baseOpts = {
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  storage: memoryStorageAdapter(),
  autoRefreshToken: false,
  schema,
};

function mockFetch(handler: (req: { method: string; url: string; body: string }) => unknown): {
  fetch: typeof fetch;
  lastBody: () => string | null;
  lastUrl: () => string | null;
} {
  let lastBody: string | null = null;
  let lastUrl: string | null = null;
  const f: typeof fetch = (async (url: string, init: RequestInit) => {
    lastUrl = url;
    lastBody = (init?.body as string) ?? null;
    const result = handler({ method: init?.method ?? "GET", url, body: lastBody ?? "" });
    return new Response(JSON.stringify({ data: result }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, lastBody: () => lastBody, lastUrl: () => lastUrl };
}

describe("QueryBuilder.insert (graphql)", () => {
  it("compiles a single-row insert mutation", () => {
    const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    const { document } = db.from("kanbanIssues").insert({ title: "Buy milk", status: "todo" }).toGraphql();
    expect(document).toContain("mutation");
    expect(document).toContain("createKanbanIssues");
    expect(document).toContain('input: { title: "Buy milk", status: todo }');
  });

  it("compiles a bulk insert mutation", () => {
    const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    const { document } = db.from("kanbanIssues").insert([
      { title: "a", status: "todo" },
      { title: "b", status: "in_progress" },
    ]).toGraphql();
    expect(document).toContain("createManyKanbanIssues");
    expect(document).toContain('inputs: [{ title: "a", status: todo }, { title: "b", status: in_progress }]');
  });

  it("returning() controls the projection on the mutation result", () => {
    const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    const { document } = db
      .from("kanbanIssues")
      .insert({ title: "x", status: "todo" })
      .returning("id", "title")
      .toGraphql();
    expect(document).toContain("{ id title }");
  });

  it("execute() POSTs the mutation document", async () => {
    const { fetch: f, lastBody } = mockFetch(() => ({ createKanbanIssues: [{ id: 99, title: "x", status: "todo" }] }));
    const db = createClient<TestDb>({ ...baseOpts, fetch: f });
    const rows = await db.from("kanbanIssues").insert({ title: "x", status: "todo" }).returning("id", "title").execute();
    expect(rows).toEqual([{ id: 99, title: "x", status: "todo" }]);
    expect(lastBody()).toContain("createKanbanIssues");
    expect(lastBody()).toContain('input: { title: \\"x\\", status: todo }');
  });
});

describe("QueryBuilder.update (graphql)", () => {
  it("compiles update with a where filter", () => {
    const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    const { document } = db
      .from("kanbanIssues")
      .update({ status: "done" })
      .where({ id: { eq: 42 } })
      .returning("id", "status")
      .toGraphql();
    expect(document).toContain("updateKanbanIssues");
    expect(document).toContain("where: { id: { eq: 42 } }");
    expect(document).toContain("input: { status: done }");
    expect(document).toContain("{ id status }");
  });

  it("update without a where filter is rejected (safety net)", () => {
    const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    expect(() =>
      db.from("kanbanIssues").update({ status: "done" }).toGraphql(),
    ).toThrow(/where/i);
  });
});

describe("QueryBuilder.delete (graphql)", () => {
  it("compiles delete with a where filter", () => {
    const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    const { document } = db
      .from("kanbanIssues")
      .delete()
      .where({ id: { eq: 42 } })
      .returning("id")
      .toGraphql();
    expect(document).toContain("deleteKanbanIssues");
    expect(document).toContain("where: { id: { eq: 42 } }");
    expect(document).toContain("{ id }");
  });

  it("delete without a where filter is rejected", () => {
    const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    expect(() => db.from("kanbanIssues").delete().toGraphql()).toThrow(/where/i);
  });
});

describe("QueryBuilder mutations (REST)", () => {
  it("insert via REST POSTs to /<table>", async () => {
    const captured: { method?: string; url?: string; body?: string } = {};
    const f: typeof fetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.method = init.method;
      captured.body = init.body as string;
      return new Response(JSON.stringify({ data: [{ id: 1, title: "x" }] }), { status: 200 });
    }) as typeof fetch;
    const db = createClient<TestDb>({ ...baseOpts, fetch: f });
    const rows = await db
      .from("kanbanIssues", { table: "issues", profile: "kanban" })
      .insert({ title: "x", status: "todo" })
      .via("rest")
      .execute();
    expect(captured.method).toBe("POST");
    expect(captured.url).toContain("/api/v1/issues");
    expect(captured.body).toBe('{"title":"x","status":"todo"}');
    expect(rows).toEqual([{ id: 1, title: "x" }]);
  });

  it("update via REST sends PATCH with filter as querystring", async () => {
    const captured: { method?: string; url?: string; body?: string } = {};
    const f: typeof fetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.method = init.method;
      captured.body = init.body as string;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const db = createClient<TestDb>({ ...baseOpts, fetch: f });
    await db
      .from("kanbanIssues", { table: "issues", profile: "kanban" })
      .update({ status: "done" })
      .where({ id: { eq: 42 } })
      .via("rest")
      .execute();
    expect(captured.method).toBe("PATCH");
    expect(captured.url).toContain("id=eq.42");
    expect(captured.body).toBe('{"status":"done"}');
  });

  it("delete via REST sends DELETE with filter as querystring", async () => {
    const captured: { method?: string; url?: string } = {};
    const f: typeof fetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.method = init.method;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const db = createClient<TestDb>({ ...baseOpts, fetch: f });
    await db
      .from("kanbanIssues", { table: "issues", profile: "kanban" })
      .delete()
      .where({ id: { eq: 42 } })
      .via("rest")
      .execute();
    expect(captured.method).toBe("DELETE");
    expect(captured.url).toContain("id=eq.42");
  });
});
