/**
 * The SDK takes one base URL. On the Excalibase platform the data plane names
 * the project in the path: GraphQL and REST at `/{projectId}/graphql` and
 * `/{projectId}/api/v1`, end-user auth at `/auth/{orgSlug}/{projectId}`,
 * functions at `/functions/v1/{projectId}`. The client is created with the
 * data plane URL and `projectId: "{orgSlug}/{projectId}"` (which is what the
 * SDK's auth paths need), and this fetch moves GraphQL, REST and functions
 * calls to the project's own paths.
 */
export interface PlatformTarget {
  dataUrl: string;
  orgSlug: string;
  projectId: string;
}

export function platformFetch(target: PlatformTarget, inner: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  const base = target.dataUrl.replace(/\/$/, "");
  const functionsPrefix = `${base}/functions/v1/${target.orgSlug}/${target.projectId}/`;
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return inner(rewrite(url, base, target.projectId, functionsPrefix), init);
  };
}

function rewrite(url: string, base: string, projectId: string, functionsPrefix: string): string {
  if (url === `${base}/graphql` || url.startsWith(`${base}/api/v1/`) || url.startsWith(`${base}/api/v1?`)) {
    return `${base}/${projectId}${url.slice(base.length)}`;
  }
  if (url.startsWith(functionsPrefix)) {
    return `${base}/functions/v1/${projectId}/${url.slice(functionsPrefix.length)}`;
  }
  return url;
}
