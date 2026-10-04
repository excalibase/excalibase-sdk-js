import { createClient, type DbClient } from "@excalibase/sdk";
import type { StoreConfig } from "./config";

// One SDK client for the whole store: end-user sign-in, GraphQL, realtime, and
// the session kept in localStorage and refreshed before it expires. The SDK
// builds the project's paths on the data plane from the URL and project id.
export function createStoreClient(config: StoreConfig): DbClient {
  return createClient({
    url: config.url,
    projectId: config.projectId,
    orgSlug: config.orgSlug,
    key: config.publishableKey,
  });
}
