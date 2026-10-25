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

const verifierKey = "excalibase.auth.session:acme/prod-code-verifier";

function keep(storage: StorageAdapter, redirectTo = "https://app.test/cb", startedAt = Date.now()): void {
  storage.setItem(verifierKey, JSON.stringify({ verifier: "v".repeat(43), redirectTo, startedAt }));
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sessionBody() {
  return {
    accessToken: "jwt-oauth",
    refreshToken: "rt-oauth",
    tokenType: "Bearer",
    expiresIn: 3600,
    user: { id: 7, email: "octo@github.test", fullName: "Octo" },
  };
}

function tokenFetch(status = 200, body: unknown = sessionBody()) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const f: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: f, calls };
}

describe("AuthClient.signInWithOAuth", () => {
  it("builds the authorize URL with an S256 challenge of a verifier it keeps", async () => {
    const storage = memoryStorageAdapter();
    const db = createClient({ ...baseOpts, storage, fetch: tokenFetch().fetch });
    const { url, provider } = await db.auth.signInWithOAuth({
      provider: "github",
      redirectTo: "https://app.test/auth/callback",
      skipBrowserRedirect: true,
    });
    const parsed = new URL(url);
    expect(provider).toBe("github");
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:10010/auth/acme/prod/authorize");
    expect(parsed.searchParams.get("provider")).toBe("github");
    expect(parsed.searchParams.get("redirect_to")).toBe("https://app.test/auth/callback");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    const kept = JSON.parse(storage.getItem(verifierKey) as string);
    expect(kept.redirectTo).toBe("https://app.test/auth/callback");
    const verifier = kept.verifier as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(parsed.searchParams.get("code_challenge")).toBe(s256(verifier));
  });

  it("sends the browser to the provider unless told not to", async () => {
    const assign = jest.fn();
    const db = createClient({
      ...baseOpts,
      storage: memoryStorageAdapter(),
      fetch: tokenFetch().fetch,
      location: { href: "https://app.test/", assign },
    });
    const { url } = await db.auth.signInWithOAuth({ provider: "google", redirectTo: "https://app.test/cb" });
    expect(assign).toHaveBeenCalledWith(url);
  });

  it("refuses an unknown provider or a missing redirect without touching storage", async () => {
    const storage = memoryStorageAdapter();
    const db = createClient({ ...baseOpts, storage, fetch: tokenFetch().fetch });
    await expect(
      db.auth.signInWithOAuth({ provider: "facebook" as never, redirectTo: "https://app.test/cb", skipBrowserRedirect: true }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      db.auth.signInWithOAuth({ provider: "github", redirectTo: "", skipBrowserRedirect: true }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(storage.getItem(verifierKey)).toBeNull();
  });
});

describe("AuthClient.exchangeCodeForSession", () => {
  it("redeems the code with the kept verifier once, then forgets the verifier", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const { fetch: f, calls } = tokenFetch();
    const db = createClient({ ...baseOpts, storage, fetch: f });
    const events: string[] = [];
    db.auth.onAuthStateChange((event) => events.push(event));
    const session = await db.auth.exchangeCodeForSession("the-code");
    expect(calls[0]!.url).toBe("http://localhost:10010/auth/acme/prod/token");
    expect(calls[0]!.body).toEqual({ grant_type: "pkce", auth_code: "the-code", code_verifier: "v".repeat(43) });
    expect(session.user?.email).toBe("octo@github.test");
    expect(db.auth.currentSession()?.accessToken).toBe("jwt-oauth");
    expect(storage.getItem(verifierKey)).toBeNull();
    await Promise.resolve();
    expect(events).toContain("SIGNED_IN");
  });

  it("refuses without a kept verifier and never calls the server", async () => {
    const { fetch: f, calls } = tokenFetch();
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(db.auth.exchangeCodeForSession("the-code")).rejects.toMatchObject({ code: "pkce_verifier_missing" });
    expect(calls).toHaveLength(0);
  });

  it("surfaces a refused code as AuthError and still forgets the verifier", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const db = createClient({ ...baseOpts, storage, fetch: tokenFetch(400, { error: "invalid or expired code" }).fetch });
    await expect(db.auth.exchangeCodeForSession("bad")).rejects.toMatchObject({ status: 400 });
    expect(storage.getItem(verifierKey)).toBeNull();
    expect(db.auth.currentSession()).toBeNull();
  });
});

describe("AuthClient.hydrate finishes a sign-in that landed back on the page", () => {
  function landedAt(href: string, storage: StorageAdapter, f: typeof fetch, detectSessionInUrl?: boolean) {
    const replaceState = jest.fn();
    const db = createClient({
      ...baseOpts,
      storage,
      fetch: f,
      location: { href, assign: jest.fn() },
      history: { replaceState },
      detectSessionInUrl,
    });
    return { db, replaceState };
  }

  it("exchanges ?code= and removes it from the address bar", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const { fetch: f, calls } = tokenFetch();
    const { db, replaceState } = landedAt("https://app.test/cb?code=abc&next=%2Fhome", storage, f);
    const session = await db.auth.hydrate();
    expect(calls[0]!.body).toMatchObject({ grant_type: "pkce", auth_code: "abc" });
    expect(session?.accessToken).toBe("jwt-oauth");
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.test/cb?next=%2Fhome");
  });

  it("leaves a ?code= alone when this browser started no sign-in", async () => {
    const { fetch: f, calls } = tokenFetch();
    const { db, replaceState } = landedAt("https://app.test/cb?code=abc", memoryStorageAdapter(), f);
    expect(await db.auth.hydrate()).toBeNull();
    expect(calls).toHaveLength(0);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("ignores a ?code= on another page, or a sign-in that went stale", async () => {
    const { fetch: f, calls } = tokenFetch();
    const other = memoryStorageAdapter();
    keep(other, "https://app.test/auth/callback");
    await landedAt("https://app.test/invite?code=abc", other, f).db.auth.hydrate();
    const stale = memoryStorageAdapter();
    keep(stale, "https://app.test/cb", Date.now() - 11 * 60 * 1000);
    await landedAt("https://app.test/cb?code=abc", stale, f).db.auth.hydrate();
    expect(calls).toHaveLength(0);
    await expect(createClient({ ...baseOpts, storage: stale, fetch: f }).auth.exchangeCodeForSession("abc")).rejects.toMatchObject({
      code: "pkce_verifier_missing",
    });
  });

  it("an ?error= auth never sends is reported as server_error, not echoed", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const { db } = landedAt("https://app.test/cb?error=%3Cimg%20src%3Dx%3E", storage, tokenFetch().fetch);
    await expect(db.auth.hydrate()).rejects.toMatchObject({ code: "server_error", message: "Sign-in failed: server_error" });
  });

  it("does nothing when detectSessionInUrl is false", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const { fetch: f, calls } = tokenFetch();
    const { db } = landedAt("https://app.test/cb?code=abc", storage, f, false);
    await db.auth.hydrate();
    expect(calls).toHaveLength(0);
  });

  it("an ?error= ends the sign-in: the verifier is dropped and hydrate reports it", async () => {
    const storage = memoryStorageAdapter();
    keep(storage);
    const { fetch: f, calls } = tokenFetch();
    const { db, replaceState } = landedAt("https://app.test/cb?error=signup_disabled", storage, f);
    await expect(db.auth.hydrate()).rejects.toMatchObject({ code: "signup_disabled" });
    expect(calls).toHaveLength(0);
    expect(storage.getItem(verifierKey)).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.test/cb");
  });
});
