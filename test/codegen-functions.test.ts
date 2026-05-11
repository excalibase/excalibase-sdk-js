/**
 * Phase 2: codegen for the `db.functions` namespace — given a metadata
 * response from `GET /api/projects/{projectId}/functions/_metadata`, emit a
 * `functions.types.ts` file that types `db.functions.<module>.<name>(args)`.
 */

import { describe, test, expect } from "@jest/globals";
import {
  emitFunctionsTypes,
  generateFunctionsFile,
  type FunctionsMetadataResponse,
} from "../src/codegen/functions";

const fixture: FunctionsMetadataResponse = [
  {
    id: "fn-users",
    name: "users",
    runtimeShape: "v2",
    lastDeployedAt: "2026-05-11T00:00:00Z",
    exports: [
      {
        name: "list",
        kind: "query",
        argsJsonSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "inactive"] },
            limit: { type: "number" },
          },
          required: ["status"],
        },
      },
      {
        name: "create",
        kind: "mutation",
        argsJsonSchema: {
          type: "object",
          properties: {
            email: { type: "string" },
            name: { type: "string" },
          },
          required: ["email", "name"],
        },
      },
    ],
  },
  {
    id: "fn-tasks",
    name: "tasks",
    runtimeShape: "v2",
    lastDeployedAt: "2026-05-11T00:00:00Z",
    exports: [
      {
        name: "deleteAll",
        kind: "action",
        argsJsonSchema: { type: "object", properties: {} },
      },
    ],
  },
  {
    // empty-export module — should still emit a (possibly empty) Module
    // record, since downstream consumers may rely on shape stability.
    id: "fn-empty",
    name: "empty",
    runtimeShape: "v2",
    lastDeployedAt: "2026-05-11T00:00:00Z",
    exports: [],
  },
];

describe("emitFunctionsTypes", () => {
  test("emits the AUTO-GENERATED header + FunctionRef import", async () => {
    const code = await emitFunctionsTypes(fixture);
    expect(code).toContain("AUTO-GENERATED");
    expect(code).toContain('import type { FunctionRef } from "@excalibase/sdk"');
  });

  test("emits an Args type per module/export from json-schema-to-typescript", async () => {
    const code = await emitFunctionsTypes(fixture);
    // The exact name of the emitted arg type is `${Module}_${Export}_Args`
    // (PascalCase by convention) — the union of types from json-schema-to-typescript.
    expect(code).toMatch(/export (interface|type) Users_List_Args/);
    expect(code).toMatch(/export (interface|type) Users_Create_Args/);
    expect(code).toMatch(/export (interface|type) Tasks_DeleteAll_Args/);
  });

  test("emits a Functions interface mapping module → export → FunctionRef", async () => {
    const code = await emitFunctionsTypes(fixture);
    expect(code).toContain("export interface Functions");
    // Each module is its own nested record; each export is a FunctionRef<Args, unknown>.
    expect(code).toMatch(/users:\s*\{[\s\S]*list:\s*FunctionRef<Users_List_Args,\s*unknown>/);
    expect(code).toMatch(/create:\s*FunctionRef<Users_Create_Args,\s*unknown>/);
    expect(code).toMatch(/tasks:\s*\{[\s\S]*deleteAll:\s*FunctionRef<Tasks_DeleteAll_Args,\s*unknown>/);
  });

  test("handles a module with zero exports without crashing", async () => {
    const code = await emitFunctionsTypes(fixture);
    // Empty modules are emitted as `empty: {}`. (No exports means no fields.)
    expect(code).toMatch(/empty:\s*\{[\s\S]*\}/);
  });

  test("strict-tsc compatibility: generated code passes a syntactic sniff test", async () => {
    const code = await emitFunctionsTypes(fixture);
    // Cheap structural checks — no `any` leaks except where unavoidable, no
    // dangling import paths, no obvious template literals left unfilled.
    expect(code).not.toMatch(/\$\{/);
    expect(code).not.toMatch(/<TArgs>/); // unfilled placeholder
    expect(code).not.toMatch(/<TResult>/);
  });
});

describe("generateFunctionsFile (end-to-end)", () => {
  test("returns a complete file body from a metadata payload", async () => {
    const code = await generateFunctionsFile(fixture);
    expect(code).toContain("export interface Functions");
    expect(code).toContain("Users_List_Args");
  });
});
