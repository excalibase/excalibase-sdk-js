import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";
import type { SchemaMeta } from "../src/types";

const baseOpts = {
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  storage: memoryStorageAdapter(),
  autoRefreshToken: false,
  fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
};

const schema: SchemaMeta = {
  kanbanIssues: {
    field: "kanbanIssues",
    enumColumns: ["status", "priority"],
    rest: { table: "issues", profile: "kanban" },
  },
  publicUsers: {
    field: "publicUsers",
    enumColumns: [],
    rest: { table: "users" },
  },
};

describe("Auto-derived REST descriptor", () => {
  it("uses schema.rest when caller omits the rest descriptor on db.from()", () => {
    const db = createClient({ ...baseOpts, schema });
    const builder = db.from("kanbanIssues").via("rest");
    const { path, headers } = builder.toRest();
    expect(path).toBe("/issues");
    expect(headers["Accept-Profile"]).toBe("kanban");
  });

  it("works for tables without a profile (public schema)", () => {
    const db = createClient({ ...baseOpts, schema });
    const { path, headers } = db.from("publicUsers").via("rest").toRest();
    expect(path).toBe("/users");
    expect(headers["Accept-Profile"]).toBeUndefined();
  });

  it("explicit rest descriptor on db.from() still wins over schema lookup", () => {
    const db = createClient({ ...baseOpts, schema });
    const { path, headers } = db
      .from("kanbanIssues", { table: "override_table", profile: "override_profile" })
      .via("rest")
      .toRest();
    expect(path).toBe("/override_table");
    expect(headers["Accept-Profile"]).toBe("override_profile");
  });

  it("throws when neither schema nor explicit descriptor is available", () => {
    const db = createClient({ ...baseOpts /* no schema */ });
    expect(() => db.from("kanbanIssues").via("rest")).toThrow(/REST descriptor/);
  });

  it("uses schema.enumColumns to keep bare enum identifiers in graphql output", () => {
    const db = createClient({ ...baseOpts, schema });
    const { document } = db
      .from("kanbanIssues")
      // status is enum-typed → must be emitted as bare identifier `todo`,
      // not quoted "todo". Without schema metadata the heuristic also gets
      // this right by accident, but with schema metadata it must work for
      // any enum value (including ones that don't match the heuristic).
      .where({ status: { eq: "todo" } })
      .toGraphql();
    expect(document).toContain("status: { eq: todo }");
    expect(document).not.toContain('status: { eq: "todo" }');
  });

  it("quotes a non-enum string column even if value looks identifier-like", () => {
    const db = createClient({ ...baseOpts, schema });
    // `title` is not in enumColumns → must be quoted.
    const { document } = db
      .from("kanbanIssues")
      .where({ title: { eq: "ready" } })
      .toGraphql();
    expect(document).toContain('title: { eq: "ready" }');
  });
});
