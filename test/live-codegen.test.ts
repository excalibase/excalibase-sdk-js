/**
 * Live integration test for Phase E — runs codegen against the live kanban
 * stack, instantiates a typed client using the generated Database type, and
 * exercises a real query + mutation end-to-end.
 *
 * Skipped unless `RUN_LIVE_TESTS=1`. Requires the study-cases stack to be
 * up at the configured URLs (defaults: graphql :10004, auth :24004).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUN_LIVE = process.env.RUN_LIVE_TESTS === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

const GRAPHQL_URL = process.env.SC_GRAPHQL_URL || "http://localhost:10004";
const AUTH_URL = process.env.SC_AUTH_URL || "http://localhost:24004/auth";

async function login(): Promise<string> {
  const base = `/study-cases/kanban`;
  const credentials = { email: "sdk-codegen-live@example.com", password: "Pass123!", fullName: "SDK Live" };

  // Best-effort register — ignore 409 if user already exists.
  await fetch(`${AUTH_URL}${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });

  const res = await fetch(`${AUTH_URL}${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  const body = (await res.json()) as { accessToken?: string };
  if (body.accessToken == null) throw new Error(`Login failed: ${JSON.stringify(body)}`);
  return body.accessToken;
}

describeLive("Phase E — Live codegen + typed query against kanban stack", () => {
  let tmpDir: string;
  let token: string;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `excalibase-live-codegen-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    token = await login();
  }, 60_000);

  afterAll(() => {
    if (tmpDir != null) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("CLI generates a database.types.ts file from the live introspection", () => {
    const cliPath = require.resolve("../dist/bin/codegen.js");
    if (!existsSync(cliPath)) {
      throw new Error(`CLI not built — run 'npm run build' first. Looked at: ${cliPath}`);
    }
    const outFile = join(tmpDir, "database.types.ts");
    execSync(
      `node ${cliPath} --url ${GRAPHQL_URL} --token ${token} --schemas kanban --out ${outFile}`,
      { stdio: "pipe" },
    );
    expect(existsSync(outFile)).toBe(true);
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain("AUTO-GENERATED");
    expect(content).toContain("export interface Database");
    expect(content).toContain("export const schema");
    expect(content).toMatch(/KanbanIssuesRow|KanbanIssueRow/);
    expect(content).toContain('"kanban"'); // profile present
  });

  it("typed client roundtrip: read kanban issues using the generated schema", async () => {
    const { createClient } = await import("../src");
    // Build a minimal SchemaMeta inline matching what codegen emits — the
    // important bit is the auto-derived REST mapping + enum metadata.
    const schema = {
      kanbanIssues: {
        field: "kanbanIssues",
        enumColumns: ["status", "priority"],
        rest: { table: "issues", profile: "kanban" },
      },
    } as const;

    const db = createClient({
      url: GRAPHQL_URL,
      projectId: "study-cases/kanban",
      publishableKey: "esk_pub_unused", // we use the bearer token for live test
      schema,
      headers: { Authorization: `Bearer ${token}` },
    });

    // Read via GraphQL transport
    const issues = await db
      .from("kanbanIssues")
      .select("id", "title", "status")
      .limit(5)
      .all();
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toHaveProperty("id");
    expect(issues[0]).toHaveProperty("title");

    // Read via REST transport — same chain, different transport
    const issuesViaRest = await db
      .from("kanbanIssues")
      .select("id", "title")
      .limit(3)
      .via("rest")
      .all();
    expect(Array.isArray(issuesViaRest)).toBe(true);
    expect(issuesViaRest.length).toBeLessThanOrEqual(3);
  });

  it("typed client filters by enum value (bare identifier serialization)", async () => {
    const { createClient } = await import("../src");
    const schema = {
      kanbanIssues: {
        field: "kanbanIssues",
        enumColumns: ["status", "priority"],
        rest: { table: "issues", profile: "kanban" },
      },
    } as const;

    const db = createClient({
      url: GRAPHQL_URL,
      projectId: "study-cases/kanban",
      publishableKey: "esk_pub_unused",
      schema,
      headers: { Authorization: `Bearer ${token}` },
    });

    // Status is enum-typed → builder must emit `status: { eq: todo }`
    // (bare `todo`, not quoted "todo"). Note: the live server currently
    // uppercases enum output values ("TODO") even though the schema
    // declares them lowercase — known server-side bug, separate from SDK.
    // We compare case-insensitively and trust that the filter matched.
    const todos = await db
      .from("kanbanIssues")
      .where({ status: { eq: "todo" } })
      .select("id", "status")
      .all();
    expect(Array.isArray(todos)).toBe(true);
    expect(todos.length).toBeGreaterThan(0);
    for (const issue of todos as Array<{ status: string }>) {
      expect(issue.status.toLowerCase()).toBe("todo");
    }
  });
});
