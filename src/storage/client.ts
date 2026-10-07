/**
 * `db.storage` — files in the project's buckets.
 *
 * The bucket methods call the project's storage API at
 * `{url}/storage/v1/{projectId}/buckets/{bucket}/...` as the signed-in user;
 * the bucket's access rule (set in Studio) decides what that user may do. The
 * bytes travel straight between the browser and the object store on signed
 * URLs. An upload is three steps, run by `uploadFile`:
 *
 *   1. mint a URL for the declared type and size (both are signed);
 *   2. PUT the blob with exactly that type and size;
 *   3. confirm, which records the file. Unconfirmed bytes are collected.
 *
 * `uploadViaFunctions` is the same staged upload through the project's own
 * mutations (`ctx.storage.generateUploadUrl` / `completeUpload`), for apps
 * whose upload rule is code.
 */

import { ExcalibaseError } from "../errors";
import { FunctionsError } from "../functions/error";

export class StorageError extends ExcalibaseError {
  constructor(message: string, status: number | null = null, cause?: unknown) {
    super(message, "storage_error", status, cause);
    this.name = "StorageError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface UploadFileOptions {
  /** The bucket, as named in Studio. */
  bucket: string;
  /** The object's path in the bucket, e.g. `${user.id}/avatar.png`. */
  path: string;
}

/** A file the platform has recorded. */
export interface StoredFile {
  readonly bucket: string;
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
  readonly etag?: string;
}

export interface DownloadUrl {
  readonly url: string;
  /** When a private file's URL stops working; absent for a public bucket. */
  readonly expiresAt?: string;
  readonly public: boolean;
}

export interface ListOptions {
  /** Only paths starting with this. A user whose rule is "own" lists their own folder. */
  prefix?: string;
  /** Page size, 1-1000 (default 100). */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
}

export interface ListedFile {
  readonly key: string;
  readonly size: number;
  readonly mimeType: string;
  readonly etag?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListPage {
  readonly objects: ListedFile[];
  readonly nextCursor?: string;
}

export interface UploadMutationRef {
  readonly moduleName: string;
  readonly exportName: string;
}

export interface UploadViaFunctionsOptions {
  /** The mutation that mints the URL. Default `system.generateUploadUrl`. */
  ref?: UploadMutationRef;
  /** The mutation that completes the upload. Default `system.completeUpload`. */
  completeRef?: UploadMutationRef;
}

export interface UploadViaFunctionsResult {
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
  readonly uploadId: string;
}

const DEFAULT_MINT: UploadMutationRef = { moduleName: "system", exportName: "generateUploadUrl" };
const DEFAULT_COMPLETE: UploadMutationRef = { moduleName: "system", exportName: "completeUpload" };
const OCTET_STREAM = "application/octet-stream";

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
   * Upload a Blob to `bucket` at `path` and return it once the platform has
   * recorded it. Throws `StorageError` when the API refuses (403: the
   * bucket's rule does not let this user write there).
   */
  async uploadFile(blob: Blob, opts: UploadFileOptions): Promise<StoredFile> {
    requireBlob(blob, "uploadFile");
    const { bucket, path } = requireLocation(opts?.bucket, opts?.path, "uploadFile");
    const mimeType = blob.type || OCTET_STREAM;
    const minted = await this.api<MintedUpload>("POST", bucket, "/upload-url", {
      key: path,
      mimeType,
      size: blob.size,
    });
    await this.putBytes(minted.url, blob, mimeType);
    const recorded = await this.api<ListedFile>("POST", bucket, "/confirm-upload", {
      key: path,
      uploadId: minted.uploadId,
    });
    return {
      bucket,
      path: recorded.key,
      size: recorded.size,
      mimeType: recorded.mimeType,
      ...(recorded.etag ? { etag: recorded.etag } : {}),
    };
  }

  /** A short-lived URL for a private file, or the lasting one of a public bucket. */
  async getDownloadUrl(bucket: string, path: string): Promise<DownloadUrl> {
    const location = requireLocation(bucket, path, "getDownloadUrl");
    return this.api<DownloadUrl>("GET", location.bucket, `/download-url/${encodePath(location.path)}`);
  }

  /** The file's bytes, fetched from the object store on a signed URL. */
  async download(bucket: string, path: string): Promise<Blob> {
    const signed = await this.getDownloadUrl(bucket, path);
    const resp = await this.fetchImpl(signed.url, { method: "GET" });
    if (!resp.ok) {
      throw new StorageError(`db.storage.download: the object store answered HTTP ${resp.status}`, resp.status);
    }
    return resp.blob();
  }

  /** One page of the files this user may list in the bucket. */
  async list(bucket: string, opts: ListOptions = {}): Promise<ListPage> {
    if (typeof bucket !== "string" || bucket.length === 0) {
      throw new StorageError("db.storage.list: bucket is required");
    }
    const query = new URLSearchParams();
    if (opts.prefix) query.set("prefix", opts.prefix);
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.cursor) query.set("cursor", opts.cursor);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.api<ListPage>("GET", bucket, `/objects${suffix}`);
  }

