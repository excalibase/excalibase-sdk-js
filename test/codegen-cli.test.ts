import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchIntrospection, runCodegen } from "../src/bin/codegen";

const introspectionFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "kanban-introspection.json"), "utf-8"),
);

function mockFetchOk(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: introspectionFixture }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("fetchIntrospection", () => {
  it("POSTs the IntrospectionQuery and returns the data field", async () => {
    let captured: { url: string; method?: string; headers?: Record<string, string>; body?: string } | null = null;
    const mockFetch: typeof fetch = (async (url: string, init: RequestInit | undefined) => {
      captured = {
        url,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      };
      return new Response(JSON.stringify({ data: introspectionFixture }), { status: 200 });
    }) as typeof fetch;

    const data = await fetchIntrospection(
      { url: "http://localhost:10004", key: "esk_pub_test", token: undefined, schemas: ["kanban"], out: "ignored.ts" },
      mockFetch,
    );
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://localhost:10004/graphql");
    expect(captured!.method).toBe("POST");
    expect(captured!.headers!["X-Excalibase-Publishable-Key"]).toBe("esk_pub_test");
    expect(captured!.body).toContain("IntrospectionQuery");
    expect((data as { __schema: unknown }).__schema).toBeDefined();
  });

  it("throws on non-2xx response", async () => {
    const failing: typeof fetch = (async () =>
      new Response("bad", { status: 500, statusText: "Server Error" })) as typeof fetch;
    await expect(
      fetchIntrospection(
        { url: "http://x", key: "esk_pub_test", schemas: [], out: "x.ts" },
        failing,
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when GraphQL returns errors", async () => {
    const erroring: typeof fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 })) as typeof fetch;
    await expect(
      fetchIntrospection(
        { url: "http://x", key: "esk_pub_test", schemas: [], out: "x.ts" },
        erroring,
      ),
    ).rejects.toThrow(/errors/);
  });
});

describe("runCodegen", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "excalibase-codegen-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a generated file at the given path", async () => {
    const outPath = join(tmpDir, "generated", "database.types.ts");
    const cwdBefore = process.cwd();
    process.chdir(tmpDir);
    try {
      await runCodegen(
        { url: "http://x", key: "esk_pub_test", schemas: ["kanban"], out: outPath },
        mockFetchOk(),
      );
    } finally {
      process.chdir(cwdBefore);
    }
    const written = readFileSync(outPath, "utf-8");
    expect(written).toContain("export interface Database");
    expect(written).toContain("KanbanIssueRow");
    expect(written).toContain('rest: { table: "issues", profile: "kanban" }');
  });
});
