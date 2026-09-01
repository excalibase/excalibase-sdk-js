#!/usr/bin/env node
/**
 * sign-tokens.mjs
 *
 * Signs four demo JWTs (anon / alice / carol / admin) with the same EC P-256
 * private key the study-cases stack uses for excalibase-auth (so the JWKS
 * verification on excalibase-graphql accepts them). Writes the result to
 * src/demo-tokens.json which the React app imports at build time.
 *
 * Run once after bringing the docker stack up:
 *   npm run sign-tokens
 *
 * Re-running is safe — the file is overwritten.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, importPKCS8 } from "jose";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, "..", "src", "demo-tokens.json");

// The signing key must match the JWKS the running excalibase-graphql trusts.
// For the canonical study-cases stack that's
// `excalibase-graphql/e2e/study-cases/private.pem`. Resolve it via the
// EXCALIBASE_DEMO_KEY env var (any path), falling back to the sibling-repo
// default that works when the two repos sit next to each other under e.g.
// `~/Documents/duk/`.
const DEFAULT_KEY = join(
  HERE, "..", "..", "..", "..",
  "excalibase-graphql", "e2e", "study-cases", "private.pem"
);
const PRIVATE_PEM = process.env.EXCALIBASE_DEMO_KEY ?? DEFAULT_KEY;

// EC private keys come in two PEM forms. jose's importPKCS8 wants the
// "BEGIN PRIVATE KEY" PKCS8 wrapper. The study-cases keys use the older
// "BEGIN EC PRIVATE KEY" SEC1 form, so convert via openssl-equivalent
// strings using node's crypto (pure-JS path through node:crypto).
import { createPrivateKey } from "node:crypto";

async function loadKey() {
  let pem;
  try {
    pem = await readFile(PRIVATE_PEM, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read demo signing key at ${PRIVATE_PEM}.\n` +
      `Set EXCALIBASE_DEMO_KEY=/path/to/private.pem, or check out\n` +
      `excalibase-graphql as a sibling of excalibase-sdk-js.\n` +
      `Underlying error: ${err.message}`
    );
  }
  const cryptoKey = createPrivateKey(pem);
  // Export to PKCS8 PEM and re-import via jose so the rest of the API works.
  const pkcs8Pem = cryptoKey.export({ type: "pkcs8", format: "pem" });
  return importPKCS8(pkcs8Pem.toString(), "ES256");
}

// projectId must match the VaultCredentialService SLUG_PATTERN
// (^[a-zA-Z0-9_-]{1,64}$ — no slashes). The wiremock mapping at
// `/api/vault/secrets/projects/kanban/credentials/excalibase_app` resolves
// this to the seeded kanban Postgres credentials.
const PROJECT_ID = "kanban";
const ORG_SLUG = "study-cases";
const PROJECT_NAME = "kanban";
const HOUR = 60 * 60;

/**
 * Identity → claim shape mapping. Mirrors what excalibase-auth would produce
 * for the corresponding grant types — minus signing them through the auth
 * service so the demo doesn't depend on a database registration ceremony.
 */
const IDENTITIES = {
  anon: {
    sub: "anon",
    scope: "public",
    role: "user",
    userId: 0,
    projectId: PROJECT_ID,
    orgSlug: ORG_SLUG,
    projectName: PROJECT_NAME,
  },
  alice: {
    sub: "alice@acme.com",
    scope: "authenticated",
    role: "user",
    userId: 1,
    projectId: PROJECT_ID,
    orgSlug: ORG_SLUG,
    projectName: PROJECT_NAME,
  },
  carol: {
    sub: "carol@acme.com",
    scope: "authenticated",
    role: "user",
    userId: 3,
    projectId: PROJECT_ID,
    orgSlug: ORG_SLUG,
    projectName: PROJECT_NAME,
  },
  admin: {
    sub: "alice@acme.com",
    scope: "authenticated",
    role: "app_admin", // — must match `app.security.postgres.role-switching.allowed-roles`
    userId: 1,
    projectId: PROJECT_ID,
    orgSlug: ORG_SLUG,
    projectName: PROJECT_NAME,
  },
};

async function main() {
  const key = await loadKey();
  const out = {};
  for (const [name, claims] of Object.entries(IDENTITIES)) {
    const jwt = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("excalibase")
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${24 * HOUR}s`)
      .sign(key);
    out[name] = jwt;
  }
  await writeFile(OUTPUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`✓ wrote ${OUTPUT}`);
  for (const name of Object.keys(out)) {
    console.log(`  · ${name}: ${out[name].slice(0, 28)}…`);
  }
}

main().catch(err => {
  console.error("sign-tokens failed:", err);
  process.exit(1);
});
