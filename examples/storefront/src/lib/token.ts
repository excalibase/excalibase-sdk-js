// What a session's access token says about the caller. Only for display and
// for choosing which screens to show: the data plane enforces the role itself.
export interface Claims {
  role?: string;
  allowed_roles?: string[];
  userId?: number | string;
  email?: string;
}

export function claimsOf(accessToken: string | null | undefined): Claims {
  const payload = accessToken?.split(".")[1];
  if (!payload) return {};
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="))) as Claims;
  } catch {
    return {};
  }
}

export function roleOf(accessToken: string | null | undefined): string {
  return claimsOf(accessToken).role ?? "anon";
}
