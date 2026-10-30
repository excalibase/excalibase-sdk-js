import { AuthError, createClient, memoryStorageAdapter } from "../src";
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
const member = { id: 7, email: "octo@app.test", fullName: "Octo" };

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned token carrying the given claims; the SDK reads claims without checking the signature. */
function accessToken(claims: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: "RS256" }))}.${base64Url(JSON.stringify({ sub: "7", ...claims }))}.signature`;
}

const aal1Token = accessToken({ aal: "aal1", amr: ["password"], name: "Ö" });
const aal2Token = accessToken({ aal: "aal2", amr: ["password", "totp"] });
const aal2Session = { accessToken: aal2Token, refreshToken: "rt-aal2", tokenType: "Bearer", expiresIn: 3600, user: member };

function signedIn(storage: StorageAdapter, token = aal1Token, user: Record<string, unknown> = member, refreshToken: string | null = "rt-aal1"): void {
  storage.setItem(
    sessionKey,
    JSON.stringify({ accessToken: token, refreshToken, tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, user }),
  );
}

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

type Answer = { status?: number; body?: unknown };

function server(answer: (call: Call) => Answer | Promise<Answer>) {
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
    const { status = 200, body } = await answer(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: f, calls };
}

async function client(fetchImpl: typeof fetch, prepare: (storage: StorageAdapter) => void = signedIn) {
  const storage = memoryStorageAdapter();
  prepare(storage);
  const db = createClient({ ...baseOpts, storage, fetch: fetchImpl });
  await db.auth.hydrate();
  const events: AuthChangeEvent[] = [];
  const payloads: string[] = [];
  db.auth.onAuthStateChange((event, session) => {
    events.push(event);
    payloads.push(JSON.stringify(session));
  });
  await Promise.resolve();
  events.length = 0;
  payloads.length = 0;
  return { db, storage, events, payloads };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const verifiedFactor = {
  id: "f-1",
  factorType: "totp",
  friendlyName: "Phone",
  status: "verified",
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
};
const unverifiedFactor = { ...verifiedFactor, id: "f-2", friendlyName: "Tablet", status: "unverified" };

describe("auth.mfa.enroll", () => {
  it("asks for a TOTP factor with the session's token and returns the secret", async () => {
    const enrolled = { id: "f-2", factorType: "totp", friendlyName: "Tablet", status: "unverified", totp: { secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" } };
    const { fetch: f, calls } = server(() => ({ status: 201, body: enrolled }));
    const { db } = await client(f);
    await expect(db.auth.mfa.enroll({ factorType: "totp", friendlyName: "Tablet", issuer: "Acme" })).resolves.toEqual(enrolled);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/factors`, authorization: `Bearer ${aal1Token}` });
    expect(calls[0]!.body).toEqual({ factorType: "totp", friendlyName: "Tablet", issuer: "Acme" });

    await db.auth.mfa.enroll({ factorType: "totp" });
    expect(calls[1]!.body).toEqual({ factorType: "totp" });
  });

  it("keeps the secret out of storage and events", async () => {
    const enrolled = { id: "f-2", factorType: "totp", friendlyName: "", status: "unverified", totp: { secret: "SECRETBASE32", uri: "otpauth://totp/x" } };
    const { fetch: f } = server(() => ({ status: 201, body: enrolled }));
    const { db, storage, events } = await client(f);
    await db.auth.mfa.enroll({ factorType: "totp" });
    await flush();
    expect(storage.getItem(sessionKey)).not.toContain("SECRETBASE32");
    expect(events).toEqual([]);
  });

  it("names the server's refusal and sends nothing when signed out", async () => {
    const { fetch: f, calls } = server(() => ({ status: 403, body: { error: "insufficient_aal" } }));
    const { db } = await client(f);
    const refusal = await db.auth.mfa.enroll({ factorType: "totp" }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AuthError);
    expect(refusal).toMatchObject({ code: "insufficient_aal", status: 403 });

    const anonymous = await client(f, () => undefined);
    await expect(anonymous.db.auth.mfa.enroll({ factorType: "totp" })).rejects.toMatchObject({ code: "not_signed_in" });
    expect(calls).toHaveLength(1);
  });
});

