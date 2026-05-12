/**
 * Phase 10 — `db.storage.uploadFile(blob)` Convex-shape client flow.
 *
 * Convex pattern (mirrored here):
 *   1. Client invokes a developer-authored mutation that returns the
 *      signed PUT URL minted by `ctx.storage.generateUploadUrl()`.
 *   2. Client PUTs the blob bytes directly to that signed URL (no
 *      function-runtime bandwidth consumed).
 *   3. The signed-URL endpoint responds with the storageId.
 *
 * The SDK helper wraps steps 1 + 2 + 3:
 *
 *   const { storageId } = await db.storage.uploadFile(blob);
 *
 * It calls a conventionally-named mutation (`api.system.generateUploadUrl`
 * by default; overridable via opts.ref) to mint the URL, PUTs the blob,
 * and returns the parsed response.
 *
 * These tests assert the full pipeline against captured fetch mocks.
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

describe("db.storage.uploadFile (Phase 10)", () => {
  test("posts to the generateUploadUrl mutation, then PUTs the blob, returns storageId", async () => {
    const { fetchImpl, calls } = captureRoutes({
      // Mutation that mints the upload URL.
      "POST http://localhost:10000/functions/v1/default/p/system.generateUploadUrl": {
        body: { data: { url: "https://r2.test/upload?sig=ABC", storageId: "kg2_minted" } },
      },
      // R2 PUT — returns 200 with no body.
      "PUT https://r2.test/upload?sig=ABC": {
        body: "",
        bodyType: "raw",
      },
    });
    const db = makeClient(fetchImpl);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const result = await db.storage.uploadFile(blob);
    expect(result).toEqual({ storageId: "kg2_minted" });

    const recorded = calls();
    expect(recorded.length).toBe(2);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("http://localhost:10000/functions/v1/default/p/system.generateUploadUrl");
    expect(recorded[1].method).toBe("PUT");
    expect(recorded[1].url).toBe("https://r2.test/upload?sig=ABC");
    expect(recorded[1].headers["Content-Type"] || recorded[1].headers["content-type"]).toBe("image/png");
    // The blob bytes were sent (3 bytes).
    expect(recorded[1].body).toEqual({ __bytes: 3 });
  });

  test("supports overriding the mutation ref via opts.ref", async () => {
    const { fetchImpl, calls } = captureRoutes({
      "POST http://localhost:10000/functions/v1/default/p/photos.signUpload": {
        body: { data: { url: "https://r2.test/upload?sig=XYZ", storageId: "kg2_x" } },
      },
      "PUT https://r2.test/upload?sig=XYZ": {
        body: "",
        bodyType: "raw",
      },
    });
    const db = makeClient(fetchImpl);
    const blob = new Blob(["hello"], { type: "text/plain" });
    const result = await db.storage.uploadFile(blob, { ref: { moduleName: "photos", exportName: "signUpload" } });
    expect(result).toEqual({ storageId: "kg2_x" });
    const recorded = calls();
    expect(recorded[0].url).toBe("http://localhost:10000/functions/v1/default/p/photos.signUpload");
  });

  test("throws when the mutation does not exist (404 from functions endpoint)", async () => {
    const { fetchImpl } = captureRoutes({
      "POST http://localhost:10000/functions/v1/default/p/system.generateUploadUrl": {
        status: 404,
        body: { error: "function not found" },
      },
    });
    const db = makeClient(fetchImpl);
    const blob = new Blob(["x"], { type: "text/plain" });
    await expect(db.storage.uploadFile(blob)).rejects.toThrow();
  });

  test("throws when the PUT to the signed URL fails", async () => {
    const { fetchImpl } = captureRoutes({
      "POST http://localhost:10000/functions/v1/default/p/system.generateUploadUrl": {
        body: { data: { url: "https://r2.test/upload?sig=BAD", storageId: "kg2_x" } },
      },
      "PUT https://r2.test/upload?sig=BAD": {
        status: 500,
        body: "internal error",
        bodyType: "raw",
      },
    });
    const db = makeClient(fetchImpl);
    const blob = new Blob(["x"], { type: "text/plain" });
    await expect(db.storage.uploadFile(blob)).rejects.toThrow(/upload failed/i);
  });

  test("throws when the mutation response is missing the url field", async () => {
    const { fetchImpl } = captureRoutes({
      "POST http://localhost:10000/functions/v1/default/p/system.generateUploadUrl": {
        body: { data: { storageId: "kg2_x" } }, // no url
      },
    });
    const db = makeClient(fetchImpl);
    const blob = new Blob(["x"], { type: "text/plain" });
    await expect(db.storage.uploadFile(blob)).rejects.toThrow(/url/i);
  });

  test("rejects on missing blob argument", async () => {
    const { fetchImpl } = captureRoutes({});
    const db = makeClient(fetchImpl);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.storage as any).uploadFile(undefined),
    ).rejects.toThrow(/blob/i);
  });

  test("falls back to storageId from the response body when the PUT response doesn't carry one", async () => {
    // R2 PUTs typically don't echo storageId in the response; the SDK
    // must source it from the original mutation response (Convex parity).
    const { fetchImpl } = captureRoutes({
      "POST http://localhost:10000/functions/v1/default/p/system.generateUploadUrl": {
        body: { data: { url: "https://r2.test/u?s=1", storageId: "kg2_fromMutation" } },
      },
      "PUT https://r2.test/u?s=1": {
        body: "",
        bodyType: "raw",
      },
    });
    const db = makeClient(fetchImpl);
    const blob = new Blob([new Uint8Array(8)], { type: "application/octet-stream" });
    const { storageId } = await db.storage.uploadFile(blob);
    expect(storageId).toBe("kg2_fromMutation");
  });
});
