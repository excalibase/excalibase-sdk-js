/**
 * Quick demo — shows the full excalibase SDK flow:
 *
 * 1. Login to get a JWT
 * 2. Run codegen against the live server → generates database.types.ts
 * 3. Use the generated schema to create a typed client
 * 4. Query via GraphQL (default)
 * 5. Query via REST (same chain, different transport)
 * 6. Filter by enum value (status = "todo")
 * 7. Insert + read back via mutation builder
 *
 * Run: npx tsx examples/quick-demo.ts
 * Requires the study-cases stack up at :10004 (graphql) + :24004 (auth).
 */

import { createClient } from "../src";
import { runCodegen, fetchIntrospection } from "../src/bin/codegen";
import { generateDatabaseFile, parseIntrospection } from "../src/codegen";
import type { SchemaMeta } from "../src/types";

const GRAPHQL_URL = "http://localhost:10004";
const AUTH_URL = "http://localhost:24004/auth";
const PROJECT = { orgSlug: "study-cases", projectName: "kanban" };

async function login(): Promise<string> {
  const base = `${AUTH_URL}/${PROJECT.orgSlug}/${PROJECT.projectName}`;
  await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@example.com", password: "Pass123!", fullName: "Demo" }),
  });
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@example.com", password: "Pass123!" }),
  });
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

async function main() {
  console.log("1. Logging in...");
  const token = await login();
  console.log(`   ✓ got JWT (${token.slice(0, 20)}...)\n`);

  // ── Step 2: Codegen ──────────────────────────────────────────────
  console.log("2. Running codegen against live server...");
  const introspection = await fetchIntrospection(
    { url: GRAPHQL_URL, token, schemas: ["kanban"], out: "" },
  );
  const parsed = parseIntrospection(introspection, { schemas: ["kanban"] });
  console.log(`   ✓ found ${parsed.tables.length} tables, ${parsed.enums.length} enums`);
  console.log(`   tables: ${parsed.tables.map((t) => t.field).join(", ")}`);
  console.log(`   enums: ${parsed.enums.map((e) => e.name).join(", ")}\n`);

  // In real usage you'd write this to a file and import it.
  // Here we use the parsed schema directly.
  const schema: SchemaMeta = {};
  for (const t of parsed.tables) {
    schema[t.field] = {
      field: t.field,
      enumColumns: t.enumColumns,
      rest: t.rest,
    };
  }

  // ── Step 3: Create typed client ──────────────────────────────────
  console.log("3. Creating typed client with generated schema...");
  const db = createClient({
    url: GRAPHQL_URL,
    projectId: `${PROJECT.orgSlug}/${PROJECT.projectName}`,
    publishableKey: "esk_pub_unused",
    schema,
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("   ✓ client ready\n");

  // ── Step 4: Query via GraphQL ────────────────────────────────────
  console.log("4. Query via GraphQL: top 5 issues...");
  const issues = await db
    .from("kanbanIssues")
    .select("id", "title", "status", "priority")
    .orderBy({ id: "asc" })
    .limit(5)
    .all();
  console.table(issues);

  // ── Step 5: Same query via REST ──────────────────────────────────
  console.log("\n5. Same query via REST (auto-derived table + profile)...");
  const restIssues = await db
    .from("kanbanIssues")
    .select("id", "title", "status")
    .limit(3)
    .via("rest")
    .all();
  console.table(restIssues);

  // ── Step 6: Filter by enum ───────────────────────────────────────
  console.log("\n6. Filter by enum: status = 'todo'...");
  const todos = await db
    .from("kanbanIssues")
    .where({ status: { eq: "todo" } })
    .select("id", "title")
    .all();
  console.log(`   found ${todos.length} todo issues:`);
  console.table(todos);

  // ── Step 7: Peek at the generated GraphQL document ───────────────
  console.log("\n7. Peek at the compiled GraphQL document:");
  const { document } = db
    .from("kanbanIssues")
    .where({ status: { eq: "todo" }, priority: { in: ["high", "critical"] } })
    .orderBy({ id: "desc" })
    .limit(10)
    .select("id", "title", "status", "priority")
    .toGraphql();
  console.log(`   ${document}\n`);

  console.log("Done!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
