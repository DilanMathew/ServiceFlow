import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, post } from '@/lib/api';
import { useAuth, homeFor } from '@/lib/auth';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { AuthLayout } from './AuthLayout';
import { t } from '@/lib/i18n';

export default function Login({ portal }: { portal?: boolean }) {
  const { slug } = useParams();
  const nav = useNavigate();
  const loc = useLocation() as any;
  const { acceptToken } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState(slug ?? '');
  const [workspaces, setWorkspaces] = useState<{ slug: string; name: string }[] | null>(null);
  const [mfa, setMfa] = useState<{ token: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish(token: string) {
    const me = await acceptToken(token);
    nav(loc.state?.from && !loc.state.from.startsWith('/login') ? loc.state.from : homeFor(me), { replace: true });
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      if (mfa) { const r = await post('/auth/mfa/verify', { mfaToken: mfa.token, code: mfa.code }); await finish(r.data.accessToken); return; }
      const r = await post('/auth/login', { email, password, workspace: workspace || undefined, portal: !!portal });
      if (r.data.mfaRequired) { setMfa({ token: r.data.mfaToken, code: '' }); return; }
      await finish(r.data.accessToken);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WORKSPACE_REQUIRED') { setWorkspaces(err.details.workspaces); setError(t('Choose which business to sign in to.')); }
      else setError((err as Error).message);
    } finally { setBusy(false); }
  }
  return (
    <AuthLayout title={mfa ? t('Two-factor verification') : portal ? t('Customer sign in') : t('Sign in to ServiceFlow')}
      subtitle={mfa ? t('Enter the 6-digit code from your authenticator app.') : portal ? t('View your service visits, quotations and invoices.') : t('Welcome back. Sign in to your business workspace.')}
      footer={!mfa && (portal ? (slug ? <>{t('New here?')} <Link className="font-medium text-brand-700" to={`/portal/${slug}/register`}>{t('Create an account')}</Link></> : null)
        : <>{t('New to ServiceFlow?')} <Link className="font-medium text-brand-700" to="/register">{t('Start a free trial')}</Link></>)}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert tone="red">{error}</Alert>}
        {mfa ? (
          <Field label={t('Authentication code')} htmlFor="code"><Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={mfa.code}
            onChange={(e) => setMfa({ ...mfa, code: e.target.value.replace(/\D/g, '') })} /></Field>
        ) : (<>
          <Field label={t('Email')} htmlFor="email"><Input id="email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={<span className="flex justify-between">{t('Password')}<Link to="/forgot-password" className="font-normal text-brand-700">{t('Forgot?')}</Link></span>} htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {(workspaces || portal) && (workspaces
            ? <Field label={t('Business')} htmlFor="ws"><Select id="ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder={t('Select business…')} options={workspaces.map((w) => ({ value: w.slug, label: w.name }))} /></Field>
            : !slug && <Field label={t('Business workspace')} hint={t('The short name of the business, e.g. coolcare')} htmlFor="ws2"><Input id="ws2" value={workspace} onChange={(e) => setWorkspace(e.target.value.toLowerCase())} /></Field>)}
        </>)}
        <Button type="submit" className="w-full" size="lg" loading={busy}>{mfa ? t('Verify') : t('Sign in')}</Button>
        {!portal && !mfa && <p className="text-center text-xs text-slate-500">{t('Customer?')} <Link to="/portal/login" className="text-brand-700">{t('Sign in to the customer portal')}</Link></p>}
      </form>
    </AuthLayout>
  );
}
