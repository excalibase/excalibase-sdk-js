import { createClient, type DbClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";

// A user-supplied Database type — in practice this comes from `excalibase-codegen`.
interface KanbanIssueRow {
  id: number;
  title: string;
  status: "todo" | "in_progress" | "done";
}

interface KanbanUserRow {
  id: number;
  name: string;
  email: string | null;
}

interface Database {
  kanbanIssues: {
    Row: KanbanIssueRow;
    Rest: { table: "issues"; profile: "kanban" };
  };
  kanbanUsers: {
    Row: KanbanUserRow;
    Rest: { table: "users"; profile: "kanban" };
  };
}

const baseOpts = {
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  storage: memoryStorageAdapter(),
  autoRefreshToken: false,
  fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
};

describe("createClient<Database> generic", () => {
  it("returns a typed client when Database is bound", () => {
    const db: DbClient<Database> = createClient<Database>(baseOpts);
    expect(db).toBeDefined();
    expect(typeof db.from).toBe("function");
  });

  it("db.from(key) returns QueryBuilder<Row> for the matching table", () => {
    const db = createClient<Database>(baseOpts);
    const builder = db.from("kanbanIssues");
    // The select() chain accepts only column names of KanbanIssueRow.
    const { document } = builder.select("id", "title", "status").toGraphql();
    expect(document).toBe("{ kanbanIssues { id title status } }");
  });

  it("db.from(invalidKey) is rejected at compile time", () => {
    const db = createClient<Database>(baseOpts);
    // @ts-expect-error — "doesNotExist" is not a key of Database
    const _shouldFail = db.from("doesNotExist");
    expect(_shouldFail).toBeDefined();
  });

  it("select() rejects unknown columns at compile time", () => {
    const db = createClient<Database>(baseOpts);
    const builder = db.from("kanbanUsers");
    // @ts-expect-error — "not_a_column" is not a key of KanbanUserRow
    const _shouldFail = builder.select("id", "not_a_column");
    expect(_shouldFail).toBeDefined();
  });

  it("createClient without a Database generic still works (untyped fallback)", () => {
    const db = createClient(baseOpts);
    const builder = db.from("anything", { table: "anything" });
    // Untyped — select accepts any string.
    const { document } = builder.select("a", "b").toGraphql();
    expect(document).toBe("{ anything { a b } }");
  });
});
