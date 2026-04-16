import { createClient, str, unquoted, ConfigError } from "../src";
import { memoryStorageAdapter } from "../src/storage";
import type { QueryBuilder } from "../src/query-builder";

const baseOpts = {
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  storage: memoryStorageAdapter(),
  autoRefreshToken: false,
};

interface Issue {
  id: number;
  title: string;
  status: string;
  priority: string;
  created_at: string;
}

interface TestDb {
  kanbanIssues: { Row: Issue; Rest: { table: "issues"; profile: "kanban" } };
}

function makeBuilder(): QueryBuilder<Issue> {
  const db = createClient<TestDb>({ ...baseOpts, fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch });
  return db.from("kanbanIssues", { table: "issues", profile: "kanban" });
}

describe("QueryBuilder.toGraphql", () => {
  it("compiles a minimal query with default projection", () => {
    const { document } = makeBuilder().toGraphql();
    expect(document).toBe("{ kanbanIssues { __typename } }");
  });

  it("compiles select(...columns) into the projection", () => {
    const { document } = makeBuilder().select("id", "title", "status").toGraphql();
    expect(document).toBe("{ kanbanIssues { id title status } }");
  });

  it("compiles limit + offset", () => {
    const { document } = makeBuilder().limit(10).offset(20).toGraphql();
    expect(document).toBe("{ kanbanIssues(limit: 10, offset: 20) { __typename } }");
  });

  it("compiles orderBy into graphql enum direction", () => {
    const { document } = makeBuilder().orderBy({ id: "desc", title: "asc" }).toGraphql();
    expect(document).toBe("{ kanbanIssues(orderBy: { id: DESC, title: ASC }) { __typename } }");
  });

  it("compiles where with eq (enum-like value unquoted)", () => {
    const { document } = makeBuilder().where({ status: { eq: "todo" } }).toGraphql();
    expect(document).toBe("{ kanbanIssues(where: { status: { eq: todo } }) { __typename } }");
  });

  it("quotes strings that aren't enum-safe", () => {
    const { document } = makeBuilder().where({ title: { eq: "Hello World" } }).toGraphql();
    expect(document).toBe('{ kanbanIssues(where: { title: { eq: "Hello World" } }) { __typename } }');
  });

  it("supports str() to force a quoted string literal", () => {
    const { document } = makeBuilder().where({ title: { eq: str("alpha") } }).toGraphql();
    expect(document).toBe('{ kanbanIssues(where: { title: { eq: "alpha" } }) { __typename } }');
  });

  it("supports unquoted() to force a bare identifier (enum value)", () => {
    const { document } = makeBuilder()
      .where({ status: { eq: unquoted("in_progress") } })
      .toGraphql();
    expect(document).toBe("{ kanbanIssues(where: { status: { eq: in_progress } }) { __typename } }");
  });

  it("compiles in: [...] for enum-like arrays", () => {
    const { document } = makeBuilder()
      .where({ status: { in: ["todo", "done"] } })
      .toGraphql();
    expect(document).toBe("{ kanbanIssues(where: { status: { in: [todo, done] } }) { __typename } }");
  });

  it("compiles numeric and boolean filters", () => {
    const { document } = makeBuilder()
      .where({ id: { gte: 5 }, priority: { eq: "high" } })
      .toGraphql();
    expect(document).toBe(
      "{ kanbanIssues(where: { id: { gte: 5 }, priority: { eq: high } }) { __typename } }",
    );
  });

  it("composes the full chain in argument order", () => {
    const { document } = makeBuilder()
      .where({ status: { eq: "todo" } })
      .orderBy({ id: "desc" })
      .limit(10)
      .offset(0)
      .select("id", "title")
      .toGraphql();
    expect(document).toBe(
      "{ kanbanIssues(where: { status: { eq: todo } }, orderBy: { id: DESC }, limit: 10, offset: 0) { id title } }",
    );
  });
});

