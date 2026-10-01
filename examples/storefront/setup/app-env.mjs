// Pure helpers for the setup script, kept apart so they are unit tested.

// The app's variables after setting `literals`: every variable the app already
// has keeps its kind (a template's generated secrets and database references
// stay as they are), a name in `literals` is replaced by a plain value, and
// new names are appended in a stable order.
export function mergeAppEnv(existing, literals) {
  const names = new Set(Object.keys(literals));
  const kept = (existing ?? []).filter((variable) => !names.has(variable.name));
  const added = Object.keys(literals)
    .sort()
    .map((name) => ({ name, kind: 'literal', value: String(literals[name]) }));
  return [...kept, ...added];
}

// The CORS list with `origins` added, de-duplicated, order kept. A wildcard
// list is left alone: it already admits every origin.
export function withOrigins(current, origins) {
  const list = current ?? [];
  if (list.length === 1 && list[0] === '*') return list;
  const merged = [...list];
  for (const origin of origins) {
    if (!merged.includes(origin)) merged.push(origin);
  }
  return merged;
}

// An origin as the browser sends it: scheme and host, no path.
export function originOf(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

export function literalValue(env, name) {
  const variable = (env ?? []).find((entry) => entry.name === name);
  return variable && variable.kind === 'literal' ? variable.value ?? null : null;
}
