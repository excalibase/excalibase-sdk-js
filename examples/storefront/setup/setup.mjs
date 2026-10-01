#!/usr/bin/env node
// Sets up a project for the storefront, entirely through the platform's APIs:
// tables and sample data, permissions per role, the tracked function,
// realtime on orders, a publishable key, CORS for the app's origin, three demo
// accounts (two customers and one staff member with the custom role "staff"),
// and the app's variables, after which the app is redeployed.
//
//   EXCALIBASE_API=https://admin.example.com/api \
//   EXCALIBASE_TOKEN=<personal access token> \
//   EXCALIBASE_DATA_URL=https://api.example.com \
//   PROJECT_ID=proj-... node setup/setup.mjs
//
// Optional: STOREFRONT_APP (default storefront; "none" skips the app steps),
// EXCALIBASE_AUTH_URL (where this script reaches end-user auth, default the
// data URL), EXTRA_ORIGINS (comma separated, e.g. http://localhost:5176),
// DEMO_PASSWORD (else one is generated), DEMO_EMAIL_DOMAIN (default
// example.test), SETUP_OUT (write the result as JSON to this file).
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { literalValue, mergeAppEnv, originOf, withOrigins } from './app-env.mjs';
import { PERMISSIONS, REALTIME_TABLES, TRACKED_FUNCTIONS } from './permissions.mjs';
import { controlPlane, endUserAuth } from './platform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stderr.write(`${message}\n`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see the comment at the top of setup/setup.mjs)`);
  return value;
}

function readConfig() {
  const dataUrl = required('EXCALIBASE_DATA_URL').replace(/\/$/, '');
  const domain = process.env.DEMO_EMAIL_DOMAIN || 'example.test';
  return {
    apiUrl: required('EXCALIBASE_API'),
    token: required('EXCALIBASE_TOKEN'),
    dataUrl,
    authUrl: (process.env.EXCALIBASE_AUTH_URL || dataUrl).replace(/\/$/, ''),
    projectId: required('PROJECT_ID'),
    appName: process.env.STOREFRONT_APP || 'storefront',
    extraOrigins: (process.env.EXTRA_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
    password: process.env.DEMO_PASSWORD || `Shop-${randomBytes(9).toString('base64url')}7a`,
    accounts: [
      { key: 'alice', email: `alice@${domain}`, fullName: 'Alice Chen', role: null },
      { key: 'bob', email: `bob@${domain}`, fullName: 'Bob Okafor', role: null },
      { key: 'sam', email: `sam@${domain}`, fullName: 'Sam Rivera', role: 'staff' },
    ],
    outFile: process.env.SETUP_OUT || null,
  };
}

async function applySchema(api, projectId) {
  const probe = await api.post(`/schema/${projectId}/query`, { query: "SELECT to_regclass('public.products') IS NOT NULL" });
  if (probe?.rows?.[0]?.[0] === true) {
    log('schema: already applied');
    return;
  }
  const sql = await readFile(path.join(HERE, 'schema.sql'), 'utf8');
  const answer = await api.post(`/schema/${projectId}/ddl`, { sql });
  if (answer?.success !== true) throw new Error(`schema: ${JSON.stringify(answer)}`);
  log('schema: tables, triggers, best_sellers() and sample products created');
}

async function applyPermissions(api, projectId) {
  for (const { table, role, operation, rule } of PERMISSIONS) {
    await api.put(`/provision/${projectId}/permissions/tables/${table}/roles/${role}/${operation}`, rule);
  }
  log(`permissions: ${PERMISSIONS.length} written (anon, user, staff)`);
  for (const tracked of TRACKED_FUNCTIONS) {
    try {
      await api.post(`/provision/${projectId}/tracked-functions/`, tracked);
      log(`function: ${tracked.function} tracked`);
    } catch (err) {
      if (err.status !== 409) throw err;
      log(`function: ${tracked.function} already tracked`);
    }
  }
  for (const { schema, table } of REALTIME_TABLES) {
    await api.put(`/projects/${projectId}/realtime/tables/${schema}/${table}`);
    log(`realtime: ${schema}.${table} on`);
  }
}

async function ensureAccounts(api, auth, projectId, config) {
  for (const account of config.accounts) {
    try {
      await auth.register({ email: account.email, password: config.password, fullName: account.fullName });
      log(`account: ${account.email} registered`);
    } catch (err) {
      if (err.status !== 409) throw err;
      log(`account: ${account.email} already exists`);
    }
  }
  const { users = [] } = await api.get(`/projects/${projectId}/end-users/`);
  for (const account of config.accounts.filter((a) => a.role)) {
    const user = users.find((u) => u.email === account.email);
    if (!user) throw new Error(`account ${account.email} is not listed for the project`);
    await api.put(`/projects/${projectId}/end-users/${user.id}/role`, { role: account.role, allowedRoles: [account.role, 'user'] });
    log(`account: ${account.email} has the role ${account.role}`);
  }
}

async function findApp(api, projectId, name) {
  const apps = await api.get(`/projects/${projectId}/apps/`);
  const app = apps.find((candidate) => candidate.name === name);
  if (!app) throw new Error(`the project has no app named ${name}; deploy the "Storefront demo" template first`);
  return app;
}

async function publishableKey(api, projectId, app) {
  const existing = app ? literalValue(app.env, 'EXCALIBASE_PUBLISHABLE_KEY') : null;
  if (existing) return existing;
  const created = await api.post(`/projects/${projectId}/sdk-keys/`, { name: 'storefront', keyType: 'publishable' });
  log('key: publishable key created');
  return created.plaintext;
}

async function allowOrigins(api, projectId, origins) {
  if (origins.length === 0) return;
  const current = await api.get(`/projects/${projectId}/cors/`);
  const allowedOrigins = withOrigins(current?.allowedOrigins, origins);
  await api.put(`/projects/${projectId}/cors/`, { allowedOrigins, allowWildcard: false });
  log(`cors: ${allowedOrigins.join(', ')}`);
}

// An app is updated at the version it was read at (If-Match); a rollout still
// in flight answers 409 for a while, so the update is retried. Then the new
// deploy is followed until it has rolled out.
async function configureAndDeploy(api, projectId, appId, literals) {
  const path = `/projects/${projectId}/apps/${appId}/`;
  let app;
  let deploy;
  for (let attempt = 0; ; attempt += 1) {
    app = await api.get(path);
    try {
      await api.patch(path, { env: mergeAppEnv(app.env, literals) }, { 'If-Match': String(app.version) });
      deploy = await api.post(`${path}deploy`);
      break;
    } catch (err) {
      if (err.status !== 409 || attempt >= 60) throw err;
      await sleep(5000);
    }
  }
  log(`app: ${app.name} variables set, redeploying`);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const deploys = await api.get(`${path}deploys`);
    const current = (Array.isArray(deploys) ? deploys : deploys?.deploys ?? []).find((d) => d.id === deploy.id);
    if (current?.status === 'succeeded') return;
    if (current?.status === 'failed') throw new Error(`app ${app.name} failed to deploy: ${current.failureReason ?? ''}`);
    await sleep(5000);
  }
  throw new Error(`app ${app.name} did not finish deploying`);
}

