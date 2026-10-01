// Which project the store talks to. In the container the server writes it into
// /config.js from the app's variables; in development it comes from
// VITE_EXCALIBASE_* (see README).
export interface StoreConfig {
  url: string;
  projectId: string;
  orgSlug: string;
  publishableKey: string;
}

declare global {
  interface Window {
    __STOREFRONT__?: { configured: boolean } & Partial<StoreConfig>;
  }
}

export function readConfig(): StoreConfig | null {
  const served = window.__STOREFRONT__;
  if (served?.configured && served.url && served.projectId && served.orgSlug && served.publishableKey) {
    return { url: served.url, projectId: served.projectId, orgSlug: served.orgSlug, publishableKey: served.publishableKey };
  }
  const env = import.meta.env;
  if (env.VITE_EXCALIBASE_URL && env.VITE_EXCALIBASE_PROJECT_ID && env.VITE_EXCALIBASE_ORG_SLUG && env.VITE_EXCALIBASE_PUBLISHABLE_KEY) {
    return {
      url: String(env.VITE_EXCALIBASE_URL).replace(/\/$/, ""),
      projectId: env.VITE_EXCALIBASE_PROJECT_ID,
      orgSlug: env.VITE_EXCALIBASE_ORG_SLUG,
      publishableKey: env.VITE_EXCALIBASE_PUBLISHABLE_KEY,
    };
  }
  return null;
}
