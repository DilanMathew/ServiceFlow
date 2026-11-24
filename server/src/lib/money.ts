/**
 * Line and document total calculation. Works in integer minor units (paise/cents) to avoid
 * floating point drift. Tax is configurable per line (GST with CGST/SGST or IGST components,
 * VAT, sales tax or none) — no country's rules are hard-coded.
 */
export interface LineInput {
  quantity: number;
  unitPrice: number;
  discountPercent?: number;
  taxRate?: number;
  taxComponents?: { name: string; rate: number }[];
}
export interface LineResult {
  line_subtotal: number; line_discount: number; line_tax: number; line_total: number;
  tax_components: { name: string; rate: number; amount: number }[];
}

const toMinor = (n: number) => Math.round(n * 100);
const fromMinor = (n: number) => Math.round(n) / 100;

export function calcLine(l: LineInput, pricesIncludeTax = false): LineResult {
  const rate = l.taxRate ?? 0;
  let gross = toMinor(l.quantity * l.unitPrice);
  const discount = Math.round((gross * (l.discountPercent ?? 0)) / 100);
  let net = gross - discount;
  let tax: number;
  if (pricesIncludeTax && rate > 0) {
    const base = Math.round(net / (1 + rate / 100));
    tax = net - base;
    net = base;
    gross = base + discount;
  } else {
    tax = Math.round((net * rate) / 100);
  }
  const comps = (l.taxComponents?.length ? l.taxComponents : rate > 0 ? [{ name: 'Tax', rate }] : []);
  let allocated = 0;
  const components = comps.map((c, i) => {
    const amt = i === comps.length - 1 ? tax - allocated : Math.round((tax * c.rate) / (rate || 1));
    allocated += amt;
    return { name: c.name, rate: c.rate, amount: fromMinor(amt) };
  });
  return {
    line_subtotal: fromMinor(gross),
    line_discount: fromMinor(discount),
    line_tax: fromMinor(tax),
    line_total: fromMinor(net + tax),
    tax_components: components,
  };
}

export function calcTotals(lines: LineResult[]) {
  const sum = (f: (l: LineResult) => number) => fromMinor(lines.reduce((a, l) => a + toMinor(f(l)), 0));
  const breakdown = new Map<string, { name: string; rate: number; amount: number }>();
  for (const l of lines) for (const c of l.tax_components) {
    const k = `${c.name}@${c.rate}`;
    const e = breakdown.get(k) ?? { name: c.name, rate: c.rate, amount: 0 };
    e.amount = fromMinor(toMinor(e.amount) + toMinor(c.amount));
    breakdown.set(k, e);
  }
  return {
    subtotal: sum((l) => l.line_subtotal),
    discount_total: sum((l) => l.line_discount),
    tax_total: sum((l) => l.line_tax),
    total: sum((l) => l.line_total),
    tax_breakdown: [...breakdown.values()],
  };
}

export const round2 = (n: number) => fromMinor(toMinor(n));
