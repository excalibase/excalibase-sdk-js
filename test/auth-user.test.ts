import { createClient, memoryStorageAdapter } from "../src";
import type { StorageAdapter } from "../src/storage";
import type { AuthChangeEvent } from "../src/types";

const baseOpts = {
  url: "http://localhost:10010",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  autoRefreshToken: false,
};

const sessionKey = "excalibase.auth.session:acme/prod";
const authUrl = "http://localhost:10010/auth/acme/prod";

const profile = {
  id: 7,
  email: "octo@app.test",
  fullName: "Octo",
  emailVerified: true,
  hasPassword: true,
  userMetadata: { theme: "dark" },
  appMetadata: { plan: "pro" },
  createdAt: "2026-10-27T00:00:00Z",
};

function signedIn(storage: StorageAdapter): void {
  storage.setItem(
    sessionKey,
    JSON.stringify({
      accessToken: "jwt-signed-in",
      refreshToken: "rt",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
      user: { id: 7, email: "octo@app.test", fullName: "Octo" },
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

async function client(fetchImpl: typeof fetch, storage = memoryStorageAdapter()) {
  signedIn(storage);
  const db = createClient({ ...baseOpts, storage, fetch: fetchImpl });
  await db.auth.hydrate();
  const events: AuthChangeEvent[] = [];
  db.auth.onAuthStateChange((event) => events.push(event));
  await Promise.resolve();
  events.length = 0;
  return { db, storage, events };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AuthClient.getUser", () => {
  it("reads the signed-in account with the session's token", async () => {
    const { fetch: f, calls } = server(() => ({ body: profile }));
    const { db } = await client(f);
    await expect(db.auth.getUser()).resolves.toEqual(profile);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${authUrl}/user`, authorization: "Bearer jwt-signed-in" });
  });

  it("needs a session and names the server's refusal", async () => {
    const { fetch: f, calls } = server(() => ({ status: 404, body: { error: "method_not_enabled" } }));
    const anonymous = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(anonymous.auth.getUser()).rejects.toMatchObject({ code: "not_signed_in" });
    expect(calls).toHaveLength(0);
    const { db } = await client(f);
    await expect(db.auth.getUser()).rejects.toMatchObject({ code: "method_not_enabled", status: 404 });
  });
});

describe("AuthClient.updateUser", () => {
  it("sends only the given fields, camelCase, and refreshes the session's user", async () => {
    const updated = { ...profile, fullName: "Octo Cat", userMetadata: { theme: "light" } };
    const { fetch: f, calls } = server(() => ({ body: { user: updated } }));
    const { db, storage, events } = await client(f);
    const result = await db.auth.updateUser({ fullName: "Octo Cat", data: { theme: "light", banner: null } });
    expect(calls[0]).toMatchObject({ method: "PATCH", url: `${authUrl}/user`, authorization: "Bearer jwt-signed-in" });
    expect(calls[0]!.body).toEqual({ fullName: "Octo Cat", data: { theme: "light", banner: null } });
    expect(result).toEqual({ user: updated, emailChangeRequested: false });
    expect(db.auth.user()).toEqual({ id: 7, email: "octo@app.test", fullName: "Octo Cat" });
    expect(db.auth.currentSession()?.accessToken).toBe("jwt-signed-in");
    expect(events).toEqual(["USER_UPDATED"]);
    await flush();
    expect(JSON.parse(storage.getItem(sessionKey) as string).user.fullName).toBe("Octo Cat");
  });

  it("asks for an address change with the redirect and reports it", async () => {
    const { fetch: f, calls } = server(() => ({ body: { user: profile, emailChangeRequested: true } }));
    const { db } = await client(f);
    const result = await db.auth.updateUser({ email: "new@app.test" }, { emailRedirectTo: "https://app.test/settings" });
    expect(calls[0]!.body).toEqual({ email: "new@app.test", emailRedirectTo: "https://app.test/settings" });
    expect(result.emailChangeRequested).toBe(true);
    expect(db.auth.user()?.email).toBe("octo@app.test");
  });

  it("installs and keeps the fresh session a password change returns", async () => {
    const fresh = {
      accessToken: "jwt-fresh",
      refreshToken: "rt-fresh",
      tokenType: "Bearer",
      expiresIn: 3600,
      user: { id: 7, email: "octo@app.test", fullName: "Octo" },
    };
    const { fetch: f, calls } = server(() => ({ body: { user: profile, session: fresh } }));
    const { db, storage, events } = await client(f);
    await db.auth.updateUser({ password: "new-secret", currentPassword: "old-secret" });
    expect(calls[0]!.body).toEqual({ password: "new-secret", currentPassword: "old-secret" });
    expect(db.auth.currentSession()).toMatchObject({ accessToken: "jwt-fresh", refreshToken: "rt-fresh" });
    expect(events).toEqual(["TOKEN_REFRESHED"]);
    await flush();
    expect(JSON.parse(storage.getItem(sessionKey) as string).accessToken).toBe("jwt-fresh");
  });

  it("refuses app metadata, unknown fields and non-object data before calling the server", async () => {
    const { fetch: f, calls } = server(() => ({ body: { user: profile } }));
    const { db } = await client(f);
    await expect(db.auth.updateUser({ appMetadata: { plan: "pro" } } as never)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(db.auth.updateUser({ data: ["a"] } as never)).rejects.toMatchObject({ code: "invalid_metadata" });
    await expect(db.auth.updateUser({ data: null } as never)).rejects.toMatchObject({ code: "invalid_metadata" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [403, "reauthentication_required"],
    [403, "email_not_verified"],
    [400, "invalid_metadata"],
    [400, "metadata_too_large"],
    [429, "rate_limited"],
    [404, "method_not_enabled"],
  ])("names a %i %s refusal by its code", async (status, error) => {
    const { fetch: f } = server(() => ({ status, body: { error, status } }));
    const { db } = await client(f);
    await expect(db.auth.updateUser({ fullName: "x" })).rejects.toMatchObject({ code: error, status });
  });

  it("needs a session", async () => {
    const { fetch: f, calls } = server(() => ({ body: {} }));
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(db.auth.updateUser({ fullName: "x" })).rejects.toMatchObject({ code: "not_signed_in" });
    expect(calls).toHaveLength(0);
  });
});

describe("AuthClient.signOut scopes", () => {
  it("local stays as it was: revokes the refresh token without a scope and swallows failures", async () => {
    const { fetch: f, calls } = server(() => ({ status: 500, body: { error: "boom" } }));
    const { db } = await client(f);
    await db.auth.signOut({ scope: "local" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/logout`, body: { refreshToken: "rt" } });
    expect(db.auth.currentSession()).toBeNull();
  });

  it("global ends every session with the bearer and clears this one", async () => {
    const { fetch: f, calls } = server(() => ({ body: {} }));
    const { db, events } = await client(f);
    await db.auth.signOut({ scope: "global" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${authUrl}/logout?scope=global`,
      authorization: "Bearer jwt-signed-in",
      body: { refreshToken: "rt" },
    });
    expect(db.auth.currentSession()).toBeNull();
    expect(events).toEqual(["SIGNED_OUT"]);
  });

  it("global clears this session even when the server refuses, then names the refusal", async () => {
    const { fetch: f } = server(() => ({ status: 404, body: { error: "method_not_enabled" } }));
    const { db } = await client(f);
    await expect(db.auth.signOut({ scope: "global" })).rejects.toMatchObject({ code: "method_not_enabled" });
    expect(db.auth.currentSession()).toBeNull();
  });

  it("others ends the other sessions and keeps this one, even when refused", async () => {
    let status = 200;
    const { fetch: f, calls } = server(() => (status === 200 ? { body: {} } : { status, body: { error: "invalid_scope" } }));
    const { db, events } = await client(f);
    await db.auth.signOut({ scope: "others" });
    expect(calls[0]).toMatchObject({
      url: `${authUrl}/logout?scope=others`,
      authorization: "Bearer jwt-signed-in",
      body: { refreshToken: "rt" },
    });
    expect(db.auth.currentSession()?.accessToken).toBe("jwt-signed-in");
    expect(events).toEqual([]);
    status = 400;
    await expect(db.auth.signOut({ scope: "others" })).rejects.toMatchObject({ code: "invalid_scope" });
    expect(db.auth.currentSession()?.accessToken).toBe("jwt-signed-in");
  });

  it("refuses an unknown scope and a global or others sign-out without a session", async () => {
    const { fetch: f, calls } = server(() => ({ body: {} }));
    const { db } = await client(f);
    await expect(db.auth.signOut({ scope: "everyone" as never })).rejects.toMatchObject({ code: "invalid_scope" });
    expect(db.auth.currentSession()).not.toBeNull();
    const anonymous = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(anonymous.auth.signOut({ scope: "others" })).rejects.toMatchObject({ code: "not_signed_in" });
    expect(calls).toHaveLength(0);
  });
});

describe("AuthClient email change confirmation", () => {
  const refreshed = {
    accessToken: "jwt-new-address",
    refreshToken: "rt2",
    tokenType: "Bearer",
    expiresIn: 3600,
    user: { id: 7, email: "new@app.test", fullName: "Octo" },
  };

  function confirming(confirmStatus = 200, confirmBody: unknown = { message: "Email address changed" }) {
    return server((call) =>
      call.url.endsWith("/token") ? { body: refreshed } : { status: confirmStatus, body: confirmBody },
    );
  }

  it("confirms without a verifier or session and returns no user", async () => {
    const { fetch: f, calls } = confirming();
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(db.auth.confirmEmailChange({ tokenHash: "th1" })).resolves.toEqual({ user: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/user/email/confirm`, body: { token_hash: "th1" } });
  });

  it("refreshes a signed-in session so the new address shows", async () => {
    const { fetch: f, calls } = confirming();
    const { db, events } = await client(f);
    const result = await db.auth.verifyOtp({ type: "email_change", token_hash: "th1" });
    expect(result).toEqual({ user: refreshed.user });
    expect(calls[1]).toMatchObject({ url: `${authUrl}/token`, body: { grant_type: "refresh_token", refresh_token: "rt" } });
    expect(db.auth.user()?.email).toBe("new@app.test");
    expect(events).toEqual(["USER_UPDATED"]);
  });

  it.each([
    [400, "invalid_or_expired_token"],
    [409, "email_exists"],
  ])("names a %i %s refusal and keeps the session as it was", async (status, error) => {
    const { fetch: f, calls } = confirming(status, { error, status });
    const { db } = await client(f);
    await expect(db.auth.confirmEmailChange({ tokenHash: "th1" })).rejects.toMatchObject({ code: error, status });
    expect(calls).toHaveLength(1);
    expect(db.auth.user()?.email).toBe("octo@app.test");
  });

  it("refuses an empty token hash before calling the server", async () => {
    const { fetch: f, calls } = confirming();
    const db = createClient({ ...baseOpts, storage: memoryStorageAdapter(), fetch: f });
    await expect(db.auth.confirmEmailChange({ tokenHash: " " })).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("hydrate confirms a landed ?type=email_change link and removes it from the address bar", async () => {
    const { fetch: f, calls } = confirming();
    const replaceState = jest.fn();
    const db = createClient({
      ...baseOpts,
      storage: memoryStorageAdapter(),
      fetch: f,
      location: { href: "https://app.test/settings?token_hash=th1&type=email_change&tab=account", assign: jest.fn() },
      history: { replaceState },
    });
    expect(await db.auth.hydrate()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.test/settings?tab=account");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${authUrl}/user/email/confirm`, body: { token_hash: "th1" } });
  });

  it("hydrate leaves a page without an email change link alone", async () => {
    const { fetch: f, calls } = confirming();
    const replaceState = jest.fn();
    const db = createClient({
      ...baseOpts,
      storage: memoryStorageAdapter(),
      fetch: f,
      location: { href: "https://app.test/settings?token_hash=th1&type=recovery", assign: jest.fn() },
      history: { replaceState },
    });
    await db.auth.hydrate();
    expect(replaceState).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
