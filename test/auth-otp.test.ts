import { createHash } from "node:crypto";
import { createClient, memoryStorageAdapter } from "../src";
import { AuthError } from "../src/errors";
import type { StorageAdapter } from "../src/storage";

const baseOpts = {
  url: "http://localhost:10010",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  autoRefreshToken: false,
};

const otpKey = "excalibase.auth.session:acme/prod-otp-verifier";
const oauthKey = "excalibase.auth.session:acme/prod-code-verifier";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function keep(storage: StorageAdapter, redirectTo = "https://app.test/cb", startedAt = Date.now()): void {
  storage.setItem(otpKey, JSON.stringify({ verifier: "w".repeat(43), redirectTo, startedAt }));
}

function sessionBody() {
  return {
    accessToken: "jwt-otp",
    refreshToken: "rt-otp",
    tokenType: "Bearer",
    expiresIn: 3600,
    user: { id: 9, email: "ann@app.test", fullName: "ann" },
  };
}

function serverFetch(status = 200, body: unknown = sessionBody()) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: f, calls };
}

const sent = { message: "If the address can sign in, a sign-in email has been sent" };

describe("AuthClient.signInWithOtp", () => {
  it("asks for a link with an S256 challenge of a verifier it keeps", async () => {
    const storage = memoryStorageAdapter();
    const { fetch: f, calls } = serverFetch(200, sent);
    const db = createClient({ ...baseOpts, storage, fetch: f });
    await db.auth.signInWithOtp({ email: "ann@app.test", emailRedirectTo: "https://app.test/cb" });
    expect(calls[0]!.url).toBe("http://localhost:10010/auth/acme/prod/otp");
    const kept = JSON.parse(storage.getItem(otpKey) as string);
    expect(kept.redirectTo).toBe("https://app.test/cb");
    expect(calls[0]!.body).toEqual({
      email: "ann@app.test",
      type: "magiclink",
      create_user: true,
      redirect_to: "https://app.test/cb",
      code_challenge: s256(kept.verifier),
      code_challenge_method: "S256",
    });
    expect(storage.getItem(oauthKey)).toBeNull();
  });

  it("asks for a code, honouring shouldCreateUser, with no redirect", async () => {
    const { fetch: f, calls } = serverFetch(200, sent);
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await db.auth.signInWithOtp({ email: "ann@app.test", type: "email", shouldCreateUser: false });
    expect(calls[0]!.body).toMatchObject({ type: "email", create_user: false });
    expect(calls[0]!.body).not.toHaveProperty("redirect_to");
  });

  it("refuses a missing address or an unknown type before calling the server", async () => {
    const storage = memoryStorageAdapter();
    const { fetch: f, calls } = serverFetch(200, sent);
    const db = createClient({ ...baseOpts, storage, fetch: f });
    await expect(db.auth.signInWithOtp({ email: " " })).rejects.toBeInstanceOf(AuthError);
    await expect(db.auth.signInWithOtp({ email: "a@b.test", type: "sms" as never })).rejects.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(0);
    expect(storage.getItem(otpKey)).toBeNull();
  });

  it("names the server's refusal by its code", async () => {
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: serverFetch(404, { error: "method_not_enabled" }).fetch });
    await expect(db.auth.signInWithOtp({ email: "ann@app.test" })).rejects.toMatchObject({ code: "method_not_enabled", status: 404 });
    const limited = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: serverFetch(429, { error: "rate_limited" }).fetch });
    await expect(limited.auth.signInWithOtp({ email: "ann@app.test" })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("AuthClient.verifyOtp", () => {
  it("spends a code with the kept verifier, signs in and forgets the verifier", async () => {
    const storage = memoryStorageAdapter();
    keep(storage, "");
    const { fetch: f, calls } = serverFetch();
    const db = createClient({ ...baseOpts, storage, fetch: f });
    const events: string[] = [];
    db.auth.onAuthStateChange((event) => events.push(event));
    const session = await db.auth.verifyOtp({ email: "ann@app.test", token: "042917", type: "email" });
    expect(calls[0]!.url).toBe("http://localhost:10010/auth/acme/prod/verify");
    expect(calls[0]!.body).toEqual({ type: "email", email: "ann@app.test", token: "042917", code_verifier: "w".repeat(43) });
    expect(session.user?.email).toBe("ann@app.test");
    expect(db.auth.currentSession()?.accessToken).toBe("jwt-otp");
    expect(storage.getItem(otpKey)).toBeNull();
    await Promise.resolve();
    expect(events).toContain("SIGNED_IN");
  });

  it("keeps the verifier after a wrong code, so the user can try again", async () => {
    const storage = memoryStorageAdapter();
    keep(storage, "");
    const db = createClient({ ...baseOpts, storage, fetch: serverFetch(400, { error: "invalid_or_expired_token" }).fetch });
    await expect(db.auth.verifyOtp({ email: "ann@app.test", token: "000000", type: "email" })).rejects.toMatchObject({
      code: "invalid_or_expired_token",
    });
    expect(storage.getItem(otpKey)).not.toBeNull();
  });

  it("spends a link by its token hash and forgets the verifier even when refused", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const { fetch: f, calls } = serverFetch(400, { error: "invalid_or_expired_token" });
    const db = createClient({ ...baseOpts, storage, fetch: f });
    await expect(db.auth.verifyOtp({ token_hash: "th", type: "magiclink" })).rejects.toBeInstanceOf(AuthError);
    expect(calls[0]!.body).toEqual({ type: "magiclink", token_hash: "th", code_verifier: "w".repeat(43) });
    expect(storage.getItem(otpKey)).toBeNull();
  });

  it("refuses without a kept verifier and never calls the server", async () => {
    const { fetch: f, calls } = serverFetch();
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(db.auth.verifyOtp({ email: "a@b.test", token: "123456", type: "email" })).rejects.toMatchObject({
      code: "pkce_verifier_missing",
    });
    const stale = memoryStorageAdapter();
    keep(stale, "", Date.now() - 11 * 60 * 1000);
    await expect(
      createClient({ ...baseOpts, storage: stale, fetch: f }).auth.verifyOtp({ token_hash: "th", type: "magiclink" }),
    ).rejects.toMatchObject({ code: "pkce_verifier_missing" });
    expect(calls).toHaveLength(0);
  });
});

describe("AuthClient.hydrate finishes a magic link that landed on the page", () => {
  function landedAt(href: string, storage: StorageAdapter, f: typeof fetch) {
    const replaceState = jest.fn();
    const db = createClient({ ...baseOpts, storage, fetch: f, location: { href, assign: jest.fn() }, history: { replaceState } });
    return { db, replaceState };
  }

  it("spends ?token_hash= and removes it from the address bar", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const { fetch: f, calls } = serverFetch();
    const { db, replaceState } = landedAt("https://app.test/cb?token_hash=th1&type=magiclink&next=%2Fhome", storage, f);
    const session = await db.auth.hydrate();
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.test/cb?next=%2Fhome");
    expect(calls[0]!.body).toMatchObject({ type: "magiclink", token_hash: "th1" });
    expect(session?.accessToken).toBe("jwt-otp");
  });

  it("leaves a link alone when this browser asked for none, or on another page", async () => {
    const { fetch: f, calls } = serverFetch();
    await landedAt("https://app.test/cb?token_hash=th1&type=magiclink", memoryStorageAdapter(), f).db.auth.hydrate();
    const other = memoryStorageAdapter();
    keep(other, "https://app.test/auth/callback");
    await landedAt("https://app.test/invite?token_hash=th1&type=magiclink", other, f).db.auth.hydrate();
    expect(calls).toHaveLength(0);
  });
});
