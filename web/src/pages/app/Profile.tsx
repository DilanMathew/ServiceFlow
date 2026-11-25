import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { del, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useData } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader } from '@/components/ui';
import { toastError } from '@/components/form';
import { PushCard } from '../tech/offline';
import { LANGUAGES, roleLabel, t, useT, type Lang } from '@/lib/i18n';

export default function Profile() {
  const { me, reload } = useAuth();
  const qc = useQueryClient();
  const [p, setP] = useState({ fullName: me?.user.full_name ?? '', phone: me?.user.phone ?? '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [mfa, setMfa] = useState<{ qr: string; secret: string; code: string } | null>(null);
  const [disable, setDisable] = useState({ password: '', code: '' });
  const { data: sessions } = useData<any[]>(['sessions'], '/auth/sessions');
  const isAdmin = me?.roles.some((r) => ['owner', 'admin', 'super_admin'].includes(r));
  return (
    <div className="max-w-3xl">
      <PageHeader title={t('My profile & security')} description={`${me?.user.email} · ${me?.roles.map(roleLabel).join(', ')}`} />
      <div className="space-y-6">
        <Card><CardHeader title={t('Profile')} /><CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Full name')}><Input value={p.fullName} onChange={(e) => setP({ ...p, fullName: e.target.value })} /></Field>
          <Field label={t('Phone')}><Input value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Button onClick={() => patch('/auth/profile', { fullName: p.fullName, phone: p.phone || null }).then(() => { toast.success(t('Profile updated')); reload(); }).catch(toastError)}>{t('Save')}</Button></div>
        </CardBody></Card>
        <LanguageCard />
        {me?.user.user_type === 'staff' && !me.support && <PushCard />}
        <Card><CardHeader title={t('Change password')} description={t('Other sessions are signed out after a change.')} /><CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Current password')}><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label={t('New password')} hint={t('At least 10 characters with letters and numbers')}><Input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Button onClick={() => post('/auth/change-password', pw).then(() => { toast.success(t('Password changed')); setPw({ currentPassword: '', newPassword: '' }); qc.invalidateQueries({ queryKey: ['sessions'] }); }).catch(toastError)}>{t('Change password')}</Button></div>
        </CardBody></Card>
        <Card><CardHeader title={t('Two-factor authentication')} description={t('Use an authenticator app (Google Authenticator, Authy, 1Password…).')} actions={me?.user.mfa_enabled ? <Badge tone="green"><ShieldCheck className="h-3 w-3" />{t('Enabled')}</Badge> : <Badge>{t('Off')}</Badge>} />
          <CardBody className="space-y-4">
            {!me?.user.mfa_enabled && isAdmin && <Alert tone="amber">{t('Administrators should enable two-factor authentication.')}</Alert>}
            {me?.user.mfa_enabled ? <div className="grid gap-3 sm:grid-cols-3"><Field label={t('Password')}><Input type="password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} /></Field>
              <Field label={t('Current code')}><Input inputMode="numeric" maxLength={6} value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value })} /></Field>
              <div className="pt-6"><Button variant="danger-outline" onClick={() => post('/auth/mfa/disable', disable).then(() => { toast.success(t('Two-factor authentication disabled')); reload(); }).catch(toastError)}>{t('Disable')}</Button></div></div>
            : mfa ? <div className="flex flex-wrap items-start gap-6"><img src={mfa.qr} alt="Scan this QR code with your authenticator app" className="h-44 w-44 rounded-lg border" />
              <div className="space-y-3"><p className="text-sm text-slate-600">{t('Scan the QR code, or enter this key:')} <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{mfa.secret}</code></p>
                <Field label={t('6-digit code')}><Input inputMode="numeric" maxLength={6} value={mfa.code} onChange={(e) => setMfa({ ...mfa, code: e.target.value.replace(/\D/g, '') })} /></Field>
                <Button onClick={() => post('/auth/mfa/enable', { code: mfa.code }).then(() => { toast.success(t('Two-factor authentication enabled')); setMfa(null); reload(); }).catch(toastError)}>{t('Verify & enable')}</Button></div></div>
            : <Button onClick={() => post('/auth/mfa/setup').then((r) => setMfa({ ...r.data, code: '' })).catch(toastError)}>{t('Set up two-factor authentication')}</Button>}
          </CardBody></Card>
        <Card><CardHeader title={t('Active sessions')} /><ul className="divide-y divide-slate-100 text-sm">{(sessions ?? []).map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3"><span className="min-w-0"><span className="block truncate">{s.user_agent ?? t('Unknown device')}</span><span className="text-xs text-slate-500">{s.ip} · {t('last used {date}', { date: dateTime(s.last_used_at) })}</span></span>
            {s.current ? <Badge tone="blue">{t('This device')}</Badge> : <Button size="sm" variant="ghost" onClick={() => del(`/auth/sessions/${s.id}`).then(() => qc.invalidateQueries({ queryKey: ['sessions'] })).catch(toastError)}>{t('Sign out')}</Button>}</li>))}</ul></Card>
      </div>
    </div>
  );
}

/** Language for this account: saved on the server so it follows the user to every device. */
function LanguageCard() {
  const { lang, setLang } = useT();
  const [busy, setBusy] = useState(false);
  const change = async (l: Lang) => {
    setBusy(true);
    try { await patch('/auth/profile', { locale: l }); await setLang(l); toast.success(t('Language updated')); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader title={t('Language')} description={t('Used for menus, the technician app and the customer portal on all your devices.')} />
      <CardBody><div className="flex flex-wrap gap-2">{LANGUAGES.map((l) => (
        <Button key={l.code} size="sm" disabled={busy} variant={lang === l.code ? 'primary' : 'outline'} aria-pressed={lang === l.code} onClick={() => change(l.code)}>{l.label}</Button>))}</div></CardBody></Card>
  );
}
