// Thin clients for the two APIs the setup script uses: the control plane
// (Studio's /api, with a personal access token) and the project's end-user
// auth on the data plane.

export class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} -> HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function call(fetchImpl, method, url, { token, body, headers } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new HttpError(method, url, response.status, data);
  return data;
}

export function controlPlane(apiUrl, token, fetchImpl = fetch) {
  const base = apiUrl.replace(/\/$/, '');
  const request = (method, path, body, headers) => call(fetchImpl, method, `${base}${path}`, { token, body, headers });
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
    put: (path, body) => request('PUT', path, body ?? {}),
    patch: (path, body, headers) => request('PATCH', path, body ?? {}, headers),
  };
}

export function endUserAuth(authUrl, orgSlug, projectId, fetchImpl = fetch) {
  const base = `${authUrl.replace(/\/$/, '')}/auth/${orgSlug}/${projectId}`;
  return {
    register: (account) => call(fetchImpl, 'POST', `${base}/register`, { body: account }),
    signIn: ({ email, password }) => call(fetchImpl, 'POST', `${base}/token`, {
      body: { grant_type: 'password', email, password },
    }),
  };
}