async function main() {
  const config = readConfig();
  const api = controlPlane(config.apiUrl, config.token);
  const info = await api.get(`/projects/${config.projectId}/info/`);
  const auth = endUserAuth(config.authUrl, info.orgSlug, config.projectId);

  await applySchema(api, config.projectId);
  await applyPermissions(api, config.projectId);
  await ensureAccounts(api, auth, config.projectId, config);

  const app = config.appName === 'none' ? null : await findApp(api, config.projectId, config.appName);
  const key = await publishableKey(api, config.projectId, app);
  await allowOrigins(api, config.projectId, [...(app?.url ? [originOf(app.url)] : []), ...config.extraOrigins]);
  if (app) {
    await configureAndDeploy(api, config.projectId, app.id, {
      EXCALIBASE_URL: config.dataUrl,
      EXCALIBASE_PROJECT_ID: config.projectId,
      EXCALIBASE_ORG_SLUG: info.orgSlug,
      EXCALIBASE_PUBLISHABLE_KEY: key,
    });
  }

  const result = {
    projectId: config.projectId,
    orgSlug: info.orgSlug,
    dataUrl: config.dataUrl,
    appUrl: app?.url ?? null,
    publishableKey: key,
    accounts: config.accounts.map(({ key: name, email, role }) => ({ name, email, role: role ?? 'user' })),
    password: config.password,
  };
  if (config.outFile) await writeFile(config.outFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  log(app?.url ? `\nThe store is live at ${app.url}` : '\nDone.');
  log(`Demo accounts: ${result.accounts.map((a) => `${a.email} (${a.role})`).join(', ')}`);
  if (!process.env.DEMO_PASSWORD && !config.outFile) log(`Their password: ${config.password}`);
}

main().catch((err) => {
  log(`setup failed: ${err.message}`);
  process.exit(1);
});
