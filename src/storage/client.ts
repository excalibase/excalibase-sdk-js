/**
 * `db.storage.uploadFile(blob)` — the staged direct upload, in one call:
 *
 *   1. A mutation (default `system.generateUploadUrl`) calls
 *      `ctx.storage.generateUploadUrl({ contentType, size })` and returns
 *      `{ url, storageId, uploadId }`.
 *   2. The blob is PUT to `url` with exactly that Content-Type and
 *      Content-Length; both are covered by the signature.
 *   3. A second mutation (default `system.completeUpload`) calls
 *      `ctx.storage.completeUpload({ storageId, uploadId })`. Until then the
 *      bytes are only staged, and the platform collects them after a grace
 *      period.
 */

import { FunctionsError } from "../functions/error";

export interface UploadMutationRef {
  readonly moduleName: string;
  readonly exportName: string;
}

export interface UploadFileOptions {
  /**
   * The mutation that mints the upload URL. Default `system.generateUploadUrl`.
   * It receives `{ contentType, size }` and must return
   * `{ url, storageId, uploadId }` from `ctx.storage.generateUploadUrl`.
   */
  ref?: UploadMutationRef;
  /**
   * The mutation that completes the upload. Default `system.completeUpload`.
   * It receives `{ storageId, uploadId }` and must call
   * `ctx.storage.completeUpload` with them.
   */
  completeRef?: UploadMutationRef;
}

export interface UploadFileResult {
  /** The id of the stored object; only returned once the upload is completed. */
  readonly storageId: string;
}

export interface FileStorageClientOptions {
  readonly url: string;
  readonly projectId: string;
  readonly fetchImpl: typeof fetch;
  readonly headersFactory: () => Record<string, string>;
}

interface MintedUpload {
  readonly url: string;
  readonly storageId: string;
  readonly uploadId: string;
}

const DEFAULT_MINT: UploadMutationRef = { moduleName: "system", exportName: "generateUploadUrl" };
const DEFAULT_COMPLETE: UploadMutationRef = { moduleName: "system", exportName: "completeUpload" };

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
   * Upload a Blob and return its `storageId` once the platform has accepted it.
   *
   * Throws `FunctionsError` when either mutation fails, and `Error` when the
   * object store refuses the PUT (HTTP 403 means the bytes did not match the
   * declared size or type).
   */
  async uploadFile(blob: Blob, opts: UploadFileOptions = {}): Promise<UploadFileResult> {
    if (!blob || typeof (blob as Blob).arrayBuffer !== "function") {
      throw new Error("db.storage.uploadFile: blob argument is required");
    }
    const contentType = blob.type || "application/octet-stream";
    const minted = parseMinted(
      await this.callMutation(opts.ref ?? DEFAULT_MINT, { contentType, size: blob.size }),
    );

    const put = await this.fetchImpl(minted.url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(blob.size),
      },
      body: blob,
    });
    if (put.status === 403) {
      throw new Error(
        "db.storage.uploadFile: upload refused (HTTP 403) — the bytes sent must match the declared size and type",
      );
    }
    if (!put.ok) {
      throw new Error(`db.storage.uploadFile: upload failed (HTTP ${put.status})`);
    }

    await this.callMutation(opts.completeRef ?? DEFAULT_COMPLETE, {
      storageId: minted.storageId,
      uploadId: minted.uploadId,
    });
    return { storageId: minted.storageId };
  }

  private async callMutation(ref: UploadMutationRef, args: Record<string, unknown>): Promise<unknown> {
    const name = `${ref.moduleName}.${ref.exportName}`;
    const resp = await this.fetchImpl(`${this.url}/functions/v1/${this.projectId}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headersFactory(),
      },
      body: JSON.stringify({ args }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new FunctionsError(
        `db.storage.uploadFile: ${name} returned HTTP ${resp.status}: ${text.slice(0, 200)}`,
      );
    }
    const json = (await resp.json()) as { data?: unknown; error?: string };
    if (json.error) {
      throw new FunctionsError(`db.storage.uploadFile: ${name}: ${json.error}`);
    }
    return json.data;
  }
}

function parseMinted(data: unknown): MintedUpload {
  const minted = (data ?? {}) as Partial<Record<keyof MintedUpload, unknown>>;
  for (const field of ["url", "storageId", "uploadId"] as const) {
    const value = minted[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`db.storage.uploadFile: the upload URL mutation did not return a ${field}`);
    }
  }
  return minted as MintedUpload;
}
