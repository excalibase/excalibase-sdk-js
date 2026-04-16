import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIntrospection, emitDatabaseTypes, generateDatabaseFile } from "../src/codegen";

const introspection = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "kanban-introspection.json"), "utf-8"),
);

const codegenOpts = {
  schemas: ["kanban"],
};

describe("parseIntrospection", () => {
  it("extracts table fields and skips Aggregate / __typename", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const fieldNames = parsed.tables.map((t) => t.field).sort();
    expect(fieldNames).toEqual(["kanbanIssues", "kanbanUsers"]);
  });

  it("derives REST table+profile from the schemas option", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const issues = parsed.tables.find((t) => t.field === "kanbanIssues")!;
    expect(issues.rest).toEqual({ table: "issues", profile: "kanban" });
  });

  it("falls back to public profile when no schema prefix matches", () => {
    const parsed = parseIntrospection(introspection, { schemas: [] });
    const issues = parsed.tables.find((t) => t.field === "kanbanIssues")!;
    // No prefix matched — table is the snake_case form of the field, profile undefined
    expect(issues.rest.profile).toBeUndefined();
    expect(issues.rest.table).toBe("kanban_issues");
  });

  it("captures column types and enum membership", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const issues = parsed.tables.find((t) => t.field === "kanbanIssues")!;
    const cols = Object.fromEntries(issues.columns.map((c) => [c.name, c]));
    expect(cols.id?.tsType).toBe("number");
    expect(cols.title?.tsType).toBe("string");
    expect(cols.title?.nullable).toBe(false);
    expect(cols.description?.nullable).toBe(true);
    expect(cols.active?.tsType).toBe("boolean");
    expect(cols.status?.tsType).toBe("KanbanIssueStatus");
    expect(cols.status?.isEnum).toBe(true);
    expect(cols.priority?.isEnum).toBe(true);
    expect(cols.priority?.nullable).toBe(true);
  });

  it("collects all enum types with their members", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const enumNames = parsed.enums.map((e) => e.name).sort();
    expect(enumNames).toEqual(["KanbanIssueStatus", "KanbanPriority"]);
    const status = parsed.enums.find((e) => e.name === "KanbanIssueStatus")!;
    expect(status.members).toEqual(["todo", "in_progress", "done"]);
  });

  it("flags enumColumns per table for runtime SchemaMeta", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const issues = parsed.tables.find((t) => t.field === "kanbanIssues")!;
    expect(issues.enumColumns.sort()).toEqual(["priority", "status"]);
  });
});

describe("emitDatabaseTypes", () => {
  it("emits per-enum union types", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const code = emitDatabaseTypes(parsed);
    expect(code).toContain('export type KanbanIssueStatus = "todo" | "in_progress" | "done"');
    expect(code).toContain('export type KanbanPriority = "low" | "medium" | "high"');
  });

  it("emits a Row interface per table with nullable columns marked", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const code = emitDatabaseTypes(parsed);
    // Required columns: no `?`. Nullable columns: `| null`.
    expect(code).toMatch(/export interface KanbanIssueRow \{[^}]*id: number;/);
    expect(code).toMatch(/title: string;/);
    expect(code).toMatch(/description: string \| null;/);
    expect(code).toMatch(/status: KanbanIssueStatus;/);
    expect(code).toMatch(/priority: KanbanPriority \| null;/);
    expect(code).toContain("export interface KanbanUserRow");
  });

  it("emits a Database interface mapping field → { Row, Rest }", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const code = emitDatabaseTypes(parsed);
    expect(code).toContain("export interface Database");
    expect(code).toMatch(/kanbanIssues: \{\s*Row: KanbanIssueRow;\s*Rest: \{ table: "issues"; profile: "kanban" \};\s*\}/);
    expect(code).toMatch(/kanbanUsers: \{\s*Row: KanbanUserRow;\s*Rest: \{ table: "users"; profile: "kanban" \};\s*\}/);
  });

  it("emits a runtime SchemaMeta const with enumColumns + rest mapping", () => {
    const parsed = parseIntrospection(introspection, codegenOpts);
    const code = emitDatabaseTypes(parsed);
    expect(code).toContain('export const schema');
    expect(code).toContain('SchemaMeta');
    expect(code).toMatch(/kanbanIssues: \{[^}]*field: "kanbanIssues"/);
    expect(code).toMatch(/enumColumns: \["priority", "status"\]/);
    expect(code).toMatch(/rest: \{ table: "issues", profile: "kanban" \}/);
  });

  it("emits the AUTO-GENERATED header and the SchemaMeta type import", () => {
    const code = emitDatabaseTypes(parseIntrospection(introspection, codegenOpts));
    expect(code).toContain("AUTO-GENERATED");
    expect(code).toContain('import type { SchemaMeta } from "@excalibase/sdk"');
  });
});

describe("generateDatabaseFile (end-to-end)", () => {
  it("returns a complete file body when given the raw introspection", () => {
    const code = generateDatabaseFile(introspection, codegenOpts);
    expect(code).toContain("export interface Database");
    expect(code).toContain("export const schema");
    expect(code).toContain("KanbanIssueRow");
  });
});
