import { Languages } from 'lucide-react';
import { LANGUAGES, t, useT, type Lang } from '@/lib/i18n';

/** Language choice before sign-in (kept on this device). Signed-in users choose in their profile. */
export function LanguagePicker() {
  const { lang, setLang } = useT();
  return (
    <label className="flex items-center gap-1.5 text-sm text-slate-600">
      <Languages className="h-4 w-4" aria-hidden />
      <span className="sr-only">{t('Language')}</span>
      <select className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </label>
  );
}
