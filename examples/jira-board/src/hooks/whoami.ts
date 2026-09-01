import { useEffect, useState } from "react";

/**
 * Persists the resolved Postgres role to localStorage, keyed by demo
 * identity. Only fetches the first time we see a given identity — every
 * subsequent render (or page reload) reads from cache.
 *
 * Why this is safe:
 *   • The role for a given JWT is determined entirely by the JWT's
 *     `scope` + `role` claims and the server's role-switching config.
 *     Both are stable for the JWT's lifetime.
 *   • If you change the server config or rotate JWTs, bump CACHE_VERSION
 *     to invalidate.
 */
const CACHE_VERSION = "v1";
const STORAGE_KEY = `excalibase.whoami.${CACHE_VERSION}`;

type Cache = Record<string, string>;

function readCache(): Cache {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Cache;
  } catch {
    return {};
  }
}

function writeCache(cache: Cache) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage might be disabled (private mode, quota) — degrade
    // gracefully; we just refetch each load instead.
  }
}

export function useCachedWhoami(
  identityKey: string,
  fetcher: () => Promise<string | null>,
): string | null {
  const [role, setRole] = useState<string | null>(() => readCache()[identityKey] ?? null);

  useEffect(() => {
    const cached = readCache()[identityKey];
    if (cached) {
      setRole(cached);
      return;
    }
    let cancelled = false;
    fetcher()
      .then(next => {
        if (cancelled || !next) return;
        setRole(next);
        const cache = readCache();
        cache[identityKey] = next;
        writeCache(cache);
      })
      .catch(() => {
        // Silently fall back to client-side identity.pgRole.
      });
    return () => {
      cancelled = true;
    };
    // fetcher changes on every render in callers; we depend only on
    // identityKey so we don't refetch unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  return role;
}

/** Manual cache bust — exposed in case the demo wants a "verify" button later. */
export function clearWhoamiCache() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
