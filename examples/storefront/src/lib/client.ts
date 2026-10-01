import { createClient, type DbClient } from "@excalibase/sdk";
import type { StoreConfig } from "./config";
import { platformFetch } from "./platform-fetch";

// One SDK client for the whole store: end-user sign-in, GraphQL, and the
// session kept in localStorage and refreshed before it expires.
export function createStoreClient(config: StoreConfig): DbClient {
  return createClient({
    url: config.url,
    projectId: `${config.orgSlug}/${config.projectId}`,
    publishableKey: config.publishableKey,
    fetch: platformFetch({ dataUrl: config.url, orgSlug: config.orgSlug, projectId: config.projectId }),
  });
}
