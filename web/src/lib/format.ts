import { format as dfFormat, formatDistanceToNow } from 'date-fns';

/** Tenant-aware formatting; configured once after /auth/me loads. */
let currency = 'INR', locale = 'en-IN', timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function configureFormat(o: { currency?: string; locale?: string; timezone?: string }) {
  if (o.currency) currency = o.currency; if (o.locale) locale = o.locale; if (o.timezone) timezone = o.timezone;
}
export const tz = () => timezone;
export const appCurrency = () => currency;

export function money(v: number | string | null | undefined, cur?: string) {
  if (v === null || v === undefined || v === '') return '—';
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: cur ?? currency, maximumFractionDigits: 2 }).format(Number(v)); }
  catch { return `${cur ?? currency} ${Number(v).toFixed(2)}`; }
}
export const compactMoney = (v: number | string | null | undefined, cur?: string) => {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: cur ?? currency, notation: 'compact', maximumFractionDigits: 1 }).format(Number(v ?? 0)); }
  catch { return money(v, cur); }
};
export const num = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat(locale).format(Number(v)));

export function date(v?: string | Date | null) {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(`${v}T12:00:00`));
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: timezone }).format(new Date(v));
}
export function dateTime(v?: string | Date | null) {
  if (!v) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(v));
}
export function time(v?: string | Date | null) {
  if (!v) return '—';
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: timezone }).format(new Date(v));
}
export const ago = (v?: string | Date | null) => (v ? formatDistanceToNow(new Date(v), { addSuffix: true }) : '—');
export const ymd = (d: Date) => dfFormat(d, 'yyyy-MM-dd');
/** Converts a <input type="datetime-local"> value to an ISO string with offset. */
export const localToIso = (v: string) => (v ? new Date(v).toISOString() : null);
export const isoToLocal = (v?: string | null) => (v ? dfFormat(new Date(v), "yyyy-MM-dd'T'HH:mm") : '');
