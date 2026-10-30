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

async function client(fetchImpl: typeof fetch, prepare: (storage: StorageAdapter) => void = signedIn) {
  const storage = memoryStorageAdapter();
  prepare(storage);
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
    const { db, storage, events } = await client(f);
    const result = await db.auth.mfa.verify({ factorId: "f-1", challengeId: "c-1", code: "123456" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/factors/f-1/verify`, authorization: `Bearer ${aal1Token}` });
    expect(calls[0]!.body).toEqual({ challengeId: "c-1", code: "123456", refreshToken: "rt-aal1" });
    expect(result.recoveryCodes).toEqual(codes);
    expect(result.session).toMatchObject({ accessToken: aal2Token, refreshToken: "rt-aal2", user: member });
    expect(db.auth.currentSession()).toEqual(result.session);
    expect(events).toEqual(["SIGNED_IN"]);
    await flush();
    expect(JSON.parse(storage.getItem(sessionKey) as string).refreshToken).toBe("rt-aal2");
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
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${authUrl}/factors/f-1`, authorization: `Bearer ${aal1Token}` });
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

  it("reads a missing list as empty", async () => {
    const { fetch: f } = server(() => ({ body: {} }));
    const { db } = await client(f);
    await expect(db.auth.mfa.listFactors()).resolves.toEqual({ all: [], totp: [], recoveryCodesRemaining: 0 });
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
    const session = await db.auth.mfa.useRecoveryCode({ code: "abcd-efgh" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/factors/recovery`, authorization: `Bearer ${aal1Token}` });
    expect(calls[0]!.body).toEqual({ code: "abcd-efgh", refreshToken: "rt-aal1" });
    expect(session.accessToken).toBe(recovered.accessToken);
    expect(db.auth.currentSession()).toEqual(session);
    expect(events).toEqual(["SIGNED_IN"]);
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
