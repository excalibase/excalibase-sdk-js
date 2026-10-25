/**
 * The SDK against a real excalibase-auth, not a mocked reply: the mock in auth.test.ts left `user` out of
 * the api-key answer while the server sent a placeholder `{ id: 0 }`, so `user()` was wrong in every app
 * and no test saw it (EXC-607).
 *
 * Runs only with SDK_REAL_AUTH_IMAGE (an excalibase-auth image, e.g. docker.io/excalibase/excalibase-auth:main):
 * Postgres and auth start in Docker on the host network, with this file standing in for provisioning
 * (the project's database login and the token-signing key), as auth's own e2e suite does.
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createClient, memoryStorageAdapter } from "../src";

const IMAGE = process.env.SDK_REAL_AUTH_IMAGE ?? "";
const describeReal = IMAGE.length > 0 ? describe : describe.skip;

const ORG = "real-org";
const PROJECT = "proj-real-auth";
const DB = { user: "auth_admin", password: randomBytes(12).toString("hex"), database: "auth_test" };
const run = randomBytes(4).toString("hex");
const PG_NAME = `sdk-real-auth-pg-${run}`;
const AUTH_NAME = `sdk-real-auth-${run}`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, what: string, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not come up`);
}

/** What auth asked provisioning to mail, newest last. */
const sentMail: Array<{ to: string; template: string; data: Record<string, string> }> = [];

/** Stands in for provisioning: the token-signing key, project info, the mail relay and the project's database login. */
function fakeProvisioning(pgPort: number): Server {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "sec1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const path = request.url ?? "";
    if (path === "/vault/secrets/pki/signing/private") {
      response.end(JSON.stringify({ key: privateKey, algorithm: "EC-P256" }));
    } else if (path === `/projects/${PROJECT}/info`) {
      response.end(JSON.stringify({ projectId: PROJECT, orgSlug: ORG, corsAllowedOrigins: [], siteUrl: "https://app.example.com" }));
    } else if (path === "/internal/email/send") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        sentMail.push(JSON.parse(body));
        response.end("{}");
      });
    } else {
      response.end(JSON.stringify({
        host: "127.0.0.1", port: String(pgPort), database: DB.database, username: DB.user, password: DB.password,
      }));
    }
  });
}

/** An operator's key, inserted as provisioning does: only its SHA-256 is stored. */
let pgPort = 0;

function seedKey(kind: "pub" | "sec"): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const random = Array.from(randomBytes(24), (byte) => alphabet[byte % alphabet.length]).join("");
  const plaintext = `esk_${kind}_live_${random}`;
  const hash = createHash("sha256").update(plaintext).digest("hex");
  const keyType = kind === "pub" ? "publishable" : "secret";
  docker("exec", PG_NAME, "psql", "-h", "127.0.0.1", "-p", String(pgPort), "-U", DB.user, "-d", DB.database, "-v", "ON_ERROR_STOP=1", "-qc",
    `INSERT INTO auth.api_keys (key_hash, key_prefix, key_type, name) VALUES ('${hash}', '${random.slice(0, 12)}', '${keyType}', 'sdk-real-auth')`);
  return plaintext;
}

