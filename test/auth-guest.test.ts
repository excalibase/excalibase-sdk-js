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
const guestUser = { id: 9, email: "", fullName: "", isGuest: true };
const guestSession = { accessToken: "jwt-guest", refreshToken: "rt-guest", tokenType: "Bearer", expiresIn: 3600, user: guestUser };
const refreshed = { ...guestSession, accessToken: "jwt-guest-fresh", refreshToken: "rt-guest-2" };

function signedInAsGuest(storage: StorageAdapter): void {
  storage.setItem(
    sessionKey,
    JSON.stringify({ accessToken: "jwt-guest", refreshToken: "rt-guest", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, user: guestUser }),
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

async function client(fetchImpl: typeof fetch, storage = memoryStorageAdapter(), guest = true) {
  if (guest) signedInAsGuest(storage);
  const db = createClient({ ...baseOpts, storage, fetch: fetchImpl });
  await db.auth.hydrate();
  const events: AuthChangeEvent[] = [];
  const errors: unknown[] = [];
  db.auth.onAuthStateChange((event, _session, error) => {
    events.push(event);
    if (error !== undefined) errors.push(error);
  });
  await Promise.resolve();
  events.length = 0;
  return { db, storage, events, errors };
}

describe("AuthClient.signInAsGuest", () => {
  it("starts a guest session with no body fields unless a captcha token is given", async () => {
    const { fetch: f, calls } = server(() => ({ body: guestSession }));
    const { db, events } = await client(f, memoryStorageAdapter(), false);
    const session = await db.auth.signInAsGuest();
    expect(calls[0]).toMatchObject({ method: "POST", url: `${authUrl}/guest` });
    expect(calls[0]!.body).toEqual({});
    expect(session.user).toEqual(guestUser);
    expect(db.auth.user()?.isGuest).toBe(true);
    expect(events).toEqual(["SIGNED_IN"]);

    await db.auth.signInAsGuest({ captchaToken: "turnstile-token" });
    expect(calls[1]!.body).toEqual({ captchaToken: "turnstile-token" });
  });

  it("names the server's refusal", async () => {
    const { fetch: f } = server(() => ({ status: 404, body: { error: "method_not_enabled" } }));
    const { db } = await client(f, memoryStorageAdapter(), false);
    await expect(db.auth.signInAsGuest()).rejects.toMatchObject({ code: "method_not_enabled", status: 404 });
    expect(db.auth.currentSession()).toBeNull();
  });
});

describe("a guest upgrading its account", () => {
  it("refreshes before asking for an address, so the token counts as a recent sign-in", async () => {
    const { fetch: f, calls } = server((call) =>
      call.url.endsWith("/token") ? { body: refreshed } : { body: { user: { ...guestUser, emailVerified: false }, emailChangeRequested: true } },
    );
    const { db } = await client(f);
    await db.auth.updateUser({ email: "new@app.test" });
    expect(calls.map((call) => call.url)).toEqual([`${authUrl}/token`, `${authUrl}/user`]);
    expect(calls[0]!.body).toEqual({ grant_type: "refresh_token", refresh_token: "rt-guest" });
    expect(calls[1]!.authorization).toBe("Bearer jwt-guest-fresh");
    expect(db.auth.user()?.isGuest).toBe(true);
  });

  it("refreshes before linking a provider or an address", async () => {
    const { fetch: f, calls } = server((call) => {
      if (call.url.endsWith("/token")) return { body: refreshed };
      if (call.url.endsWith("/user/identities/authorize")) return { body: { linkTicket: "ticket", expiresIn: 120 } };
      return { body: {} };
    });
    const { db } = await client(f);
    await db.auth.linkIdentity({ provider: "github", redirectTo: "https://app.test/cb", skipBrowserRedirect: true });
    expect(calls[0]!.url).toBe(`${authUrl}/token`);
    expect(calls[1]).toMatchObject({ url: `${authUrl}/user/identities/authorize`, authorization: "Bearer jwt-guest-fresh" });
  });

  it("does not refresh for a name change or for an account that is not a guest", async () => {
    const { fetch: f, calls } = server(() => ({ body: { user: { ...guestUser, fullName: "G" } } }));
    const { db } = await client(f);
    await db.auth.updateUser({ fullName: "G" });
    expect(calls.map((call) => call.url)).toEqual([`${authUrl}/user`]);
  });

  it("stops when the refresh is refused and sends nothing else", async () => {
    const { fetch: f, calls } = server(() => ({ status: 403, body: { error: "method_not_enabled" } }));
    const { db } = await client(f);
    await expect(db.auth.updateUser({ email: "new@app.test" })).rejects.toMatchObject({ code: "method_not_enabled" });
    expect(calls).toHaveLength(1);
  });
});
