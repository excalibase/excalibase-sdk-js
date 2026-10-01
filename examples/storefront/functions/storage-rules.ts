// The store's storage rules, enforced by its functions before they touch
// ctx.storage. Who may upload is decided by the caller's role, read from the
// token the platform verified (ctx.auth.claims is empty for anything else);
// who may see a picture is whoever may read the product that names it, since
// the storage id is only reachable through that row.
// No imports: the functions bundle it and the unit tests run it as is.

export const PRODUCT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_IDS = 100;
const STORAGE_ID = /^kg2_[0-9a-f]{26}$/;

export interface Claims {
  role?: unknown;
}

export function checkStaff(claims: Claims | null | undefined): void {
  if (claims?.role !== "staff") {
    throw new Error("only staff may upload product images");
  }
}

export function checkProductImageUpload(claims: Claims | null | undefined, contentType: string, size: number): void {
  checkStaff(claims);
  if (!PRODUCT_IMAGE_TYPES.includes(contentType)) {
    throw new Error("a product image is a png, jpeg, webp or gif file");
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("a product image is at most 5 MB");
  }
}

export function requestedImageIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new Error("storageIds must be a list");
  if (ids.length > MAX_IMAGE_IDS) throw new Error(`at most ${MAX_IMAGE_IDS} images at once`);
  for (const id of ids) {
    if (typeof id !== "string" || !STORAGE_ID.test(id)) throw new Error("not a storage id");
  }
  return [...new Set(ids as string[])];
}
