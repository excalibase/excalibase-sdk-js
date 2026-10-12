import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const BUNDLED_FOR_CLI = "json-schema-to-typescript";

// Library users install only what the client needs; the codegen CLI ships
// its own copy of the schema compiler.
describe("runtime dependencies", () => {
  it("does not install the schema compiler for every SDK user", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies)).not.toContain(BUNDLED_FOR_CLI);
    expect(Object.keys(pkg.devDependencies)).toContain(BUNDLED_FOR_CLI);
  });

  it("builds the codegen CLI with the schema compiler inside it", () => {
    const outDir = mkdtempSync(join(root, "node_modules", ".cli-deps-"));
    try {
      execFileSync("npx", ["tsup", "--config", "tsup.config.ts", "--out-dir", outDir, "--no-dts"], { cwd: root, stdio: "pipe" });
      const cli = readFileSync(join(outDir, "bin", "codegen.js"), "utf8");
      expect(cli).not.toMatch(/require\(["']json-schema-to-typescript["']\)/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);

  it("still generates function types with the built CLI", async () => {
    const outDir = mkdtempSync(join(root, "node_modules", ".cli-run-"));
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "f1", name: "todos", runtimeShape: "v2", lastDeployedAt: "2026-10-12T00:00:00Z", exports: [{ name: "add", kind: "mutation", argsJsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }] }]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      execFileSync("npx", ["tsup", "--config", "tsup.config.ts", "--out-dir", outDir, "--no-dts"], { cwd: root, stdio: "pipe" });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const out = join(outDir, "gen", "functions.types.ts");
      await new Promise<void>((resolve, reject) => {
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, [join(outDir, "bin", "codegen.js"), "functions", "--url", url, "--project", "p1", "--key", "k", "--out", out], { stdio: "pipe" });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
        child.on("exit", (code: number) => (code === 0 ? resolve() : reject(new Error(`codegen exited ${code}: ${stderr}`))));
      });
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, "utf8")).toContain("title: string");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);
});