describeReal("SDK against a real excalibase-auth", () => {
  let provisioning: Server;
  let authURL = "";

  beforeAll(async () => {
    pgPort = await freePort();
    const [authPort, provisioningPort] = [await freePort(), await freePort()];
    provisioning = fakeProvisioning(pgPort);
    await new Promise<void>((resolve) => provisioning.listen(provisioningPort, "127.0.0.1", resolve));
    docker("run", "-d", "--rm", "--label", "sdk-real-auth", "--name", PG_NAME, "--network", "host",
      "-e", `POSTGRES_USER=${DB.user}`, "-e", `POSTGRES_PASSWORD=${DB.password}`, "-e", `POSTGRES_DB=${DB.database}`,
      "docker.io/library/postgres:16-alpine", "-c", `port=${pgPort}`, "-c", "listen_addresses=127.0.0.1");
    await waitFor(async () => {
      docker("exec", PG_NAME, "pg_isready", "-h", "127.0.0.1", "-p", String(pgPort), "-U", DB.user);
      return true;
    }, "postgres");
    docker("run", "-d", "--rm", "--label", "sdk-real-auth", "--name", AUTH_NAME, "--network", "host",
      "-e", `PORT=${authPort}`, "-e", `PROVISIONING_URL=http://127.0.0.1:${provisioningPort}`,
      "-e", "PROVISIONING_PAT=sdk-real-auth", "-e", "TENANT_DB_SSLMODE=disable", IMAGE);
    authURL = `http://127.0.0.1:${authPort}`;
    await waitFor(async () => (await fetch(`${authURL}/healthz`)).ok, "excalibase-auth");
    // The first request for the project creates its auth schema.
    await waitFor(async () => {
      const answer = await fetch(`${authURL}/auth/${ORG}/${PROJECT}/token`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "api_key", api_key: "esk_pub_live_none" }),
      });
      return answer.status === 401;
    }, "the project's auth schema");
  }, 180_000);

  afterAll(async () => {
    for (const name of [AUTH_NAME, PG_NAME]) {
      try {
        docker("rm", "-f", name);
      } catch {
        // Already gone: --rm removed it when it stopped.
      }
    }
    await new Promise<void>((resolve) => (provisioning ? provisioning.close(() => resolve()) : resolve()));
  });

  function client(key: string) {
    return createClient({ url: authURL, projectId: PROJECT, orgSlug: ORG, key, storage: memoryStorageAdapter(), autoRefreshToken: false });
  }

  it.each(["pub", "sec"] as const)("an api-key sign-in (%s) has no user", async (kind) => {
    const db = client(seedKey(kind));
    const session = await db.auth.signInWithApiKey();
    expect(session.accessToken).toEqual(expect.any(String));
    expect(session.user).toBeNull();
    expect(db.auth.user()).toBeNull();
  });

  it("the server's own answer to an api-key sign-in carries no user", async () => {
    const answer = await fetch(`${authURL}/auth/${ORG}/${PROJECT}/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "api_key", api_key: seedKey("pub") }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).not.toHaveProperty("user");
  });

  it("a signed-up user is the user", async () => {
    const db = client(seedKey("pub"));
    const email = `sdk-${run}@example.com`;
    await db.auth.signUp({ email, password: randomBytes(12).toString("hex"), fullName: "Real Auth" });
    expect(db.auth.user()).toEqual(expect.objectContaining({ email, id: expect.any(Number) }));
    expect(db.auth.user()?.id).toBeGreaterThan(0);
  });

  it("password reset: same answer for a stranger, and the mailed token sets a new password", async () => {
    const db = client(seedKey("pub"));
    const email = `sdk-reset-${run}@example.com`;
    await db.auth.signUp({ email, password: randomBytes(12).toString("hex"), fullName: "Reset" });

    await expect(db.auth.resetPasswordForEmail(`nobody-${run}@example.com`)).resolves.toBeUndefined();
    await expect(db.auth.resetPasswordForEmail(email)).resolves.toBeUndefined();
    const mail = sentMail.filter((m) => m.to === email && m.template === "password_reset").pop();
    const token = new URL(mail?.data.resetUrl ?? "https://x/").searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(0);

    const fresh = `N3w-${randomBytes(8).toString("hex")}`;
    await db.auth.updatePasswordWithToken({ token, password: fresh });
    await expect(db.auth.updatePasswordWithToken({ token, password: fresh })).rejects.toMatchObject({ status: 400 });
    const session = await db.auth.signInWithPassword({ email, password: fresh });
    expect(session.user?.email).toBe(email);
  });

  it("email verification: resend answers alike, and a bad token is refused", async () => {
    const db = client(seedKey("pub"));
    await expect(db.auth.resendVerification({ email: `nobody-${run}@example.com` })).resolves.toBeUndefined();
    await expect(db.auth.verifyEmail({ token: "not-a-real-token" })).rejects.toMatchObject({ status: 400 });
  });
});
