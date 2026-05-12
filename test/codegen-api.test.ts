/**
 * Phase 7.1: codegen for the typed `api.<module>.<export>` reference graph.
 *
 * Verifies that {@link emitApiFile} (and the `generateApiFile` wrapper)
 * produces a runtime value module — NOT just types — shaped like:
 *
 *   export const api = {
 *     users: {
 *       list: { moduleName: "users", exportName: "list", kind: "query" }
 *               as FunctionRef<Users_List_Args, unknown>,
 *       ...
 *     },
 *   } as const;
 *
 *   export const internal = { ... } as const;
 *
 * Internal exports (`internalQuery`/`internalMutation`/`internalAction`) go in
 * the `internal` namespace; public ones go in `api`. Each ref is annotated
 * with `as FunctionRef<...>` so call sites like
 * `ctx.runQuery(api.users.list, args)` are end-to-end typed.
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import {
  emitApiFile,
  generateApiFile,
  type FunctionsMetadataResponse,
} from "../src/codegen/functions";
import { fetchFunctionsMetadata, runFunctionsCodegen } from "../src/bin/codegen";

// Public + internal mix across 3 modules, 5 exports total.
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
    id: "fn-posts",
    name: "posts",
    runtimeShape: "v2",
    lastDeployedAt: "2026-05-11T00:00:00Z",
    exports: [
      {
        name: "feed",
        kind: "query",
        argsJsonSchema: {
          type: "object",
          properties: { userId: { type: "string" } },
          required: ["userId"],
        },
      },
    ],
  },
  {
    id: "fn-admin",
    name: "admin",
    runtimeShape: "v2",
    lastDeployedAt: "2026-05-11T00:00:00Z",
    exports: [
      {
        name: "cleanup",
        kind: "internalMutation",
        argsJsonSchema: {
          type: "object",
          properties: { olderThanDays: { type: "number" } },
          required: ["olderThanDays"],
        },
      },
      {
        name: "auditLog",
        kind: "internalQuery",
        argsJsonSchema: {
          type: "object",
          properties: { userId: { type: "string" } },
          required: ["userId"],
        },
      },
    ],
  },
];

describe("emitApiFile", () => {
  test("emits the AUTO-GENERATED header + FunctionRef import", async () => {
    const code = await emitApiFile(fixture);
    expect(code).toContain("AUTO-GENERATED");
    expect(code).toContain('import type { FunctionRef } from "@excalibase/sdk"');
  });

  test("emits Args interfaces for every export (public + internal)", async () => {
    const code = await emitApiFile(fixture);
    expect(code).toMatch(/export (interface|type) Users_List_Args/);
    expect(code).toMatch(/export (interface|type) Users_Create_Args/);
    expect(code).toMatch(/export (interface|type) Posts_Feed_Args/);
    expect(code).toMatch(/export (interface|type) Admin_Cleanup_Args/);
    expect(code).toMatch(/export (interface|type) Admin_AuditLog_Args/);
  });

  test("emits `export const api = { ... } as const` with public exports only", async () => {
    const code = await emitApiFile(fixture);
    expect(code).toMatch(/export const api =/);
    expect(code).toMatch(/users:\s*\{/);
    expect(code).toMatch(/posts:\s*\{/);
    // Each ref carries moduleName + exportName + kind as literal strings.
    expect(code).toMatch(/moduleName:\s*"users"/);
    expect(code).toMatch(/exportName:\s*"list"/);
    expect(code).toMatch(/kind:\s*"query"/);
    expect(code).toMatch(/kind:\s*"mutation"/);
    // `as FunctionRef<Args, unknown>` cast for typed call sites.
    expect(code).toMatch(/as FunctionRef<Users_List_Args,\s*unknown>/);
    expect(code).toMatch(/as FunctionRef<Users_Create_Args,\s*unknown>/);
    expect(code).toMatch(/as FunctionRef<Posts_Feed_Args,\s*unknown>/);
    expect(code).toMatch(/\}\s*as const/);
  });

  test("emits `export const internal = { ... } as const` with internal exports only", async () => {
    const code = await emitApiFile(fixture);
    expect(code).toMatch(/export const internal =/);
    expect(code).toMatch(/admin:\s*\{/);
    expect(code).toMatch(/kind:\s*"internalMutation"/);
    expect(code).toMatch(/kind:\s*"internalQuery"/);
    expect(code).toMatch(/as FunctionRef<Admin_Cleanup_Args,\s*unknown>/);
    expect(code).toMatch(/as FunctionRef<Admin_AuditLog_Args,\s*unknown>/);
  });

  test("does NOT place internal exports under `api` or public exports under `internal`", async () => {
    const code = await emitApiFile(fixture);
    // Crude segmentation: split on `export const internal` and check `api`
    // half doesn't reference internal kinds, and vice versa.
    const apiIdx = code.indexOf("export const api =");
    const internalIdx = code.indexOf("export const internal =");
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(internalIdx).toBeGreaterThan(apiIdx);
    const apiBlock = code.slice(apiIdx, internalIdx);
    const internalBlock = code.slice(internalIdx);
    expect(apiBlock).not.toMatch(/"internal(Query|Mutation|Action)"/);
    expect(internalBlock).not.toContain('kind: "query"');
    expect(internalBlock).not.toContain('kind: "mutation"');
  });

  test("omits modules whose entire export set falls in the opposite namespace", async () => {
    // `admin` is 100% internal → `api` must not contain an `admin:` key.
    const code = await emitApiFile(fixture);
    const apiIdx = code.indexOf("export const api =");
    const internalIdx = code.indexOf("export const internal =");
    const apiBlock = code.slice(apiIdx, internalIdx);
    expect(apiBlock).not.toMatch(/^\s+admin:\s*\{/m);
  });

  test("emits empty `internal` block when no internal exports exist", async () => {
    const onlyPublic: FunctionsMetadataResponse = [
      {
        id: "fn-users",
        name: "users",
        runtimeShape: "v2",
        lastDeployedAt: "2026-05-11T00:00:00Z",
        exports: [
          {
            name: "list",
            kind: "query",
            argsJsonSchema: { type: "object", properties: {} },
          },
        ],
      },
    ];
    const code = await emitApiFile(onlyPublic);
    expect(code).toMatch(/export const internal =\s*\{\s*\}\s*as const/);
  });
});

describe("generateApiFile end-to-end", () => {
  test("returns full file body suitable for writing to disk", async () => {
    const code = await generateApiFile(fixture);
    expect(code).toContain("export const api");
    expect(code).toContain("export const internal");
    expect(code).toContain("Users_List_Args");
  });
});

// ---------------- TS strict compilation harness ----------------

describe("generated api.ts compiles under tsc --strict", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "excalibase-api-codegen-"));

    // Write a local `@excalibase/sdk` shim that re-exports FunctionRef
    // (matches what the SDK ships) so the generated import resolves.
    const sdkShimDir = join(tmpDir, "node_modules", "@excalibase", "sdk");
    mkdirSync(sdkShimDir, { recursive: true });
    writeFileSync(
      join(sdkShimDir, "index.d.ts"),
      `export type FunctionKind = "query" | "mutation" | "action" | "internalQuery" | "internalMutation" | "internalAction";
       export interface FunctionRef<TArgs, TResult> {
         readonly moduleName: string;
         readonly exportName: string;
         readonly kind?: FunctionKind;
         readonly __args?: TArgs;
         readonly __result?: TResult;
         (args: TArgs): Promise<TResult>;
       }
      `,
      "utf-8",
    );
    writeFileSync(
      join(sdkShimDir, "package.json"),
      JSON.stringify({ name: "@excalibase/sdk", types: "index.d.ts" }),
      "utf-8",
    );

    const apiCode = await generateApiFile(fixture);
    writeFileSync(join(tmpDir, "api.ts"), apiCode, "utf-8");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function compileFiles(extraFile: { name: string; content: string }): readonly ts.Diagnostic[] {
    writeFileSync(join(tmpDir, extraFile.name), extraFile.content, "utf-8");
    const program = ts.createProgram(
      [join(tmpDir, "api.ts"), join(tmpDir, extraFile.name)],
      {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        skipLibCheck: true,
        types: [],
        baseUrl: tmpDir,
      },
    );
    return [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ];
  }

  test("api.ts compiles standalone", () => {
    const program = ts.createProgram([join(tmpDir, "api.ts")], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
      types: [],
      baseUrl: tmpDir,
    });
    const diagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    if (diagnostics.length > 0) {
      const msg = diagnostics
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("\n");
      throw new Error(`api.ts had ${diagnostics.length} compile errors:\n${msg}`);
    }
    expect(diagnostics.length).toBe(0);
  });

  test("typed caller with correct args type compiles clean", () => {
    const caller = `
      import { api, internal } from "./api";
      import type { FunctionRef } from "@excalibase/sdk";

      // Fake ctx surface — what the function runtime gives a function body.
      interface Ctx {
        runQuery<TArgs, TResult>(ref: FunctionRef<TArgs, TResult>, args: TArgs): Promise<TResult>;
        runMutation<TArgs, TResult>(ref: FunctionRef<TArgs, TResult>, args: TArgs): Promise<TResult>;
      }

      export async function example(ctx: Ctx) {
        const a = await ctx.runQuery(api.users.list, { status: "active", limit: 10 });
        const b = await ctx.runMutation(api.users.create, { email: "a@b.c", name: "A" });
        const c = await ctx.runQuery(api.posts.feed, { userId: "u1" });
        const d = await ctx.runMutation(internal.admin.cleanup, { olderThanDays: 7 });
        return [a, b, c, d];
      }
    `;
    const diags = compileFiles({ name: "caller-ok.ts", content: caller });
    if (diags.length > 0) {
      const msg = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
      throw new Error(`typed caller had ${diags.length} compile errors:\n${msg}`);
    }
    expect(diags.length).toBe(0);
  });

  test("caller with wrong arg type is rejected by tsc --strict", () => {
    const caller = `
      import { api } from "./api";
      import type { FunctionRef } from "@excalibase/sdk";
      interface Ctx {
        runQuery<TArgs, TResult>(ref: FunctionRef<TArgs, TResult>, args: TArgs): Promise<TResult>;
      }
      export async function bad(ctx: Ctx) {
        // status is required and must be a string — passing a number should fail.
        return ctx.runQuery(api.users.list, { status: 123 });
      }
    `;
    const diags = compileFiles({ name: "caller-bad.ts", content: caller });
    expect(diags.length).toBeGreaterThan(0);
    const messages = diags
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("\n");
    expect(messages.toLowerCase()).toMatch(/status|number|string|not assignable/);
  });
});

// ---------------- CLI integration ----------------

describe("functions codegen CLI emits both files", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "excalibase-codegen-cli-api-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockMetadataFetch(): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  }

  test("fetchFunctionsMetadata returns the array (smoke test path coverage)", async () => {
    const data = await fetchFunctionsMetadata(
      { url: "http://x", key: "k", project: "acme/prod", schemas: [], out: "x.ts" },
      mockMetadataFetch(),
    );
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(3);
  });

  test("runFunctionsCodegen writes functions.types.ts and api.ts", async () => {
    const outPath = join(tmpDir, "gen", "functions.types.ts");
    const apiPath = join(tmpDir, "gen", "api.ts");
    const cwdBefore = process.cwd();
    process.chdir(tmpDir);
    try {
      await runFunctionsCodegen(
        {
          url: "http://x",
          key: "k",
          project: "acme/prod",
          schemas: [],
          out: outPath,
          apiOut: apiPath,
        },
        mockMetadataFetch(),
      );
    } finally {
      process.chdir(cwdBefore);
    }
    const types = readFileSync(outPath, "utf-8");
    const api = readFileSync(apiPath, "utf-8");
    expect(types).toContain("export interface Functions");
    expect(api).toContain("export const api");
    expect(api).toContain("export const internal");
  });

  test("runFunctionsCodegen defaults --api-out to <dir>/api.ts when omitted", async () => {
    const outPath = join(tmpDir, "gen2", "functions.types.ts");
    const expectedApiPath = join(tmpDir, "gen2", "api.ts");
    const cwdBefore = process.cwd();
    process.chdir(tmpDir);
    try {
      await runFunctionsCodegen(
        {
          url: "http://x",
          key: "k",
          project: "acme/prod",
          schemas: [],
          out: outPath,
        },
        mockMetadataFetch(),
      );
    } finally {
      process.chdir(cwdBefore);
    }
    const api = readFileSync(expectedApiPath, "utf-8");
    expect(api).toContain("export const api");
  });
});
