// The store's storage rules, enforced by its functions before they touch
// ctx.storage. Who may upload is decided by the caller's role, read from the
// token the platform verified (ctx.auth.claims is empty for anything else);
// who may see a picture is whoever may read the product that names it, since
// the storage id is only reachable through that row.
// A rule returns the refusal (status and message) and the function throws it
// as a FunctionError. No imports: the functions bundle it and the unit tests
// run it as is.

export const PRODUCT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_IDS = 100;
const STORAGE_ID = /^kg2_[0-9a-f]{26}$/;

export interface Claims {
  role?: unknown;
}

export interface Refusal {
  status: 400 | 401 | 403;
  message: string;
}

export function staffRefusal(claims: Claims | null | undefined): Refusal | undefined {
  if (!claims) return { status: 401, message: "sign in to upload product images" };
  if (claims.role !== "staff") return { status: 403, message: "only staff may upload product images" };
  return undefined;
}

export function productImageRefusal(claims: Claims | null | undefined, contentType: string, size: number): Refusal | undefined {
  const notStaff = staffRefusal(claims);
  if (notStaff) return notStaff;
  if (!PRODUCT_IMAGE_TYPES.includes(contentType)) {
    return { status: 400, message: "a product image is a png, jpeg, webp or gif file" };
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_PRODUCT_IMAGE_BYTES) {
    return { status: 400, message: "a product image is at most 5 MB" };
  }
  return undefined;
}

export function imageIdsRefusal(ids: unknown): Refusal | undefined {
  if (!Array.isArray(ids)) return { status: 400, message: "storageIds must be a list" };
  if (ids.length > MAX_IMAGE_IDS) return { status: 400, message: `at most ${MAX_IMAGE_IDS} images at once` };
  if (!ids.every((id) => typeof id === "string" && STORAGE_ID.test(id))) {
    return { status: 400, message: "not a storage id" };
  }
  return undefined;
}

export function uniqueImageIds(ids: string[]): string[] {
  return [...new Set(ids)];
}
