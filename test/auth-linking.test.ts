import { createHash } from "node:crypto";
import { createClient, memoryStorageAdapter } from "../src";
import type { StorageAdapter } from "../src/storage";

const baseOpts = {
  url: "http://localhost:10010",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  autoRefreshToken: false,
};

const sessionKey = "excalibase.auth.session:acme/prod";
const verifierKey = `${sessionKey}-code-verifier`;
const otpVerifierKey = `${sessionKey}-otp-verifier`;
const identitiesUrl = "http://localhost:10010/auth/acme/prod/user/identities";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function signedIn(storage: StorageAdapter): void {
  storage.setItem(
    sessionKey,
    JSON.stringify({
      accessToken: "jwt-signed-in",
      refreshToken: "rt",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
      user: { id: 7, email: "octo@github.test", fullName: "Octo" },
    }),
  );
}

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

function server(answer: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const call = {
      method: init.method ?? "GET",
      url: String(input),
      authorization: headers.get("Authorization"),
      body: init.body == null ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: f, calls };
}

async function client(fetchImpl: typeof fetch, storage = memoryStorageAdapter(), assign = jest.fn()) {
  signedIn(storage);
  const db = createClient({ ...baseOpts, storage, fetch: fetchImpl, location: { href: "https://app.test/", assign } });
  await db.auth.hydrate();
  return { db, storage, assign };
}

describe("AuthClient.linkIdentity", () => {
  it("asks for a ticket with the session and a kept verifier's challenge, then sends the browser to /authorize", async () => {
    const { fetch: f, calls } = server(() => ({ body: { linkTicket: "tkt", expiresIn: 120 } }));
    const { db, storage, assign } = await client(f);
    const { url, provider } = await db.auth.linkIdentity({ provider: "github", redirectTo: "https://app.test/cb" });
    expect(provider).toBe("github");
    expect(calls[0]).toMatchObject({ method: "POST", url: `${identitiesUrl}/authorize`, authorization: "Bearer jwt-signed-in" });
    const kept = JSON.parse(storage.getItem(verifierKey) as string);
    expect(kept.redirectTo).toBe("https://app.test/cb");
    expect(calls[0]!.body).toEqual({
      provider: "github",
      redirect_to: "https://app.test/cb",
      code_challenge: s256(kept.verifier),
      code_challenge_method: "S256",
    });
    expect(url).toBe("http://localhost:10010/auth/acme/prod/authorize?link_ticket=tkt");
    expect(assign).toHaveBeenCalledWith(url);
  });

  it("needs a signed-in session and never calls the server without one", async () => {
    const { fetch: f, calls } = server(() => ({ body: {} }));
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(db.auth.linkIdentity({ provider: "google", redirectTo: "https://app.test/cb" })).rejects.toMatchObject({
      code: "not_signed_in",
    });
    await expect(db.auth.getUserIdentities()).rejects.toMatchObject({ code: "not_signed_in" });
    expect(calls).toHaveLength(0);
  });

  it("names a refusal by its code and keeps no verifier", async () => {
    const { fetch: f } = server(() => ({ status: 403, body: { error: "reauthentication_required", status: 403 } }));
    const { db, storage, assign } = await client(f);
    await expect(db.auth.linkIdentity({ provider: "google", redirectTo: "https://app.test/cb" })).rejects.toMatchObject({
      code: "reauthentication_required",
      status: 403,
    });
    expect(storage.getItem(verifierKey)).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("names an identity already linked when the landed code is redeemed", async () => {
    const { fetch: f } = server(() => ({ status: 409, body: { error: "identity_already_exists", status: 409 } }));
    const { db, storage } = await client(f);
    storage.setItem(verifierKey, JSON.stringify({ verifier: "v".repeat(43), redirectTo: "https://app.test/cb", startedAt: Date.now() }));
    await expect(db.auth.exchangeCodeForSession("code")).rejects.toMatchObject({ code: "identity_already_exists" });
  });
});

describe("AuthClient.linkEmail", () => {
  it("asks for a code for the address and verifyOtp spends it with the kept verifier", async () => {
    const { fetch: f, calls } = server((call) =>
      call.url.endsWith("/verify")
        ? { body: { accessToken: "jwt-linked", refreshToken: "rt2", expiresIn: 3600, user: { id: 7, email: "octo@github.test" } } }
        : { body: { message: "sent" } },
    );
    const { db, storage } = await client(f);
    await db.auth.linkEmail({ email: " second@mail.test ", type: "email" });
    const kept = JSON.parse(storage.getItem(otpVerifierKey) as string);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${identitiesUrl}/email`, authorization: "Bearer jwt-signed-in" });
    expect(calls[0]!.body).toEqual({
      email: "second@mail.test",
      type: "email",
      code_challenge: s256(kept.verifier),
      code_challenge_method: "S256",
    });
    const session = await db.auth.verifyOtp({ type: "email", email: "second@mail.test", token: "12345678" });
    expect(session.accessToken).toBe("jwt-linked");
    expect(calls[1]!.body).toMatchObject({ code_verifier: kept.verifier });
  });

  it("sends a link to the redirect it is given", async () => {
    const { fetch: f, calls } = server(() => ({ body: { message: "sent" } }));
    const { db } = await client(f);
    await db.auth.linkEmail({ email: "second@mail.test", emailRedirectTo: "https://app.test/linked" });
    expect(calls[0]!.body).toMatchObject({ type: "magiclink", redirect_to: "https://app.test/linked" });
  });
});

describe("AuthClient identities", () => {
  it("lists the account's identities and whether it has a password", async () => {
    const listed = {
      identities: [{ id: 3, provider: "google", email: "a@g.test", createdAt: "2026-10-27T00:00:00Z", lastSignInAt: null }],
      hasPassword: false,
    };
    const { fetch: f, calls } = server(() => ({ body: listed }));
    const { db } = await client(f);
    await expect(db.auth.getUserIdentities()).resolves.toEqual(listed);
    expect(calls[0]).toMatchObject({ method: "GET", url: identitiesUrl, authorization: "Bearer jwt-signed-in" });
  });

  it("unlinks by identity or id and names the last way in", async () => {
    let status = 204;
    const { fetch: f, calls } = server(() =>
      status === 204 ? { status } : { status, body: { error: "last_sign_in_method", status } },
    );
    const { db } = await client(f);
    await db.auth.unlinkIdentity({ id: 3, provider: "google", email: "", createdAt: "", lastSignInAt: null });
    await db.auth.unlinkIdentity(4);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `DELETE ${identitiesUrl}/3`,
      `DELETE ${identitiesUrl}/4`,
    ]);
    status = 409;
    await expect(db.auth.unlinkIdentity(3)).rejects.toMatchObject({ code: "last_sign_in_method" });
  });
});
