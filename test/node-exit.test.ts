import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A script that signs in and queries must let Node exit on its own: the
// token-refresh timer may not keep the event loop alive.
describe("a Node script using the SDK", () => {
  let server: Server;
  let baseUrl: string;
  let outDir: string;

  beforeAll(async () => {
    outDir = mkdtempSync(join(__dirname, "..", "node_modules", ".sdk-exit-"));
    execFileSync(
      "npx",
      ["tsup", "src/index.ts", "--format", "cjs", "--out-dir", outDir, "--no-dts", "--no-sourcemap", "--platform", "node"],
      { cwd: join(__dirname, ".."), stdio: "pipe" },
    );
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/token")) {
        res.end(JSON.stringify({ accessToken: "at", refreshToken: "rt", tokenType: "Bearer", expiresIn: 3600, user: null }));
      } else {
        res.end(JSON.stringify({ data: { __typename: "Query" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exits by itself after signing in and querying", async () => {
    const script = join(outDir, "snippet.cjs");
    writeFileSync(
      script,
      `const { createClient } = require("./index.js");
(async () => {
  const db = createClient({ url: ${JSON.stringify(baseUrl)}, projectId: "proj-test", key: "esk_pub_live_test" });
  await db.auth.signInWithApiKey();
  console.log(JSON.stringify(await db.graphql.query("{ __typename }")));
})();`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const exit = await new Promise<{ code: number | null; hung: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, hung: true });
      }, 8000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, hung: false });
      });
    });
    expect(stdout).toContain("Query");
    expect(exit).toEqual({ code: 0, hung: false });
  }, 60000);
});
