/** Regional defaults applied at registration. Every value is editable per tenant afterwards. */
type Tax = { name: string; rate: number; components?: { name: string; rate: number }[]; isDefault?: boolean };
export interface CountryDefaults { currency: string; timezone: string; locale: string; taxRegime: 'GST' | 'VAT' | 'SALES_TAX' | 'NONE'; taxLabel: string; taxes: Tax[]; workingDays: number[] }

const gst = (r: number, d = false): Tax[] => [
  { name: `GST ${r}% (CGST+SGST)`, rate: r, components: [{ name: 'CGST', rate: r / 2 }, { name: 'SGST', rate: r / 2 }], isDefault: d },
  { name: `IGST ${r}%`, rate: r, components: [{ name: 'IGST', rate: r }] },
];
const vat = (rates: number[], label = 'VAT'): Tax[] => rates.map((r, i) => ({ name: `${label} ${r}%`, rate: r, components: [{ name: label, rate: r }], isDefault: i === 0 }));
const eu = (currency: string, timezone: string, locale: string, rates: number[], label = 'VAT'): CountryDefaults =>
  ({ currency, timezone, locale, taxRegime: 'VAT', taxLabel: 'VAT ID', taxes: vat(rates, label), workingDays: [1, 2, 3, 4, 5] });

export const COUNTRY_DEFAULTS: Record<string, CountryDefaults> = {
  IN: { currency: 'INR', timezone: 'Asia/Kolkata', locale: 'en-IN', taxRegime: 'GST', taxLabel: 'GSTIN',
    taxes: [...gst(18, true), ...gst(12), ...gst(5), ...gst(28), { name: 'GST Exempt', rate: 0 }], workingDays: [1, 2, 3, 4, 5, 6] },
  GB: { currency: 'GBP', timezone: 'Europe/London', locale: 'en-GB', taxRegime: 'VAT', taxLabel: 'VAT Reg. No.', taxes: [...vat([20, 5]), { name: 'Zero rated', rate: 0 }], workingDays: [1, 2, 3, 4, 5] },
  IE: eu('EUR', 'Europe/Dublin', 'en-IE', [23, 13.5]),
  DE: eu('EUR', 'Europe/Berlin', 'de-DE', [19, 7], 'MwSt'),
  FR: eu('EUR', 'Europe/Paris', 'fr-FR', [20, 10, 5.5], 'TVA'),
  NL: eu('EUR', 'Europe/Amsterdam', 'nl-NL', [21, 9], 'BTW'),
  ES: eu('EUR', 'Europe/Madrid', 'es-ES', [21, 10], 'IVA'),
  IT: eu('EUR', 'Europe/Rome', 'it-IT', [22, 10], 'IVA'),
  PT: eu('EUR', 'Europe/Lisbon', 'pt-PT', [23, 13]),
  BE: eu('EUR', 'Europe/Brussels', 'nl-BE', [21, 6]),
  AT: eu('EUR', 'Europe/Vienna', 'de-AT', [20, 10], 'USt'),
  PL: eu('PLN', 'Europe/Warsaw', 'pl-PL', [23, 8]),
  SE: eu('SEK', 'Europe/Stockholm', 'sv-SE', [25, 12], 'Moms'),
  AE: { currency: 'AED', timezone: 'Asia/Dubai', locale: 'en-AE', taxRegime: 'VAT', taxLabel: 'TRN', taxes: vat([5]), workingDays: [1, 2, 3, 4, 5] },
  SA: { currency: 'SAR', timezone: 'Asia/Riyadh', locale: 'en-SA', taxRegime: 'VAT', taxLabel: 'VAT No.', taxes: vat([15]), workingDays: [7, 1, 2, 3, 4] },
  US: { currency: 'USD', timezone: 'America/New_York', locale: 'en-US', taxRegime: 'SALES_TAX', taxLabel: 'Tax ID', taxes: [{ name: 'Sales tax', rate: 0, isDefault: true }], workingDays: [1, 2, 3, 4, 5] },
  AU: { currency: 'AUD', timezone: 'Australia/Sydney', locale: 'en-AU', taxRegime: 'GST', taxLabel: 'ABN', taxes: [{ name: 'GST 10%', rate: 10, components: [{ name: 'GST', rate: 10 }], isDefault: true }], workingDays: [1, 2, 3, 4, 5] },
  SG: { currency: 'SGD', timezone: 'Asia/Singapore', locale: 'en-SG', taxRegime: 'GST', taxLabel: 'GST Reg. No.', taxes: [{ name: 'GST 9%', rate: 9, components: [{ name: 'GST', rate: 9 }], isDefault: true }], workingDays: [1, 2, 3, 4, 5] },
};
export const DEFAULT_COUNTRY: CountryDefaults = { currency: 'USD', timezone: 'UTC', locale: 'en-US', taxRegime: 'NONE', taxLabel: 'Tax ID', taxes: [{ name: 'No tax', rate: 0, isDefault: true }], workingDays: [1, 2, 3, 4, 5] };
export const countryDefaults = (c: string) => COUNTRY_DEFAULTS[c.toUpperCase()] ?? DEFAULT_COUNTRY;
