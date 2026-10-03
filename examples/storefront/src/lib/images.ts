// Product pictures are in the project's Storage. The function images.urls
// turns storage ids into short-lived links; every picture a render asks for is
// fetched in one call.
import type { DbClient } from "@excalibase/sdk";

export type ImageUrls = Record<string, string | null>;
type FetchUrls = (storageIds: string[]) => Promise<ImageUrls>;

// How long a link is used before it is asked for again; the platform signs
// them for five minutes.
export const IMAGE_URL_TTL_MS = 4 * 60_000;

export function imageUrlsFrom(db: DbClient): FetchUrls {
  const functions = db.functions as unknown as { images: { urls: (args: { storageIds: string[] }) => Promise<ImageUrls> } };
  return (storageIds) => functions.images.urls({ storageIds });
}

export function createImageUrlLoader(fetchUrls: FetchUrls): (storageId: string) => Promise<string | null> {
  let pending: Map<string, Array<{ resolve: (url: string | null) => void; reject: (err: unknown) => void }>> | null = null;

  const flush = async (batch: NonNullable<typeof pending>) => {
    try {
      const urls = await fetchUrls([...batch.keys()]);
      for (const [id, waiters] of batch) waiters.forEach((w) => w.resolve(urls[id] ?? null));
    } catch (err) {
      for (const waiters of batch.values()) waiters.forEach((w) => w.reject(err));
    }
  };

  return (storageId) => new Promise((resolve, reject) => {
    if (!pending) {
      const batch = new Map<string, Array<{ resolve: (url: string | null) => void; reject: (err: unknown) => void }>>();
      pending = batch;
      queueMicrotask(() => {
        pending = null;
        void flush(batch);
      });
    }
    const waiters = pending.get(storageId) ?? [];
    waiters.push({ resolve, reject });
    pending.set(storageId, waiters);
  });
}
