/**
 * `excalibase-codegen` — fetches the GraphQL introspection from a running
 * excalibase server and writes a typed `database.types.ts` file that can be
 * passed as the `Database` generic to `createClient<Database>`.
 *
 * Usage:
 *   excalibase-codegen --url https://api.example.com --project acme/prod \
 *     --key esk_pub_live_xxx --schemas kanban,ecommerce --out src/database.types.ts
 *
 * Args:
 *   --url       Server base URL (no trailing /graphql)
 *   --project   "{orgSlug}/{projectName}"  (optional; only used for headers)
 *   --key       Publishable key (esk_pub_*)
 *   --schemas   Comma-separated multi-schema prefixes (e.g. "kanban,ecommerce")
 *   --out       Output file path (default: ./src/database.types.ts)
 *
 * Exit codes: 0 success, 1 user error, 2 server error.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateDatabaseFile } from "../codegen";
import { generateFunctionsFile, type FunctionsMetadataResponse } from "../codegen/functions";

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        fields {
          name
          type { ...TypeRef }
          args { name type { ...TypeRef } }
        }
        enumValues { name }
      }
    }
  }
  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType { kind name ofType { kind name ofType { kind name } } }
        }
      }
    }
  }
`;

interface CliArgs {
  url: string;
  /** Either a publishable key OR a JWT — exactly one must be set. */
  key?: string;
  token?: string;
  schemas: string[];
  out: string;
  project?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i++;
    }
  }
  if (args.help != null || args.h != null) {
    printHelpAndExit(0);
  }
  if (!args.url) die("missing --url");
  if (!args.key && !args.token) die("missing --key or --token");

  return {
    url: args.url!.replace(/\/$/, ""),
    key: args.key,
    token: args.token,
    schemas: args.schemas != null && args.schemas.length > 0 ? args.schemas.split(",").map((s) => s.trim()).filter(Boolean) : [],
    out: args.out ?? "./src/database.types.ts",
    project: args.project,
  };
}

function die(msg: string): never {
  process.stderr.write(`excalibase-codegen: ${msg}\n`);
  process.stderr.write("Run with --help for usage.\n");
  process.exit(1);
}

function printHelpAndExit(code: number): never {
  process.stdout.write(
    [
      "Usage: excalibase-codegen --url <server> --key <publishable-key> [options]",
      "",
      "Required:",
      "  --url <url>          Server base URL (without /graphql)",
      "  --key <key>          Publishable key (esk_pub_*)",
      "",
      "Optional:",
      "  --project <slug>     orgSlug/projectName (sets the X-Excalibase-Project header)",
      "  --schemas <csv>      Multi-schema prefixes, comma-separated (e.g. kanban,ecommerce)",
      "  --out <path>         Output file (default: ./src/database.types.ts)",
      "",
      "Example:",
      "  excalibase-codegen --url http://localhost:10004 \\",
      "    --key esk_pub_live_abc --schemas kanban --out src/database.types.ts",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

export async function fetchIntrospection(args: CliArgs, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const url = `${args.url}/graphql`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.key != null) headers["X-Excalibase-Publishable-Key"] = args.key;
  if (args.token != null) headers["Authorization"] = `Bearer ${args.token}`;
  if (args.project != null) headers["X-Excalibase-Project"] = args.project;

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!res.ok) {
    throw new Error(`introspection failed: HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (json.errors != null) {
    throw new Error(`introspection returned errors: ${JSON.stringify(json.errors)}`);
  }
  if (json.data == null) {
    throw new Error("introspection returned no data field");
  }
  return json.data;
}

export async function runCodegen(args: CliArgs, fetchImpl: typeof fetch = fetch): Promise<void> {
  const introspection = await fetchIntrospection(args, fetchImpl);
  const code = generateDatabaseFile(introspection, { schemas: args.schemas });
  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, code, "utf-8");
  process.stdout.write(`✓ wrote ${args.out} (${code.split("\n").length} lines)\n`);
}

// --- functions subcommand ---

/**
 * Fetch the per-project function metadata from
 * `GET /api/projects/{projectId}/functions/_metadata` and return the parsed
 * JSON array. JWT-gated route — caller must pass either `--token` (bearer)
 * or `--key` (publishable). `--project` is required since the URL is
 * project-scoped.
 */
export async function fetchFunctionsMetadata(
  args: CliArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<FunctionsMetadataResponse> {
  if (args.project == null || args.project.length === 0) {
    throw new Error("--project is required for the functions subcommand");
  }
  const url = `${args.url}/api/projects/${args.project}/functions/_metadata`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.token != null) headers["Authorization"] = `Bearer ${args.token}`;
  if (args.key != null) headers["X-Excalibase-Publishable-Key"] = args.key;

  const res = await fetchImpl(url, { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`functions metadata fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new Error("functions metadata response was not a JSON array");
  }
  return json as FunctionsMetadataResponse;
}

export async function runFunctionsCodegen(
  args: CliArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const metadata = await fetchFunctionsMetadata(args, fetchImpl);
  const code = await generateFunctionsFile(metadata);
  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, code, "utf-8");
  process.stdout.write(`wrote ${args.out} (${code.split("\n").length} lines)\n`);
}

// CLI entrypoint — only runs when invoked as a script, not on import.
if (require.main === module) {
  const argv = process.argv.slice(2);
  // First positional non-flag is the subcommand (default: database types).
  const subcommand = argv.length > 0 && !argv[0]!.startsWith("--") ? argv[0]! : null;
  const flags = subcommand != null ? argv.slice(1) : argv;
  const args = parseArgs(flags);
  if (subcommand === "functions") {
    if (args.out === "./src/database.types.ts") args.out = "./src/functions.types.ts";
    runFunctionsCodegen(args).catch((err: Error) => {
      process.stderr.write(`functions codegen failed: ${err.message}\n`);
      process.exit(2);
    });
  } else {
    runCodegen(args).catch((err: Error) => {
      process.stderr.write(`codegen failed: ${err.message}\n`);
      process.exit(2);
    });
  }
}