describe("auth.mfa.challenge and verify", () => {
  it("challenges a factor", async () => {
    const { fetch: f, calls } = server(() => ({ status: 201, body: { id: "c-1", expiresAt: "2026-10-30T00:05:00Z" } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.challenge({ factorId: "f/1" })).resolves.toEqual({ id: "c-1", expiresAt: "2026-10-30T00:05:00Z" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/factors/f%2F1/challenge`, authorization: `Bearer ${aal1Token}` });
  });

  it("sends the stored refresh token, installs the aal2 session like a sign-in and returns the recovery codes once", async () => {
    const codes = Array.from({ length: 10 }, (_, index) => `code-${index}`);
    const { fetch: f, calls } = server(() => ({ body: { ...aal2Session, recoveryCodes: codes } }));
    const { db, storage, events, payloads } = await client(f);
    const result = await db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "123456" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/factors/f-1/verify`, authorization: `Bearer ${aal1Token}` });
    expect(calls[0]!.body).toEqual({ challengeId: "c-1", code: "123456", refreshToken: "rt-aal1" });
    expect(result.recoveryCodes).toEqual(codes);
    expect(result.session).toMatchObject({ accessToken: aal2Token, refreshToken: "rt-aal2", user: member });
    expect(db.auth.currentSession()).toEqual(result.session);
    expect(events).toEqual(["MFA_CHALLENGE_VERIFIED"]);
    await flush();
    const stored = storage.getItem(sessionKey) as string;
    expect(JSON.parse(stored).refreshToken).toBe("rt-aal2");
    expect(stored).not.toContain("code-");
    expect(payloads.join()).not.toContain("code-");
  });

  it("leaves recoveryCodes out when the factor is not the account's first", async () => {
    const { fetch: f } = server(() => ({ body: aal2Session }));
    const { db } = await client(f);
    const result = await db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "123456" });
    expect(result).not.toHaveProperty("recoveryCodes");
  });

  it("keeps the session when the code is refused", async () => {
    const { fetch: f } = server(() => ({ status: 400, body: { error: "invalid_code" } }));
    const { db, events } = await client(f);
    await expect(db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "000000" })).rejects.toMatchObject({ code: "invalid_code", status: 400 });
    expect(db.auth.currentSession()?.accessToken).toBe(aal1Token);
    expect(events).toEqual([]);
  });

  it.each([
    [400, "invalid_challenge"],
    [429, "too_many_attempts"],
    [404, "method_not_enabled"],
    [403, "email_required"],
    [403, "insufficient_aal"],
  ])("names %i %s", async (status, code) => {
    const { fetch: f } = server(() => ({ status, body: { error: code } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "1" })).rejects.toMatchObject({ code, status });
  });

  it("refuses a session that has no refresh token to rotate", async () => {
    const { fetch: f, calls } = server(() => ({ body: aal2Session }));
    const { db } = await client(f, (storage) => signedIn(storage, aal1Token, member, null));
    await expect(db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "1" })).rejects.toMatchObject({ code: "not_signed_in" });
    expect(calls).toHaveLength(0);
  });

  it("challengeAndVerify challenges then verifies with that challenge", async () => {
    const { fetch: f, calls } = server((call) =>
      call.url.endsWith("/challenge") ? { status: 201, body: { id: "c-9", expiresAt: "later" } } : { body: aal2Session },
    );
    const { db } = await client(f);
    const result = await db.auth.mfa.challengeAndVerify({ factorId: "f-1", code: "654321" });
    expect(calls.map((call) => call.url)).toEqual([`${authUrl}/factors/f-1/challenge`, `${authUrl}/factors/f-1/verify`]);
    expect(calls[1]!.body).toEqual({ challengeId: "c-9", code: "654321", refreshToken: "rt-aal1" });
    expect(result.session.accessToken).toBe(aal2Token);
  });
});

