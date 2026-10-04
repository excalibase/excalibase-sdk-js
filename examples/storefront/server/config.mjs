// What the browser is told about the project, read from the app's variables.
// Only public values: the data plane URL, the project, and the publishable key
// (which is meant to ship in browser code). Nothing else from the environment.

const REQUIRED = ['EXCALIBASE_URL', 'EXCALIBASE_PROJECT_ID', 'EXCALIBASE_ORG_SLUG', 'EXCALIBASE_PUBLISHABLE_KEY'];

export function browserConfig(env) {
  if (REQUIRED.some((name) => !env[name])) return { configured: false };
  return {
    configured: true,
    url: env.EXCALIBASE_URL.replace(/\/$/, ''),
    projectId: env.EXCALIBASE_PROJECT_ID,
    orgSlug: env.EXCALIBASE_ORG_SLUG,
    publishableKey: env.EXCALIBASE_PUBLISHABLE_KEY,
  };
}

export function configScript(env) {
  // JSON with "<" escaped cannot close the script element it is served into.
  const json = JSON.stringify(browserConfig(env)).replace(/</g, '\\u003c');
  return `window.__STOREFRONT__ = ${json};\n`;
}

// Where product pictures are served from and uploaded to (the project's
// object store), when it is a bare http(s) origin; anything else is ignored.
function storageOrigin(env) {
  const value = env.EXCALIBASE_STORAGE_ORIGIN;
  if (!value) return '';
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value.replace(/\/$/, '')) return '';
    return ` ${url.origin}`;
  } catch {
    return '';
  }
}

export function contentSecurityPolicy(env) {
  let dataPlane = '';
  if (env.EXCALIBASE_URL) {
    const url = new URL(env.EXCALIBASE_URL);
    const socket = url.protocol === 'https:' ? 'wss:' : 'ws:';
    dataPlane = ` ${url.protocol}//${url.host} ${socket}//${url.host}`;
  }
  const storage = storageOrigin(env);
  return [
    "default-src 'self'",
    `connect-src 'self'${dataPlane}${storage}`,
    `img-src 'self' data:${storage}`,
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
