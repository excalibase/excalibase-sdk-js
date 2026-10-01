import { ConfigError } from "./errors";

/**
 * Where one project lives on the platform. Every service path is built from
 * the platform's base URL and the project id, the way the edge routes them:
 *
 *   GraphQL + realtime WebSocket   {url}/{projectId}/graphql
 *   REST                           {url}/{projectId}/api/v1/...
 *   end-user auth                  {url}/auth/{orgSlug}/{projectId}/...
 *   functions (and storage)        {url}/functions/v1/{projectId}/{module}.{name}
 */
export interface ProjectTarget {
  readonly url: string;
  readonly projectId: string;
  /** Auth's org path segment. Auth finds the project by its id; the org only labels it. */
  readonly orgSlug: string;
}

export interface ProjectTargetInput {
  url: unknown;
  projectId: unknown;
  orgSlug?: unknown;
}

const SEGMENT = /^[a-zA-Z0-9_-]{1,128}$/;
const SERVICE_PATH = /\/(graphql|api\/v1|auth|functions\/v1)(\/|$)/;

export function resolveProjectTarget(input: ProjectTargetInput): ProjectTarget {
  const url = parseBaseUrl(input.url);
  const { orgSlug: orgFromId, projectId } = parseProjectId(input.projectId);
  const orgSlug = resolveOrgSlug(input.orgSlug, orgFromId) ?? projectId;
  const lastSegment = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (lastSegment === projectId) {
    throw new ConfigError(
      `\`url\` already ends with the project id '${projectId}'. Pass the platform's base URL (e.g. https://api.example.com) as \`url\` and the id as \`projectId\`; the SDK adds the project to every path.`,
    );
  }
  return { url, projectId, orgSlug };
}

export function graphqlUrl(target: ProjectTarget): string {
  return `${target.url}/${target.projectId}/graphql`;
}

export function restUrl(target: ProjectTarget, path: string): string {
  return `${target.url}/${target.projectId}/api/v1${leadingSlash(path)}`;
}

export function authUrl(target: ProjectTarget, subpath: string): string {
  return `${target.url}/auth/${target.orgSlug}/${target.projectId}${leadingSlash(subpath)}`;
}

export function functionsUrl(target: ProjectTarget, name: string): string {
  return `${target.url}/functions/v1/${target.projectId}/${name}`;
}

export function realtimeUrl(target: ProjectTarget): string {
  return graphqlUrl(target).replace(/^http/, "ws");
}

function parseBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConfigError("`url` is required: the platform's base URL, e.g. https://api.example.com");
  }
  if (!/^https?:\/\//.test(raw)) {
    throw new ConfigError("`url` must start with http:// or https://");
  }
  const url = raw.replace(/\/+$/, "");
  const path = new URL(url).pathname;
  if (SERVICE_PATH.test(path)) {
    throw new ConfigError(
      `\`url\` must be the platform's base URL, without a service path (got '${url}'). The SDK builds /{projectId}/graphql, /{projectId}/api/v1, /auth and /functions/v1 itself.`,
    );
  }
  return url;
}

function parseProjectId(raw: unknown): { orgSlug: string | null; projectId: string } {
  const parts = typeof raw === "string" ? raw.split("/") : [];
  if (parts.length >= 1 && parts.length <= 2 && parts.every((part) => SEGMENT.test(part))) {
    return parts.length === 2 ? { orgSlug: parts[0]!, projectId: parts[1]! } : { orgSlug: null, projectId: parts[0]! };
  }
  throw new ConfigError(
    "`projectId` must be the project's id (letters, digits, '-' or '_', at most 128), e.g. 'proj-a1b2c3d4e5'. The older '{orgSlug}/{projectId}' form is still read; pass the org as `orgSlug` instead.",
  );
}

function resolveOrgSlug(raw: unknown, fromProjectId: string | null): string | null {
  if (raw === undefined || raw === null) return fromProjectId;
  if (typeof raw !== "string" || !SEGMENT.test(raw)) {
    throw new ConfigError("`orgSlug` must be the org's slug (letters, digits, '-' or '_').");
  }
  if (fromProjectId !== null && fromProjectId !== raw) {
    throw new ConfigError(
      `\`orgSlug\` '${raw}' disagrees with the org in \`projectId\` '${fromProjectId}/...'. Pass the bare project id as \`projectId\`.`,
    );
  }
  return raw;
}

function leadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
