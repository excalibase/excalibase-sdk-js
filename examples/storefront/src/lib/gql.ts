// Literals for GraphQL documents built in code. Strings are JSON-escaped
// (valid GraphQL string syntax); numbers must be integers.
export const str = (value: string): string => JSON.stringify(value);

export function int(value: number): string {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`not an integer: ${String(value)}`);
  return String(value);
}

export function decimal(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`not a price: ${String(value)}`);
  return value.toFixed(2);
}
