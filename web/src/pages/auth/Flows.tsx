import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, post } from '@/lib/api';
import { useAuth, homeFor } from '@/lib/auth';
import { Alert, Button, Field, Input, Spinner } from '@/components/ui';
import { AuthLayout } from './AuthLayout';

export default function Flows({ mode }: { mode: 'forgot' | 'reset' | 'verify' | 'invite' | 'portal-register' }) {
  const [sp] = useSearchParams();
  const token = sp.get('token') ?? '';
  const { slug } = useParams();
  const nav = useNavigate();
  const { acceptToken } = useAuth();
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({ email: '', password: '', fullName: '', phone: '' });
  const [invite, setInvite] = useState<any>(null);

  useEffect(() => {
    if (mode === 'verify') post('/auth/verify-email', { token }).then(() => setMsg({ tone: 'green', text: 'Your email address is verified. You can now sign in.' }))
      .catch((e) => setMsg({ tone: 'red', text: e.message }));
    if (mode === 'invite') get(`/auth/invitation?token=${encodeURIComponent(token)}`).then((r) => { setInvite(r.data); setV((x) => ({ ...x, fullName: r.data.full_name })); })
      .catch((e) => setMsg({ tone: 'red', text: e.message }));
  }, [mode, token]);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ tone: 'red', text: (e as Error).message }); } finally { setBusy(false); } };
  const pw = <Field label="New password" hint="At least 10 characters with letters and numbers" required><Input type="password" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} /></Field>;

  if (mode === 'verify') return <AuthLayout title="Email verification">{msg ? <><Alert tone={msg.tone}>{msg.text}</Alert><Link to="/login"><Button className="mt-4 w-full">Continue to sign in</Button></Link></> : <Spinner />}</AuthLayout>;
  if (mode === 'forgot') return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a secure link." footer={<Link to="/login" className="text-brand-700">Back to sign in</Link>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await post('/auth/forgot-password', { email: v.email }); setMsg({ tone: 'green', text: r.data.message }); }); }}>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Field label="Email" required><Input type="email" autoComplete="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Send reset link</Button>
      </form>
    </AuthLayout>);
  if (mode === 'reset') return (
    <AuthLayout title="Choose a new password">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/auth/reset-password', { token, password: v.password }); setMsg({ tone: 'green', text: 'Password updated. Please sign in.' }); setTimeout(() => nav('/login'), 1200); }); }}>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}{pw}
        <Button type="submit" className="w-full" loading={busy}>Update password</Button>
      </form>
    </AuthLayout>);
  if (mode === 'invite') return (
    <AuthLayout title={invite ? `Join ${invite.business}` : 'Accept invitation'} subtitle={invite?.email}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await post('/auth/accept-invite', { token, password: v.password, fullName: v.fullName }); const me = await acceptToken(r.data.accessToken); nav(homeFor(me)); }); }}>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {invite && <><Field label="Your name" required><Input value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} /></Field>{pw}
          <Button type="submit" className="w-full" loading={busy}>Accept and continue</Button></>}
      </form>
    </AuthLayout>);
  return (
    <AuthLayout title="Create your customer account" subtitle="Track visits, approve quotations and pay invoices online." footer={<Link to={`/portal/${slug}/login`} className="text-brand-700">Already registered? Sign in</Link>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await post('/auth/portal/register', { workspace: slug, ...v, phone: v.phone || undefined }); setMsg({ tone: 'green', text: r.data.message }); }); }}>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Field label="Full name" required><Input autoComplete="name" value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} /></Field>
        <Field label="Email" required hint="Use the email you gave the business so we can link your records."><Input type="email" autoComplete="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Field label="Phone"><Input type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
        {pw}
        <Button type="submit" className="w-full" loading={busy}>Create account</Button>
      </form>
    </AuthLayout>);
}
