/**
 * Translations. Source strings are the English text itself (gettext style), so untranslated text
 * always falls back to readable English. Catalogs are JSON files in src/locales, loaded on demand.
 *   t('Job accepted')                         → translated string
 *   t('Hi {name}', { name })                  → interpolation
 *   tn('{count} job', '{count} jobs', n)      → plural (uses Intl.PluralRules)
 * `npm run i18n:check` lists any t()/tn() string missing from a catalog.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setDateLocale } from './format';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'de', label: 'Deutsch (German)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'es', label: 'Español (Spanish)' },
] as const;
export type Lang = (typeof LANGUAGES)[number]['code'];
export const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.code === v);

type Catalog = Record<string, string>;
const loaders: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Catalog }>> = {
  hi: () => import('../locales/hi.json'),
  de: () => import('../locales/de.json'),
  fr: () => import('../locales/fr.json'),
  es: () => import('../locales/es.json'),
};

let current: Lang = 'en';
let catalog: Catalog = {};
const listeners = new Set<() => void>();

function interpolate(s: string, vars?: Record<string, unknown>) {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : s;
}
/** Translate outside React (toasts, helpers). Components should prefer useT() so they re-render on change. */
export function t(key: string, vars?: Record<string, unknown>) { return interpolate(catalog[key] ?? key, vars); }
export function tn(one: string, other: string, count: number, vars?: Record<string, unknown>) {
  const rule = new Intl.PluralRules(current).select(count);
  const key = rule === 'one' ? one : other;
  return interpolate(catalog[key] ?? key, { count, ...vars });
}
export const currentLang = () => current;

const STORE_KEY = 'sf-lang';
export function storedLang(): Lang | null { try { const v = localStorage.getItem(STORE_KEY); return isLang(v) ? v : null; } catch { return null; } }
function browserLang(): Lang | null {
  for (const l of navigator.languages ?? [navigator.language]) { const c = l?.slice(0, 2); if (isLang(c)) return c; }
  return null;
}

export async function setLanguage(lang: Lang, persist = true) {
  catalog = lang === 'en' ? {} : (await loaders[lang]()).default;
  current = lang;
  document.documentElement.lang = lang;
  await setDateLocale(lang);
  if (persist) try { localStorage.setItem(STORE_KEY, lang); } catch { /* private mode */ }
  listeners.forEach((f) => f());
}

const Ctx = createContext<{ lang: Lang; t: typeof t; tn: typeof tn; setLang: (l: Lang) => Promise<void> } | null>(null);

/** Initial language: a choice saved on this device, else the browser's language, else English. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(current);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const unsub = (() => { const f = () => setLang(current); listeners.add(f); return () => listeners.delete(f); })();
    const initial = storedLang() ?? browserLang() ?? 'en';
    setLanguage(initial, false).catch(() => undefined).finally(() => setReady(true));
    return () => { unsub(); };
  }, []);
  const change = useCallback((l: Lang) => setLanguage(l), []);
  // lang in the deps makes every consumer re-render with the new catalog
  const value = useMemo(() => ({ lang, t: (k: string, v?: Record<string, unknown>) => t(k, v), tn, setLang: change }), [lang, change]);
  if (!ready) return null;
  // Re-mount the tree when the language changes so every t() call (hooks or not) renders the new text.
  return <Ctx.Provider value={value}><Fragment key={lang}>{children}</Fragment></Ctx.Provider>;
}

export function useT() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useT outside I18nProvider');
  return c;
}

/** Applies the signed-in user's saved language (or the business language) once the profile loads. */
export function applyUserLanguage(userLocale: string | null | undefined, tenantLocale: string | null | undefined) {
  // Precedence: the user's saved choice → a choice made on this device → the browser language already
  // in use → the business default.
  const browser = current !== 'en' ? current : null;
  const pick = [userLocale?.slice(0, 2), storedLang(), browser, tenantLocale?.slice(0, 2)].find(isLang) as Lang | undefined;
  if (pick && pick !== current) void setLanguage(pick, !!userLocale);
}

/** Human label for a status/priority/category code, translated. Unknown codes fall back to Title Case. */
export function statusLabel(code?: string | null): string {
  if (!code) return '';
  const L: Record<string, string> = {
    new: t('New'), approved: t('Approved'), scheduled: t('Scheduled'), assigned: t('Assigned'), en_route: t('En route'), in_progress: t('In progress'),
    on_hold: t('On hold'), completed: t('Completed'), invoiced: t('Invoiced'), paid: t('Paid'), cancelled: t('Cancelled'), rejected: t('Rejected'),
    under_review: t('Under review'), converted: t('Converted'), draft: t('Draft'), sent: t('Sent'), viewed: t('Viewed'), expired: t('Expired'),
    superseded: t('Superseded'), issued: t('Issued'), partially_paid: t('Partially paid'), overdue: t('Overdue'), refunded: t('Refunded'),
    partially_refunded: t('Partially refunded'), succeeded: t('Succeeded'), pending: t('Pending'), failed: t('Failed'), active: t('Active'),
    inactive: t('Inactive'), archived: t('Archived'), renewed: t('Renewed'), trialing: t('Trial'), past_due: t('Past due'), grace_period: t('Grace period'),
    suspended: t('Suspended'), open: t('Open'), waiting_for_customer: t('Waiting for customer'), resolved: t('Resolved'), closed: t('Closed'),
    queued: t('Queued'), sending: t('Sending'), delivered: t('Delivered'), skipped: t('Skipped'), urgent: t('Urgent'), high: t('High'), normal: t('Normal'),
    low: t('Low'), under_repair: t('Under repair'), replaced: t('Replaced'), decommissioned: t('Decommissioned'), work_order_created: t('Job created'),
    missed: t('Missed'), ok: t('OK'), error: t('Error'), unconfigured: t('Not configured'), on_leave: t('On leave'), terminated: t('Terminated'),
    reviewed: t('Reviewed'), action_taken: t('Action taken'), dismissed: t('Dismissed'), registered: t('Registered'),
    photo_before: t('Before photo'), photo_after: t('After photo'), service_photo: t('Service photo'), signature: t('Signature'), attachment: t('Attachment'),
    labour: t('Labour'), part: t('Part'), charge: t('Charge'), amc: t('AMC'), good: t('Good'), fair: t('Fair'), poor: t('Poor'), critical: t('Critical'),
  };
  return L[code] ?? code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Marks a string for translation without translating it yet (module-level constants); render with t(value). */
export const tk = <S extends string>(s: S) => s;

/** Translated role name. */
export function roleLabel(code?: string | null): string {
  if (!code) return '';
  const L: Record<string, string> = {
    super_admin: t('Super Admin'), owner: t('Owner'), admin: t('Admin'), branch_manager: t('Branch Manager'), operations_manager: t('Operations Manager'),
    dispatcher: t('Dispatcher'), technician: t('Technician'), accountant: t('Accountant'), customer: t('Customer'),
  };
  return L[code] ?? code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
