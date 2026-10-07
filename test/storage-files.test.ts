/**
 * `db.storage` against the project's own storage API (/storage/v1/{projectId}):
 * the bucket's access rule decides what the signed-in user may do, and the
 * bytes go straight to the object store through signed URLs.
 */

import { describe, test, expect } from "@jest/globals";
import { createClient, StorageError } from "../src";
import { memoryStorageAdapter } from "../src/storage";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = { status?: number; body?: unknown; raw?: string | Blob };

function routes(table: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body) body = { __bytes: (init.body as Blob).size };
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const hit = table[`${method} ${url}`];
    if (!hit) return new Response("no route", { status: 404 });
    if (hit.raw !== undefined) return new Response(hit.raw, { status: hit.status ?? 200 });
    return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = "http://localhost:10000";
const API = `${BASE}/storage/v1/p/buckets/avatars`;
const SIGNED_PUT = "https://files.test/projects/p/buckets/b1/.staging/upl_1?sig=1";
const SIGNED_GET = "https://files.test/projects/p/buckets/b1/7/me.png?sig=2";

function client(fetchImpl: typeof fetch) {
  return createClient({ url: BASE, projectId: "p", key: "esk_pub_test", storage: memoryStorageAdapter(), fetch: fetchImpl });
}

function header(call: Call, name: string): string | undefined {
  const found = Object.entries(call.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

const uploadRoutes = (overrides: Record<string, Route> = {}) =>
  routes({
    [`POST ${API}/upload-url`]: { body: { uploadId: "upl_1", url: SIGNED_PUT, method: "PUT", headers: {} } },
    [`PUT ${SIGNED_PUT}`]: { raw: "" },
    [`POST ${API}/confirm-upload`]: {
      status: 201,
      body: { key: "7/me.png", size: 3, mimeType: "image/png", etag: "e1", createdAt: "t", updatedAt: "t" },
    },
    ...overrides,
  });

describe("db.storage.uploadFile", () => {
  test("mints for the declared type and size, PUTs the bytes, confirms, returns the stored file", async () => {
    const { fetchImpl, calls } = uploadRoutes();
    const db = client(fetchImpl);
    const file = await db.storage.uploadFile(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), {
      bucket: "avatars",
      path: "7/me.png",
    });
    expect(file).toEqual({ bucket: "avatars", path: "7/me.png", size: 3, mimeType: "image/png", etag: "e1" });
    const [mint, put, confirm] = calls;
    expect(mint.body).toEqual({ key: "7/me.png", mimeType: "image/png", size: 3 });
    expect(header(mint, "X-Excalibase-Publishable-Key")).toBe("esk_pub_test");
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(SIGNED_PUT);
    expect(header(put, "Content-Type")).toBe("image/png");
    expect(header(put, "Authorization")).toBeUndefined();
    expect(put.body).toEqual({ __bytes: 3 });
    expect(confirm.body).toEqual({ key: "7/me.png", uploadId: "upl_1" });
  });

  test("an untyped blob is declared and sent as application/octet-stream", async () => {
    const { fetchImpl, calls } = uploadRoutes();
    await client(fetchImpl).storage.uploadFile(new Blob([new Uint8Array(3)]), { bucket: "avatars", path: "7/me.png" });
    expect(calls[0].body).toEqual({ key: "7/me.png", mimeType: "application/octet-stream", size: 3 });
    expect(header(calls[1], "Content-Type")).toBe("application/octet-stream");
  });

  test("a refused mint is a StorageError carrying the status and the server's reason", async () => {
    const { fetchImpl, calls } = uploadRoutes({ [`POST ${API}/upload-url`]: { status: 403, body: { error: "not allowed" } } });
    const err = await client(fetchImpl)
      .storage.uploadFile(new Blob(["x"]), { bucket: "avatars", path: "8/x.txt" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).status).toBe(403);
    expect((err as StorageError).message).toMatch(/not allowed/);
    expect(calls.length).toBe(1);
  });

  test("a PUT the object store refuses is not confirmed", async () => {
    const { fetchImpl, calls } = uploadRoutes({ [`PUT ${SIGNED_PUT}`]: { status: 403, raw: "SignatureDoesNotMatch" } });
    await expect(
      client(fetchImpl).storage.uploadFile(new Blob(["x"]), { bucket: "avatars", path: "7/x.txt" }),
    ).rejects.toThrow(/object store refused the upload \(HTTP 403\)/);
    expect(calls.length).toBe(2);
  });

  test("a refused confirm fails the upload", async () => {
    const { fetchImpl } = uploadRoutes({
      [`POST ${API}/confirm-upload`]: { status: 400, body: { error: "project storage quota exceeded" } },
    });
    await expect(
      client(fetchImpl).storage.uploadFile(new Blob(["x"]), { bucket: "avatars", path: "7/x.txt" }),
    ).rejects.toThrow(/quota exceeded/);
  });

  test.each([
    ["no blob", undefined, { bucket: "avatars", path: "7/a" }, /blob/],
    ["no bucket", new Blob(["x"]), { bucket: "", path: "7/a" }, /bucket/],
    ["no path", new Blob(["x"]), { bucket: "avatars", path: "" }, /path/],
  ])("refuses %s before any request", async (_name, blob, opts, message) => {
    const { fetchImpl, calls } = uploadRoutes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(client(fetchImpl).storage.uploadFile(blob as any, opts)).rejects.toThrow(message);
    expect(calls.length).toBe(0);
  });

  test("path segments are escaped in the URL, never the slashes between them", async () => {
    const { fetchImpl, calls } = routes({
      [`GET ${API}/download-url/7/my%20photo%3F.png`]: { body: { url: SIGNED_GET, public: false } },
    });
    await client(fetchImpl).storage.getDownloadUrl("avatars", "7/my photo?.png");
    expect(calls[0].url).toBe(`${API}/download-url/7/my%20photo%3F.png`);
  });
});

describe("db.storage reads and deletes", () => {
  test("getDownloadUrl returns the signed URL", async () => {
    const { fetchImpl } = routes({
      [`GET ${API}/download-url/7/me.png`]: { body: { url: SIGNED_GET, expiresAt: "2026-10-07T00:00:00Z", public: false } },
    });
    const signed = await client(fetchImpl).storage.getDownloadUrl("avatars", "7/me.png");
    expect(signed).toEqual({ url: SIGNED_GET, expiresAt: "2026-10-07T00:00:00Z", public: false });
  });

  test("download fetches the bytes from the signed URL without the app's credentials", async () => {
    const { fetchImpl, calls } = routes({
      [`GET ${API}/download-url/7/me.png`]: { body: { url: SIGNED_GET, public: false } },
      [`GET ${SIGNED_GET}`]: { raw: "png-bytes" },
    });
    const blob = await client(fetchImpl).storage.download("avatars", "7/me.png");
    expect(await blob.text()).toBe("png-bytes");
    expect(header(calls[1], "Authorization")).toBeUndefined();
  });

  test("a download the object store refuses throws", async () => {
    const { fetchImpl } = routes({
      [`GET ${API}/download-url/7/gone.png`]: { body: { url: SIGNED_GET, public: false } },
      [`GET ${SIGNED_GET}`]: { status: 404, raw: "NoSuchKey" },
    });
    await expect(client(fetchImpl).storage.download("avatars", "7/gone.png")).rejects.toThrow(/HTTP 404/);
  });

  test("list passes prefix, limit and cursor and returns the page", async () => {
    const page = { objects: [{ key: "7/me.png", size: 3, mimeType: "image/png", createdAt: "t", updatedAt: "t" }], nextCursor: "c2" };
    const { fetchImpl, calls } = routes({ [`GET ${API}/objects?prefix=7%2F&limit=10&cursor=c1`]: { body: page } });
    const got = await client(fetchImpl).storage.list("avatars", { prefix: "7/", limit: 10, cursor: "c1" });
    expect(got).toEqual(page);
    expect(calls[0].method).toBe("GET");
  });

  test("list with no options asks for the default page", async () => {
    const { fetchImpl, calls } = routes({ [`GET ${API}/objects`]: { body: { objects: [] } } });
    expect(await client(fetchImpl).storage.list("avatars")).toEqual({ objects: [] });
    expect(calls[0].url).toBe(`${API}/objects`);
  });

  test("remove deletes the object", async () => {
    const { fetchImpl, calls } = routes({ [`DELETE ${API}/objects/7/me.png`]: { status: 204 } });
    await client(fetchImpl).storage.remove("avatars", "7/me.png");
    expect(calls[0].method).toBe("DELETE");
  });

  test("a refusal without a JSON body still reports the status", async () => {
    const { fetchImpl } = routes({ [`DELETE ${API}/objects/8/x.png`]: { status: 502, raw: "bad gateway" } });
    await expect(client(fetchImpl).storage.remove("avatars", "8/x.png")).rejects.toThrow(/HTTP 502/);
  });

  test("the signed-in user's access token rides every API call", async () => {
    const { fetchImpl, calls } = routes({
      [`POST ${BASE}/auth/p/p/token`]: {
        body: { accessToken: "user-token", refreshToken: "r", tokenType: "Bearer", expiresIn: 3600, user: { id: 7, email: "a@b.c", fullName: "A" } },
      },
      [`GET ${API}/objects`]: { body: { objects: [] } },
    });
    const db = createClient({
      url: BASE, projectId: "p", key: "esk_pub_test", storage: memoryStorageAdapter(), fetch: fetchImpl, autoRefreshToken: false,
    });
    await db.auth.signInWithPassword({ email: "a@b.c", password: "pw" });
    await db.storage.list("avatars");
    expect(header(calls[1], "Authorization")).toBe("Bearer user-token");
  });
});
