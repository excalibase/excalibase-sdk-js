// Prices come from the database as decimals (numbers or strings); totals are
// added in cents so they never drift.
export interface Line {
  price: number | string;
  quantity: number;
}

export const toCents = (price: number | string): number => Math.round(Number(price) * 100);

export const lineTotal = (line: Line): number => toCents(line.price) * line.quantity;

export const sumLines = (lines: Line[]): number => lines.reduce((sum, line) => sum + lineTotal(line), 0);

const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(amount: number | string, opts: { decimal?: boolean } = {}): string {
  const cents = opts.decimal ? toCents(amount) : Number(amount);
  return formatter.format(cents / 100);
}