  /** Delete a file. */
  async remove(bucket: string, path: string): Promise<void> {
    const location = requireLocation(bucket, path, "remove");
    await this.api<null>("DELETE", location.bucket, `/objects/${encodePath(location.path)}`);
  }

  /**
   * The staged upload through the project's own mutations: `ref` returns
   * `ctx.storage.generateUploadUrl({ contentType, size })`, `completeRef`
   * calls `ctx.storage.completeUpload`. Returns the storageId once completed.
   */
  async uploadViaFunctions(blob: Blob, opts: UploadViaFunctionsOptions = {}): Promise<UploadViaFunctionsResult> {
    requireBlob(blob, "uploadViaFunctions");
    const contentType = blob.type || OCTET_STREAM;
    const minted = parseMinted(
      await this.callMutation(opts.ref ?? DEFAULT_MINT, { contentType, size: blob.size }),
    );
    await this.putBytes(minted.url, blob, contentType);
    await this.callMutation(opts.completeRef ?? DEFAULT_COMPLETE, {
      storageId: minted.storageId,
      uploadId: minted.uploadId,
    });
    return { storageId: minted.storageId };
  }

  // The signature covers the type and size, so both are sent exactly as
  // declared; the browser derives Content-Length from the Blob itself.
  private async putBytes(url: string, blob: Blob, contentType: string): Promise<void> {
    const put = await this.fetchImpl(url, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(blob.size) },
      body: blob,
    });
    if (!put.ok) {
      throw new StorageError(
        `db.storage: the object store refused the upload (HTTP ${put.status}); the bytes must match the declared size and type`,
        put.status,
      );
    }
  }

  private async api<T>(method: string, bucket: string, subpath: string, body?: unknown): Promise<T> {
    const url = `${this.url}/storage/v1/${encodeURIComponent(this.projectId)}/buckets/${encodeURIComponent(bucket)}${subpath}`;
    const headers: Record<string, string> = { ...this.headersFactory() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const resp = await this.fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new StorageError(`db.storage: ${method} ${subpath.split("?")[0]} answered HTTP ${resp.status}: ${reason(text)}`, resp.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private async callMutation(ref: UploadMutationRef, args: Record<string, unknown>): Promise<unknown> {
    const name = `${ref.moduleName}.${ref.exportName}`;
    const resp = await this.fetchImpl(`${this.url}/functions/v1/${this.projectId}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headersFactory() },
      body: JSON.stringify({ args }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new FunctionsError(`db.storage.uploadViaFunctions: ${name} returned HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = (await resp.json()) as { data?: unknown; error?: string };
    if (json.error) {
      throw new FunctionsError(`db.storage.uploadViaFunctions: ${name}: ${json.error}`);
    }
    return json.data;
  }
}

function requireBlob(blob: Blob, method: string): void {
  if (!blob || typeof (blob as Blob).arrayBuffer !== "function") {
    throw new StorageError(`db.storage.${method}: blob argument is required`);
  }
}

function requireLocation(bucket: unknown, path: unknown, method: string): { bucket: string; path: string } {
  if (typeof bucket !== "string" || bucket.length === 0) {
    throw new StorageError(`db.storage.${method}: bucket is required`);
  }
  if (typeof path !== "string" || path.length === 0) {
    throw new StorageError(`db.storage.${method}: path is required`);
  }
  return { bucket, path };
}

// Each segment is escaped; the slashes between them stay path separators.
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function reason(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON: the raw text below is the reason
  }
  return text.slice(0, 200);
}

function parseMinted(data: unknown): MintedUpload & { storageId: string } {
  const minted = (data ?? {}) as Record<string, unknown>;
  for (const field of ["url", "storageId", "uploadId"]) {
    const value = minted[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new StorageError(`db.storage.uploadViaFunctions: the upload URL mutation did not return a ${field}`);
    }
  }
  return minted as unknown as MintedUpload & { storageId: string };
}