describe("auth.mfa.unenroll and listFactors", () => {
  it("deletes a factor", async () => {
    const { fetch: f, calls } = server(() => ({ status: 204 }));
    const { db } = await client(f);
    await expect(db.auth.mfa.unenroll({ factorId: "f-1" })).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${authUrl}/factors/f-1`, authorization: `Bearer ${aal1Token}`, body: undefined });
  });

  it("names insufficient_aal on unenroll", async () => {
    const { fetch: f } = server(() => ({ status: 403, body: { error: "insufficient_aal" } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.unenroll({ factorId: "f-1" })).rejects.toMatchObject({ code: "insufficient_aal" });
  });

  it("lists every factor, the verified TOTP ones, and the recovery codes left", async () => {
    const { fetch: f, calls } = server(() => ({ body: { factors: [verifiedFactor, unverifiedFactor], recoveryCodesRemaining: 9 } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.listFactors()).resolves.toEqual({
      all: [verifiedFactor, unverifiedFactor],
      totp: [verifiedFactor],
      recoveryCodesRemaining: 9,
    });
    expect(calls[0]).toMatchObject({ method: "GET", url: `${authUrl}/factors`, authorization: `Bearer ${aal1Token}` });
  });

  it("refuses a list that is not one", async () => {
    const { fetch: f } = server(() => ({ body: { factors: "nope" } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.listFactors()).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("auth.mfa.getAuthenticatorAssuranceLevel", () => {
  it("reads the level and methods from the token and asks for aal2 when a factor is verified", async () => {
    const { fetch: f } = server(() => ({ body: { factors: [verifiedFactor], recoveryCodesRemaining: 10 } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.getAuthenticatorAssuranceLevel()).resolves.toEqual({
      currentLevel: "aal1",
      nextLevel: "aal2",
      currentAuthenticationMethods: ["password"],
    });
  });

  it("keeps the current level as the next when no factor is verified", async () => {
    const { fetch: f } = server(() => ({ body: { factors: [unverifiedFactor], recoveryCodesRemaining: 0 } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.getAuthenticatorAssuranceLevel()).resolves.toEqual({
      currentLevel: "aal1",
      nextLevel: "aal1",
      currentAuthenticationMethods: ["password"],
    });
  });

  it("reports aal2 after a second factor", async () => {
    const { fetch: f } = server(() => ({ body: { factors: [verifiedFactor], recoveryCodesRemaining: 10 } }));
    const { db } = await client(f, (storage) => signedIn(storage, aal2Token));
    await expect(db.auth.mfa.getAuthenticatorAssuranceLevel()).resolves.toEqual({
      currentLevel: "aal2",
      nextLevel: "aal2",
      currentAuthenticationMethods: ["password", "totp"],
    });
  });

  it("is null and asks nothing when signed out", async () => {
    const { fetch: f, calls } = server(() => ({ body: {} }));
    const { db } = await client(f, () => undefined);
    await expect(db.auth.mfa.getAuthenticatorAssuranceLevel()).resolves.toEqual({
      currentLevel: null,
      nextLevel: null,
      currentAuthenticationMethods: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("asks nothing when the token carries no level (MFA off) or for a guest", async () => {
    const { fetch: f, calls } = server(() => ({ body: {} }));
    const off = await client(f, (storage) => signedIn(storage, accessToken({})));
    await expect(off.db.auth.mfa.getAuthenticatorAssuranceLevel()).resolves.toEqual({
      currentLevel: null,
      nextLevel: null,
      currentAuthenticationMethods: [],
    });
    const guest = await client(f, (storage) => signedIn(storage, accessToken({ aal: "aal1", amr: ["guest"] }), { ...member, isGuest: true }));
    await expect(guest.db.auth.mfa.getAuthenticatorAssuranceLevel()).resolves.toEqual({
      currentLevel: "aal1",
      nextLevel: "aal1",
      currentAuthenticationMethods: ["guest"],
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["not-a-jwt", null, []],
    ["a.!!!.c", null, []],
    [`a.${base64Url("[1]")}.c`, null, []],
    [accessToken({ aal: "aal3", amr: "password" }), null, []],
    [accessToken({ aal: "aal1", amr: ["password", 3] }), "aal1", ["password"]],
  ])("reads an unreadable or unexpected token %s safely", async (token, currentLevel, methods) => {
    const { fetch: f } = server(() => ({ body: { factors: [], recoveryCodesRemaining: 0 } }));
    const { db } = await client(f, (storage) => signedIn(storage, token));
    const level = await db.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(level.currentLevel).toBe(currentLevel);
    expect(level.currentAuthenticationMethods).toEqual(methods);
  });

  it("passes a listFactors refusal on", async () => {
    const { fetch: f } = server(() => ({ status: 404, body: { error: "method_not_enabled" } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.getAuthenticatorAssuranceLevel()).rejects.toMatchObject({ code: "method_not_enabled" });
  });
});

describe("auth.mfa recovery codes", () => {
  it("spends a recovery code with the stored refresh token and installs the aal2 session", async () => {
    const recovered = { ...aal2Session, accessToken: accessToken({ aal: "aal2", amr: ["password", "recovery"] }) };
    const { fetch: f, calls } = server(() => ({ body: recovered }));
    const { db, events } = await client(f);
    const { session } = await db.auth.mfa.useRecoveryCode({ code: "abcd-efgh" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/factors/recovery`, authorization: `Bearer ${aal1Token}` });
    expect(calls[0]!.body).toEqual({ code: "abcd-efgh", refreshToken: "rt-aal1" });
    expect(session.accessToken).toBe(recovered.accessToken);
    expect(db.auth.currentSession()).toEqual(session);
    expect(events).toEqual(["MFA_CHALLENGE_VERIFIED"]);
  });

  it("names a spent or wrong recovery code", async () => {
    const { fetch: f } = server(() => ({ status: 400, body: { error: "invalid_code" } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.useRecoveryCode({ code: "used" })).rejects.toMatchObject({ code: "invalid_code" });
    expect(db.auth.currentSession()?.accessToken).toBe(aal1Token);
  });

  it("regenerates the codes", async () => {
    const { fetch: f, calls } = server(() => ({ body: { recoveryCodes: ["a", "b"] } }));
    const { db } = await client(f, (storage) => signedIn(storage, aal2Token));
    await expect(db.auth.mfa.regenerateRecoveryCodes()).resolves.toEqual({ recoveryCodes: ["a", "b"] });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/factors/recovery-codes`, authorization: `Bearer ${aal2Token}` });
  });

  it("names insufficient_aal when regenerating at aal1", async () => {
    const { fetch: f } = server(() => ({ status: 403, body: { error: "insufficient_aal" } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.regenerateRecoveryCodes()).rejects.toMatchObject({ code: "insufficient_aal" });
  });

  it("keeps an unknown error text out of the code", async () => {
    const { fetch: f } = server(() => ({ status: 401, body: { error: "invalid refresh token" } }));
    const { db } = await client(f);
    await expect(db.auth.mfa.useRecoveryCode({ code: "x" })).rejects.toMatchObject({ code: "http_401", message: "invalid refresh token" });
  });
});

describe("auth.mfa response shapes", () => {
  it.each([
    ["verify without an access token", { refreshToken: "rt", user: member }],
    ["verify with recovery codes that are not a list", { ...aal2Session, recoveryCodes: "abc" }],
  ])("refuses %s and keeps the session", async (_name, body) => {
    const { fetch: f } = server(() => ({ body }));
    const { db, events } = await client(f);
    await expect(db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "1" })).rejects.toMatchObject({ code: "invalid_response" });
    expect(db.auth.currentSession()?.accessToken).toBe(aal1Token);
    expect(events).toEqual([]);
  });

  it("refuses regenerated codes that are not a list", async () => {
    const { fetch: f } = server(() => ({ body: {} }));
    const { db } = await client(f);
    await expect(db.auth.mfa.regenerateRecoveryCodes()).rejects.toMatchObject({ code: "invalid_response" });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

describe("auth.mfa step-up against the background refresh", () => {
  const refreshedAal1 = { accessToken: accessToken({ aal: "aal1", amr: ["password"], n: 2 }), refreshToken: "rt-aal1-next", tokenType: "Bearer", expiresIn: 3600, user: member };
  /** Expires in 61 s, so auto-refresh fires after 1 s. */
  const nearlyExpired = (storage: StorageAdapter) =>
    storage.setItem(sessionKey, JSON.stringify({ accessToken: aal1Token, refreshToken: "rt-aal1", tokenType: "Bearer", expiresAt: Date.now() + 61_000, user: member }));

  async function autoRefreshingClient(fetchImpl: typeof fetch) {
    const storage = memoryStorageAdapter();
    nearlyExpired(storage);
    const db = createClient({ ...baseOpts, autoRefreshToken: true, storage, fetch: fetchImpl });
    await db.auth.hydrate();
    const events: AuthChangeEvent[] = [];
    db.auth.onAuthStateChange((event) => events.push(event));
    await jest.advanceTimersByTimeAsync(0);
    events.length = 0;
    return { db, events };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("waits for a refresh in flight and verifies with the refreshed token", async () => {
    const refreshGate = deferred<Answer>();
    const { fetch: f, calls } = server((call) => (call.url.endsWith("/token") ? refreshGate.promise : { body: aal2Session }));
    const { db, events } = await autoRefreshingClient(f);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(calls.map((call) => call.url)).toEqual([`${authUrl}/token`]);

    const verifying = db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "123456" });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    refreshGate.resolve({ body: refreshedAal1 });
    await verifying;

    expect(calls[1]!.body).toEqual({ challengeId: "c-1", code: "123456", refreshToken: "rt-aal1-next" });
    expect(db.auth.currentSession()?.accessToken).toBe(aal2Token);
    expect(events).toEqual(["TOKEN_REFRESHED", "MFA_CHALLENGE_VERIFIED"]);
    db.auth.stopAutoRefresh();
  });

  it("holds a refresh that comes due during verify until the aal2 session is stored, then refreshes that one", async () => {
    const verifyGate = deferred<Answer>();
    const refreshedAal2 = { ...aal2Session, accessToken: accessToken({ aal: "aal2", amr: ["password", "totp"], n: 2 }), refreshToken: "rt-aal2-next" };
    const { fetch: f, calls } = server((call) => (call.url.endsWith("/token") ? { body: refreshedAal2 } : verifyGate.promise));
    const { db, events } = await autoRefreshingClient(f);

    const verifying = db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "123456" });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(calls.map((call) => call.url)).toEqual([`${authUrl}/factors/f-1/verify`]);
    verifyGate.resolve({ body: { ...aal2Session, expiresIn: 61 } });
    await verifying;
    await jest.advanceTimersByTimeAsync(1_000);

    expect(calls.map((call) => call.url)).toEqual([`${authUrl}/factors/f-1/verify`, `${authUrl}/token`]);
    expect(calls[1]!.body).toEqual({ grant_type: "refresh_token", refresh_token: "rt-aal2" });
    expect(db.auth.currentSession()?.refreshToken).toBe("rt-aal2-next");
    expect(events).toEqual(["MFA_CHALLENGE_VERIFIED", "TOKEN_REFRESHED"]);
    db.auth.stopAutoRefresh();
  });

  it("does not store the aal2 session when the user signed out meanwhile", async () => {
    const verifyGate = deferred<Answer>();
    const { fetch: f } = server((call) => (call.url.endsWith("/verify") ? verifyGate.promise : { status: 204 }));
    const { db } = await autoRefreshingClient(f);
    const verifying = db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "123456" });
    const outcome = verifying.catch((error: unknown) => error);
    await db.auth.signOut();
    verifyGate.resolve({ body: aal2Session });
    await expect(outcome).resolves.toMatchObject({ code: "session_changed" });
    expect(db.auth.currentSession()).toBeNull();
    db.auth.stopAutoRefresh();
  });

  it("retries once with the new refresh token when the presented one was rotated meanwhile", async () => {
    const firstVerify = deferred<Answer>();
    const fresh = { ...refreshedAal1, refreshToken: "rt-after-password" };
    let verifyCount = 0;
    const { fetch: f, calls } = server((call) => {
      if (call.url.endsWith("/user")) return { body: { user: { ...member }, session: fresh } };
      verifyCount += 1;
      return verifyCount === 1 ? firstVerify.promise : { body: aal2Session };
    });
    const { db } = await autoRefreshingClient(f);
    const verifying = db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "123456" });
    await jest.advanceTimersByTimeAsync(0);
    await db.auth.updateUser({ password: "new-secret", currentPassword: "old-secret" });
    firstVerify.resolve({ status: 401, body: { error: "invalid refresh token" } });
    await expect(verifying).resolves.toMatchObject({ session: { accessToken: aal2Token } });
    const verifies = calls.filter((call) => call.url.endsWith("/verify"));
    expect(verifies.map((call) => (call.body as { refreshToken: string }).refreshToken)).toEqual(["rt-aal1", "rt-after-password"]);
    db.auth.stopAutoRefresh();
  });

  it("does not retry a refused refresh token that nothing replaced", async () => {
    const { fetch: f, calls } = server(() => ({ status: 401, body: { error: "invalid refresh token" } }));
    const { db } = await autoRefreshingClient(f);
    await expect(db.auth.mfa.useRecoveryCode({ code: "x" })).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
    db.auth.stopAutoRefresh();
  });
});
