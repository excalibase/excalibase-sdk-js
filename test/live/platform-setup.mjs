#!/usr/bin/env node
// Prepares a project on a running platform for test/live.test.ts, through the
// control plane's API only: a Postgres project, a `notes` table the `user` role
// may read and insert into, realtime on it, a publishable key, an end user, and
// two functions that mint and complete a staged upload. Prints the SDK_LIVE_*
// variables the live test reads, as a JSON object.
//
//   PROVISIONING_URL=http://localhost:24005 ADMIN_PASSWORD_FILE=... \
//   SDK_LIVE_URL=http://localhost:18080 node test/live/platform-setup.mjs > live.json
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stderr.write(`${message}\n`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/$/, "");
}

const API = required("PROVISIONING_URL");
const EDGE = required("SDK_LIVE_URL");
const PASSWORD = readFileSync(required("ADMIN_PASSWORD_FILE"), "utf8").trim();

async function call(method, url, { token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep the text
  }
  if (!response.ok) throw new Error(`${method} ${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return data;
}

const MINT = `export default {
  kind: "mutation",
  args: { parse: (a: any) => a },
  handler: async (ctx: any, args: any) => ctx.storage.generateUploadUrl({ contentType: args.contentType, size: args.size }),
  __metadata: { argsJsonSchema: { type: "object" } },
};`;

const COMPLETE = `export default {
  kind: "mutation",
  args: { parse: (a: any) => a },
  handler: async (ctx: any, args: any) => ctx.storage.completeUpload({ storageId: args.storageId, uploadId: args.uploadId }),
  __metadata: { argsJsonSchema: { type: "object" } },
};`;

async function waitActive(token, projectId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const project = await call("GET", `${API}/api/provision/${projectId}/`, { token });
    if (project.status === "ACTIVE") return;
    if (project.status === "FAILED") throw new Error(`project FAILED: ${project.failureReason ?? ""}`);
    await sleep(5000);
  }
  throw new Error(`project ${projectId} did not become ACTIVE`);
}

async function main() {
  const { token } = await call("POST", `${API}/api/auth/login`, { body: { username: "admin", password: PASSWORD } });
  const [org] = await call("GET", `${API}/api/orgs`, { token });
  const suffix = randomBytes(3).toString("hex");
  const created = await call("POST", `${API}/api/provision/`, {
    token,
    body: { projectName: `sdk-live-${suffix}`, orgId: org.id, databaseType: "POSTGRESQL", tier: "FREE", postgresVersion: "17" },
  });
  const projectId = created.projectId;
  log(`project ${projectId} (org ${org.slug}) provisioning`);
  await waitActive(token, projectId);

  await call("POST", `${API}/api/schema/${projectId}/ddl`, {
    token,
    body: { sql: "CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());" },
  });
  const permissions = `${API}/api/provision/${projectId}/permissions/tables/public.notes/roles/user`;
  await call("PUT", `${permissions}/select`, { token, body: { filter: {}, columns: "*" } });
  await call("PUT", `${permissions}/insert`, { token, body: { check: {}, columns: ["body"] } });
  await call("PUT", `${API}/api/projects/${projectId}/realtime/tables/public/notes`, { token, body: {} });
  const key = await call("POST", `${API}/api/projects/${projectId}/sdk-keys/`, {
    token,
    body: { name: "sdk-live", keyType: "publishable" },
  });
  for (const [id, content] of [["uploads.mint", MINT], ["uploads.complete", COMPLETE]]) {
    await call("POST", `${API}/api/projects/${projectId}/functions/`, {
      token,
      body: { id, name: id, files: [{ path: "index.ts", content }] },
    });
  }
  log("table, permissions, realtime, key and upload functions ready");

  const email = `sdk-live-${suffix}@example.test`;
  const password = `Live-${randomBytes(9).toString("base64url")}7a`;
  await call("POST", `${EDGE}/auth/${org.slug}/${projectId}/register`, {
    body: { email, password, fullName: "SDK Live" },
  });
  log(`end user ${email} registered through the edge`);

  process.stdout.write(
    JSON.stringify({
      SDK_LIVE_URL: EDGE,
      SDK_LIVE_PROJECT_ID: projectId,
      SDK_LIVE_ORG_SLUG: org.slug,
      SDK_LIVE_KEY: key.plaintext,
      SDK_LIVE_EMAIL: email,
      SDK_LIVE_PASSWORD: password,
    }),
  );
}

main().catch((err) => {
  log(`setup failed: ${err.message}`);
  process.exit(1);
});
