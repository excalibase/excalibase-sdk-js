import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";
import type { SchemaMeta } from "../src/types";

interface Issue {
  id: number;
  title: string;
  status: string;
  tags: string[];
  metadata: Record<string, unknown>;
  search_vec: string;
  embedding: number[];
}

interface TestDb {
  kanbanIssues: { Row: Issue; Rest: { table: "issues"; profile: "kanban" } };
}

const schema: SchemaMeta = {
  kanbanIssues: {
    field: "kanbanIssues",
    enumColumns: ["status"],
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
  fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
};

function gql() {
  return createClient<TestDb>(baseOpts).from("kanbanIssues");
}

// ═══════════ FTS ═══════════

describe("FTS operators", () => {
  it("search → plainto_tsquery", () => {
    const { document } = gql().where({ search_vec: { search: "stripe payment" } }).select("id").toGraphql();
    expect(document).toContain('search_vec: { search: "stripe payment" }');
  });

  it("webSearch → websearch_to_tsquery", () => {
    const { document } = gql().where({ search_vec: { webSearch: "stripe OR refund" } }).select("id").toGraphql();
    expect(document).toContain('search_vec: { webSearch: "stripe OR refund" }');
  });

  it("phraseSearch → phraseto_tsquery", () => {
    const { document } = gql().where({ search_vec: { phraseSearch: "credit card" } }).select("id").toGraphql();
    expect(document).toContain('search_vec: { phraseSearch: "credit card" }');
  });

  it("rawSearch → to_tsquery", () => {
    const { document } = gql().where({ search_vec: { rawSearch: "stripe & !refund" } }).select("id").toGraphql();
    expect(document).toContain('search_vec: { rawSearch: "stripe & !refund" }');
  });

  it("FTS REST → plfts / wfts / phfts / fts", () => {
    const b = gql().where({ search_vec: { search: "stripe" } }).via("rest");
    expect(b.toRest().path).toContain("search_vec=plfts.stripe");

    const b2 = gql().where({ search_vec: { webSearch: "stripe" } }).via("rest");
    expect(b2.toRest().path).toContain("search_vec=wfts.stripe");

    const b3 = gql().where({ search_vec: { phraseSearch: "credit card" } }).via("rest");
    expect(b3.toRest().path).toContain("search_vec=phfts.credit+card");

    const b4 = gql().where({ search_vec: { rawSearch: "a & b" } }).via("rest");
    expect(b4.toRest().path).toContain("search_vec=fts.");
  });
});

// ═══════════ Regex ═══════════

describe("Regex operators", () => {
  it("regex → GraphQL regex operator", () => {
    const { document } = gql().where({ title: { regex: "^Setup" } }).select("id").toGraphql();
    expect(document).toContain('title: { regex: "^Setup" }');
  });

  it("iregex → GraphQL iregex operator", () => {
    const { document } = gql().where({ title: { iregex: "setup" } }).select("id").toGraphql();
    expect(document).toContain('title: { iregex: "setup" }');
  });

  it("regex REST → match / imatch", () => {
    const b = gql().where({ title: { regex: "^Fix" } }).via("rest");
    expect(b.toRest().path).toContain("title=match.%5EFix");

    const b2 = gql().where({ title: { iregex: "fix" } }).via("rest");
    expect(b2.toRest().path).toContain("title=imatch.fix");
  });
});

// ═══════════ JSON ═══════════

describe("JSON operators", () => {
  it("jsonContains → GraphQL contains on jsonb", () => {
    const { document } = gql().where({ metadata: { jsonContains: { color: "red" } } }).select("id").toGraphql();
    expect(document).toContain("jsonContains:");
  });

  it("containedBy → GraphQL containedBy", () => {
    const { document } = gql().where({ metadata: { containedBy: { a: 1, b: 2 } } }).select("id").toGraphql();
    expect(document).toContain("containedBy:");
  });

  it("hasKey / hasKeys / hasAnyKeys", () => {
    const d1 = gql().where({ metadata: { hasKey: "color" } }).select("id").toGraphql().document;
    expect(d1).toContain('hasKey: "color"');

    const d2 = gql().where({ metadata: { hasKeys: ["a", "b"] } }).select("id").toGraphql().document;
    expect(d2).toContain("hasKeys: [");

    const d3 = gql().where({ metadata: { hasAnyKeys: ["x", "y"] } }).select("id").toGraphql().document;
    expect(d3).toContain("hasAnyKeys: [");
  });

  it("JSON REST → jsoncontains / haskey", () => {
    const b = gql().where({ metadata: { hasKey: "color" } }).via("rest");
    expect(b.toRest().path).toContain("metadata=haskey.color");
  });
});

// ═══════════ Logical ═══════════

describe("Logical operators", () => {
  it("or() combines conditions with OR", () => {
    const { document } = gql()
      .or([
        { status: { eq: "todo" } },
        { status: { eq: "in_progress" } },
      ])
      .select("id")
      .toGraphql();
    // The server accepts: where: { _or: [...] }
    // Our serialization should emit _or
    expect(document).toContain("_or:");
  });

  it("not() negates a condition", () => {
    const { document } = gql()
      .where({ title: { not: { eq: "Setup" } } })
      .select("id")
      .toGraphql();
    expect(document).toContain("not:");
  });
});

// ═══════════ Array ═══════════

describe("Array operators", () => {
  it("arrayContains REST → cs operator", () => {
    const b = gql().where({ tags: { arrayContains: ["bug", "urgent"] } }).via("rest");
    expect(b.toRest().path).toContain("tags=cs.");
  });

  it("arrayHasAny REST → ov operator", () => {
    const b = gql().where({ tags: { arrayHasAny: ["bug"] } }).via("rest");
    expect(b.toRest().path).toContain("tags=ov.");
  });
});

// ═══════════ Vector ═══════════

describe("Vector k-NN", () => {
  it("vector() sets top-level vector arg in GraphQL", () => {
    const { document } = gql()
      .vector({ column: "embedding", near: [1.0, 0, 0], distance: "COSINE", limit: 5 })
      .select("id", "title")
      .toGraphql();
    expect(document).toContain("vector:");
    expect(document).toContain("COSINE");
    expect(document).toContain("[1, 0, 0]");
  });
});

// ═══════════ Aggregates ═══════════

describe("Aggregate builder", () => {
  it("aggregate() compiles sum/avg/min/max fields", () => {
    const { document } = gql()
      .aggregate({ count: true, sum: ["story_points"], avg: ["story_points"] })
      .toGraphql();
    expect(document).toContain("kanbanIssuesAggregate");
    expect(document).toContain("count");
    expect(document).toContain("sum { story_points }");
    expect(document).toContain("avg { story_points }");
  });
});
