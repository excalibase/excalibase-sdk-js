/**
 * `db.storage.uploadFile(blob)` speaks the staged upload protocol:
 *   1. a mutation mints the URL for a declared `{ contentType, size }` and
 *      returns `{ url, storageId, uploadId }`;
 *   2. the blob is PUT with exactly that Content-Type and Content-Length
 *      (both are covered by the signature);
 *   3. a second mutation completes the upload by `{ storageId, uploadId }`.
 * Only a completed upload becomes an object, so the id is returned after step 3.
 */

import { describe, test, expect } from "@jest/globals";
import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody?: BodyInit | null;
}

function captureRoutes(
  routes: Record<string, { status?: number; body: unknown; bodyType?: string }>,
): {
  fetchImpl: typeof fetch;
  calls: () => CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const u = typeof url === "string" ? url : String(url);
    let parsedBody: unknown = null;
    if (init?.body != null) {
      if (typeof init.body === "string") {
        try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
      } else {
        // For non-string bodies (Blob / Uint8Array / ArrayBuffer) we record
        // a sentinel marker plus byteLength so tests can assert that the
        // raw bytes were sent without re-decoding.
        const b = init.body as unknown;
        if (b instanceof Uint8Array) parsedBody = { __bytes: b.byteLength };
        else if (b && typeof (b as Blob).size === "number") parsedBody = { __bytes: (b as Blob).size };
        else parsedBody = "__binary__";
      }
    }
    calls.push({
      url: u,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: parsedBody,
      rawBody: init?.body ?? null,
    });
    // Pick the matching route by `${method} ${url}` exact OR by prefix.
    for (const [key, resp] of Object.entries(routes)) {
      const [m, pat] = key.split(" ");
      if (m !== method) continue;
      if (pat === u || u.startsWith(pat)) {
        const body = resp.bodyType === "raw"
          ? (resp.body as string)
          : JSON.stringify(resp.body);
        return new Response(body, {
          status: resp.status ?? 200,
          headers: { "Content-Type": resp.bodyType === "raw" ? "text/plain" : "application/json" },
        });
      }
    }
    return new Response("no route", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const BASE = "http://localhost:10000";
const PUB_KEY = "esk_pub_test";

function makeClient(fetchImpl: typeof fetch) {
  return createClient({
    url: BASE,
    projectId: "default/p",
    publishableKey: PUB_KEY,
    storage: memoryStorageAdapter(),
    fetch: fetchImpl,
  });
}

const MINT = "http://localhost:10000/functions/v1/default/p/system.generateUploadUrl";
const COMPLETE = "http://localhost:10000/functions/v1/default/p/system.completeUpload";
const MINTED = { url: "https://r2.test/upload?sig=ABC", storageId: "kg2_minted", uploadId: "upl_1" };

function header(req: CapturedRequest, name: string): string | undefined {
  return req.headers[name] ?? req.headers[name.toLowerCase()];
}

function happyRoutes(overrides: Record<string, { status?: number; body: unknown; bodyType?: string }> = {}) {
  return captureRoutes({
    [`POST ${MINT}`]: { body: { data: MINTED } },
    [`PUT ${MINTED.url}`]: { body: "", bodyType: "raw" },
    [`POST ${COMPLETE}`]: { body: { data: MINTED.storageId } },
    ...overrides,
  });
}

describe("db.storage.uploadFile", () => {
  test("declares the type and size, PUTs with both headers, completes, returns storageId", async () => {
    const { fetchImpl, calls } = happyRoutes();
    const db = makeClient(fetchImpl);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

    const result = await db.storage.uploadFile(blob);

    expect(result).toEqual({ storageId: "kg2_minted" });
    const [mint, put, complete] = calls();
    expect(calls().length).toBe(3);
    expect(mint.url).toBe(MINT);
    expect(mint.body).toEqual({ args: { contentType: "image/png", size: 3 } });
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(MINTED.url);
    expect(header(put, "Content-Type")).toBe("image/png");
    expect(header(put, "Content-Length")).toBe("3");
    expect(put.body).toEqual({ __bytes: 3 });
    expect(complete.method).toBe("POST");
    expect(complete.url).toBe(COMPLETE);
    expect(complete.body).toEqual({ args: { storageId: "kg2_minted", uploadId: "upl_1" } });
  });

  test("declares application/octet-stream for an untyped blob and PUTs with the same type", async () => {
    const { fetchImpl, calls } = happyRoutes();
    const db = makeClient(fetchImpl);
    await db.storage.uploadFile(new Blob([new Uint8Array(8)]));
    const [mint, put] = calls();
    expect(mint.body).toEqual({ args: { contentType: "application/octet-stream", size: 8 } });
    expect(header(put, "Content-Type")).toBe("application/octet-stream");
    expect(header(put, "Content-Length")).toBe("8");
  });

  test("uses opts.ref and opts.completeRef for the two mutations", async () => {
    const { fetchImpl, calls } = captureRoutes({
      "POST http://localhost:10000/functions/v1/default/p/photos.signUpload": { body: { data: MINTED } },
      [`PUT ${MINTED.url}`]: { body: "", bodyType: "raw" },
      "POST http://localhost:10000/functions/v1/default/p/photos.attachUpload": { body: { data: null } },
    });
    const db = makeClient(fetchImpl);
    const result = await db.storage.uploadFile(new Blob(["hello"], { type: "text/plain" }), {
      ref: { moduleName: "photos", exportName: "signUpload" },
      completeRef: { moduleName: "photos", exportName: "attachUpload" },
    });
    expect(result).toEqual({ storageId: "kg2_minted" });
    expect(calls()[0].url).toBe("http://localhost:10000/functions/v1/default/p/photos.signUpload");
    expect(calls()[2].url).toBe("http://localhost:10000/functions/v1/default/p/photos.attachUpload");
  });

  test("throws when the mint mutation does not exist (404 from functions endpoint)", async () => {
    const { fetchImpl } = captureRoutes({
      [`POST ${MINT}`]: { status: 404, body: { error: "function not found" } },
    });
    const db = makeClient(fetchImpl);
    await expect(db.storage.uploadFile(new Blob(["x"], { type: "text/plain" }))).rejects.toThrow(/HTTP 404/);
  });

  test("throws FunctionsError when the mint mutation returns an error envelope", async () => {
    const { fetchImpl } = captureRoutes({ [`POST ${MINT}`]: { body: { error: "quota exceeded" } } });
    const db = makeClient(fetchImpl);
    await expect(db.storage.uploadFile(new Blob(["x"]))).rejects.toThrow(/quota exceeded/);
  });

  test.each([
    ["url", { storageId: "kg2_x", uploadId: "upl_1" }],
    ["storageId", { url: "https://r2.test/u", uploadId: "upl_1" }],
    ["uploadId", { url: "https://r2.test/u", storageId: "kg2_x" }],
  ])("throws before uploading when the mint result has no %s", async (missing, data) => {
    const { fetchImpl, calls } = captureRoutes({ [`POST ${MINT}`]: { body: { data } } });
    const db = makeClient(fetchImpl);
    await expect(db.storage.uploadFile(new Blob(["x"]))).rejects.toThrow(new RegExp(missing));
    expect(calls().length).toBe(1);
  });

  test("a PUT the object store refuses (declared size or type differs) fails clearly and is not completed", async () => {
    const { fetchImpl, calls } = happyRoutes({
      [`PUT ${MINTED.url}`]: { status: 403, body: "SignatureDoesNotMatch", bodyType: "raw" },
    });
    const db = makeClient(fetchImpl);
    await expect(db.storage.uploadFile(new Blob(["x"]))).rejects.toThrow(
      /upload refused \(HTTP 403\).*size and type/,
    );
    expect(calls().length).toBe(2);
  });

  test("throws when the PUT fails for another reason", async () => {
    const { fetchImpl } = happyRoutes({
      [`PUT ${MINTED.url}`]: { status: 500, body: "internal error", bodyType: "raw" },
    });
    const db = makeClient(fetchImpl);
    await expect(db.storage.uploadFile(new Blob(["x"]))).rejects.toThrow(/upload failed \(HTTP 500\)/);
  });

  test("does not return a storageId when completing the upload is refused", async () => {
    const { fetchImpl } = happyRoutes({
      [`POST ${COMPLETE}`]: { status: 413, body: { error: "project storage quota exceeded" } },
    });
    const db = makeClient(fetchImpl);
    await expect(db.storage.uploadFile(new Blob(["x"]))).rejects.toThrow(/system\.completeUpload returned HTTP 413/);
  });

  test("does not return a storageId when the completion mutation returns an error envelope", async () => {
    const { fetchImpl } = happyRoutes({
      [`POST ${COMPLETE}`]: { body: { error: "content type not allowed" } },
    });
    const db = makeClient(fetchImpl);
    await expect(db.storage.uploadFile(new Blob(["x"]))).rejects.toThrow(/content type not allowed/);
  });

  test("ignores a storageId in the PUT response: only the minted one is used", async () => {
    const { fetchImpl } = happyRoutes({
      [`PUT ${MINTED.url}`]: { body: { storageId: "kg2_fromPut" } },
    });
    const db = makeClient(fetchImpl);
    const { storageId } = await db.storage.uploadFile(new Blob(["x"]));
    expect(storageId).toBe("kg2_minted");
  });

  test("rejects on missing blob argument", async () => {
    const { fetchImpl } = captureRoutes({});
    const db = makeClient(fetchImpl);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.storage as any).uploadFile(undefined),
    ).rejects.toThrow(/blob/i);
  });
});