describe("QueryBuilder.toRest", () => {
  it("compiles a minimal GET with default select", () => {
    const { path, headers } = makeBuilder().toRest();
    expect(path).toBe("/issues");
    expect(headers["Accept-Profile"]).toBe("kanban");
  });

  it("compiles select into ?select=...", () => {
    const { path } = makeBuilder().select("id", "title").toRest();
    expect(path).toBe("/issues?select=id%2Ctitle");
  });

  it("compiles limit + offset", () => {
    const { path } = makeBuilder().limit(10).offset(20).toRest();
    expect(path).toBe("/issues?limit=10&offset=20");
  });

  it("compiles orderBy to ?order=col.dir,col.dir", () => {
    const { path } = makeBuilder().orderBy({ id: "desc", title: "asc" }).toRest();
    expect(path).toBe("/issues?order=id.desc%2Ctitle.asc");
  });

  it("compiles where.eq to PostgREST eq.value", () => {
    const { path } = makeBuilder().where({ status: { eq: "todo" } }).toRest();
    expect(path).toBe("/issues?status=eq.todo");
  });

  it("compiles where.in to PostgREST in.(...)", () => {
    const { path } = makeBuilder().where({ status: { in: ["todo", "done"] } }).toRest();
    // URLSearchParams URL-encodes parens but PostgREST accepts them
    expect(path).toContain("status=in.");
    expect(decodeURIComponent(path)).toBe("/issues?status=in.(todo,done)");
  });

  it("throws when toRest() is called without a REST descriptor", () => {
    const db = createClient({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    const builder = db.from("kanbanIssues"); // no rest descriptor
    expect(() => builder.toRest()).toThrow(ConfigError);
  });

  it("via('rest') throws when no REST descriptor provided", () => {
    const db = createClient({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    const builder = db.from("kanbanIssues");
    expect(() => builder.via("rest")).toThrow(ConfigError);
  });

  it("via('graphql') always works", () => {
    const db = createClient({ ...baseOpts, fetch: (async () => new Response("{}")) as typeof fetch });
    expect(() => db.from("kanbanIssues").via("graphql")).not.toThrow();
  });
});

describe("QueryBuilder terminal methods (GraphQL transport)", () => {
  function mockFetch(handler: (body: string) => unknown): { fetch: typeof fetch; lastBody: () => string } {
    let lastBody = "";
    const fn: typeof fetch = async (_input, init = {}) => {
      lastBody = (init.body as string) ?? "";
      const payload = handler(lastBody);
      return new Response(JSON.stringify({ data: payload }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetch: fn, lastBody: () => lastBody };
  }

  it("all() returns the rows under the field key", async () => {
    const { fetch: f, lastBody } = mockFetch(() => ({
      kanbanIssues: [
        { id: 1, title: "a" },
        { id: 2, title: "b" },
      ],
    }));
    const db = createClient<TestDb>({ ...baseOpts, fetch: f });
    const rows = await db.from("kanbanIssues", { table: "issues", profile: "kanban" }).select("id", "title").limit(2).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(1);
    expect(lastBody()).toContain("kanbanIssues(limit: 2)");
  });

  it("first() returns one row and injects limit=1", async () => {
    const { fetch: f, lastBody } = mockFetch(() => ({
      kanbanIssues: [{ id: 1, title: "a" }],
    }));
    const db = createClient<TestDb>({ ...baseOpts, fetch: f });
    const row = await db.from("kanbanIssues", { table: "issues", profile: "kanban" }).first();
    expect(row?.id).toBe(1);
    expect(lastBody()).toContain("limit: 1");
  });

  it("first() returns null on empty result", async () => {
    const { fetch: f } = mockFetch(() => ({ kanbanIssues: [] }));
    const db = createClient({ ...baseOpts, fetch: f });
    const row = await db.from("kanbanIssues").first();
    expect(row).toBeNull();
  });

  it("count() hits the aggregate field with the same where", async () => {
    const { fetch: f, lastBody } = mockFetch(() => ({
      kanbanIssuesAggregate: { count: 7 },
    }));
    const db = createClient({ ...baseOpts, fetch: f });
    const n = await db.from("kanbanIssues").where({ status: { eq: "todo" } }).count();
    expect(n).toBe(7);
    expect(lastBody()).toContain("kanbanIssuesAggregate(where: { status: { eq: todo } })");
  });

  it("count() with no where hits the aggregate field without args", async () => {
    const { fetch: f, lastBody } = mockFetch(() => ({
      kanbanIssuesAggregate: { count: 15 },
    }));
    const db = createClient({ ...baseOpts, fetch: f });
    const n = await db.from("kanbanIssues").count();
    expect(n).toBe(15);
    expect(lastBody()).toMatch(/kanbanIssuesAggregate\s*{\s*count\s*}/);
  });
});

describe("QueryBuilder terminal methods (REST transport)", () => {
  it("all() via REST unwraps the { data } envelope", async () => {
    let capturedUrl = "";
    const f: typeof fetch = async (input) => {
      capturedUrl = typeof input === "string" ? input : (input as URL).toString();
      return new Response(JSON.stringify({ data: [{ id: 1, title: "x" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const db = createClient<TestDb>({ ...baseOpts, fetch: f });
    const rows = await db
      .from("kanbanIssues", { table: "issues", profile: "kanban" })
      .via("rest")
      .where({ status: { eq: "todo" } })
      .limit(5)
      .select("id", "title")
      .all();
    expect(rows).toEqual([{ id: 1, title: "x" }]);
    expect(capturedUrl).toContain("/api/v1/issues");
    expect(capturedUrl).toContain("status=eq.todo");
    expect(capturedUrl).toContain("limit=5");
  });

  it("count() via REST uses Prefer: count=exact", async () => {
    let capturedHeaders: Record<string, string> = {};
    const f: typeof fetch = async (_input, init = {}) => {
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ data: [{ id: 1 }], pagination: { total: 42, limit: 1, offset: 0 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const db = createClient({ ...baseOpts, fetch: f });
    const n = await db
      .from("kanbanIssues", { table: "issues", profile: "kanban" })
      .via("rest")
      .where({ status: { eq: "todo" } })
      .count();
    expect(n).toBe(42);
    expect(capturedHeaders["Prefer"]).toBe("count=exact");
    expect(capturedHeaders["Accept-Profile"]).toBe("kanban");
  });
});
