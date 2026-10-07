import { CorsError } from "./errors";

// What each browser's fetch rejects with when it gets no usable response:
// a CORS refusal, but also a server that is down. Chrome, Firefox, Safari.
const OPAQUE_FAILURE = /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/;

function pageOrigin(): string | null {
  const origin = (globalThis as { window?: { location?: { origin?: unknown } } }).window?.location?.origin;
  return typeof origin === "string" && origin !== "null" ? origin : null;
}

// A relative URL resolves against the page, as the browser resolves it.
function requestOrigin(input: unknown, page: string): string | null {
  const href = typeof input === "string" || input instanceof URL ? String(input) : (input as { url?: unknown })?.url;
  try {
    return typeof href === "string" ? new URL(href, page).origin : null;
  } catch {
    return null;
  }
}

/**
 * corsFailure is the CorsError a failed fetch most likely means: a browser
 * page, online, calling another origin, refused with no response at all.
 * Anything else (a server runtime, offline, same origin, an abort) is null.
 */
export function corsFailure(error: unknown, input: unknown): CorsError | null {
  if (!(error instanceof TypeError) || !OPAQUE_FAILURE.test(error.message)) return null;
  const origin = pageOrigin();
  if (origin == null) return null;
  if ((globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false) return null;
  if (requestOrigin(input, origin) === origin) return null;
  return new CorsError(origin, error);
}

/** corsAwareFetch rethrows a CORS-shaped failure as a CorsError. */
export function corsAwareFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      throw corsFailure(error, input) ?? error;
    }
  };
}
