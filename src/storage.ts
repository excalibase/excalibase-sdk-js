export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export function memoryStorageAdapter(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

export function localStorageAdapter(): StorageAdapter {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    throw new Error("localStorageAdapter requires a browser environment with localStorage");
  }
  const ls = window.localStorage;
  return {
    getItem: (key) => ls.getItem(key),
    setItem: (key, value) => ls.setItem(key, value),
    removeItem: (key) => ls.removeItem(key),
  };
}

export function defaultStorage(): StorageAdapter {
  if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
    try {
      return localStorageAdapter();
    } catch {
      return memoryStorageAdapter();
    }
  }
  return memoryStorageAdapter();
}
