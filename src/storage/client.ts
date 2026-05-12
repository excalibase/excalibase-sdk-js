/**
 * Phase 10 — `db.storage.uploadFile(blob)` Convex-shape client helper.
 *
 * Convex direct-upload pattern (mirrored here):
 *
 *   1. Client invokes a developer-authored mutation that returns a
 *      signed PUT URL minted by `ctx.storage.generateUploadUrl()`.
 *      The mutation also returns the freshly-minted `storageId`.
 *   2. Client PUTs the blob bytes directly to that signed URL — no
 *      function-runtime bandwidth consumed.
 *   3. Client persists the `storageId` (typically by passing it to
 *      another mutation that writes it onto a row).
 *
 * The SDK helper wraps steps 1 + 2 + 3 in a single call:
 *
 *   const { storageId } = await db.storage.uploadFile(blob);
 *
 * By convention the helper calls `api.system.generateUploadUrl`. Pass
 * `opts.ref` to point at a different mutation (e.g. `photos.signUpload`).
 *
 * No coupling to a specific function namespace shape — the helper only
 * needs (a) the project URL/id pair to build the `/functions/v1/...` URL
 * and (b) a bound fetch.
 */

import { FunctionsError } from "../functions/error";

export interface UploadFileOptions {
  /**
   * Override the mutation that mints the signed URL. Default:
   * `{ moduleName: "system", exportName: "generateUploadUrl" }`.
   *
   * The mutation must return `{ url: string; storageId?: string }`. When
   * `storageId` is omitted the SDK falls back to the value carried in the
   * PUT response body (S3-compatible stores rarely echo it; provisioning's
   * mint route always sets it).
   */
  ref?: { readonly moduleName: string; readonly exportName: string };
}

export interface UploadFileResult {
  readonly storageId: string;
}

export interface FileStorageClientOptions {
  readonly url: string;
  readonly projectId: string;
  readonly fetchImpl: typeof fetch;
  readonly headersFactory: () => Record<string, string>;
}

/**
 * Public surface exposed at `db.storage`. The only method today is
 * `uploadFile`; `getUrl` / `getMetadata` / etc are reached server-side
 * via `ctx.storage` and projected to the client through ordinary query
 * results.
 */
export class FileStorageClient {
  private readonly url: string;
  private readonly projectId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headersFactory: () => Record<string, string>;

  constructor(opts: FileStorageClientOptions) {
    this.url = opts.url;
    this.projectId = opts.projectId;
    this.fetchImpl = opts.fetchImpl;
    this.headersFactory = opts.headersFactory;
  }

  /**
   * Upload a Blob via the Convex direct-upload pattern.
   *
   * Throws `FunctionsError` when the upload-URL mutation rejects, and
   * `Error("upload failed: HTTP <status>")` when the PUT to the signed
   * URL fails. Returns `{ storageId }` on success.
   */
  async uploadFile(blob: Blob, opts: UploadFileOptions = {}): Promise<UploadFileResult> {
    if (!blob || typeof (blob as Blob).arrayBuffer !== "function") {
      throw new Error("db.storage.uploadFile: blob argument is required");
    }
    const ref = opts.ref ?? { moduleName: "system", exportName: "generateUploadUrl" };

    // 1. Mint the signed URL via the developer-authored mutation.
    const mutationUrl = `${this.url}/functions/v1/${this.projectId}/${ref.moduleName}.${ref.exportName}`;
    const mintResp = await this.fetchImpl(mutationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headersFactory(),
      },
      body: JSON.stringify({ args: {} }),
    });
    if (!mintResp.ok) {
      const text = await mintResp.text();
      throw new FunctionsError(
        `db.storage.uploadFile: ${ref.moduleName}.${ref.exportName} returned HTTP ${mintResp.status}: ${text.slice(0, 200)}`,
      );
    }
    const mintJson = (await mintResp.json()) as { data?: { url?: string; storageId?: string }; error?: string };
    if (mintJson.error) {
      throw new FunctionsError(`db.storage.uploadFile: ${mintJson.error}`);
    }
    const data = mintJson.data ?? {};
    if (typeof data.url !== "string" || data.url.length === 0) {
      throw new Error("db.storage.uploadFile: mutation did not return a url");
    }

    // 2. PUT the bytes directly to the signed URL.
    const put = await this.fetchImpl(data.url, {
      method: "PUT",
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
      },
      body: blob,
    });
    if (!put.ok) {
      throw new Error(`db.storage.uploadFile: upload failed (HTTP ${put.status})`);
    }

    // 3. Read the storageId. Prefer the upload response body (some
    //    backends echo it); fall back to the mutation response.
    let storageId = data.storageId ?? "";
    if (storageId === "") {
      try {
        const putText = await put.text();
        if (putText && putText.length > 0) {
          const parsed = JSON.parse(putText) as { storageId?: string };
          if (typeof parsed.storageId === "string") storageId = parsed.storageId;
        }
      } catch (_) {
        // PUT response wasn't JSON — that's fine; we already have the
        // storageId from the mutation response (or we don't, which is a
        // configuration error caught below).
      }
    }
    if (storageId === "") {
      throw new Error("db.storage.uploadFile: neither the mutation nor the upload response carried a storageId");
    }
    return { storageId };
  }
}
