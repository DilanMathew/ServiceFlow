import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Copy, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useData } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, ErrorState, Field, Input, PageHeader, PageLoader, Select, StatusBadge } from '@/components/ui';
import { toastError } from '@/components/form';

const LABEL: Record<string, string> = { email: 'Email', whatsapp: 'WhatsApp Business', sms: 'SMS', payment: 'Payment gateway', maps: 'Maps & geocoding', ai: 'AI assistant', storage: 'File storage', einvoice: 'E-invoicing (India IRN)', peppol: 'Peppol e-invoicing (EU)' };

export default function Integrations() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useData<any[]>(['integrations'], '/app/integrations');
  const [edit, setEdit] = useState<any>(null);
  const [test, setTest] = useState<any>(null);
  const { me } = useAuth();
  const india = me?.tenant?.country === 'IN';
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const save = () => put(`/app/integrations/${edit.kind}`, { provider: edit.provider, mode: edit.mode, enabled: edit.enabled, config: edit.config, secrets: edit.secrets })
    .then(() => { toast.success('Integration saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['integrations'] }); }).catch(toastError);
  return (
    <div>
      <PageHeader title="Integrations" description="Connect your own providers. Secrets are encrypted at rest and never shown again after saving. Every integration has a test mode." />
      <div className="grid gap-4 md:grid-cols-2">
        {data!.filter((i) => (i.kind === 'einvoice' ? india : i.kind === 'peppol' ? !india : true)).map((i) => (
          <Card key={i.kind}><CardHeader title={LABEL[i.kind] ?? titleCase(i.kind)} description={i.current ? i.providers.find((p: any) => p.provider === i.current.provider)?.label : 'Not configured'}
            actions={i.current && <div className="flex gap-1">{i.current.mode === 'test' && <Badge tone="amber">Test mode</Badge>}<StatusBadge status={i.current.enabled ? i.current.status : 'inactive'} label={i.current.enabled ? undefined : 'Disabled'} /></div>} />
            <CardBody className="space-y-3 text-sm">
              {i.current?.lastError && <Alert tone="red">{i.current.lastError}</Alert>}
              {i.current?.lastCheckedAt && <p className="flex items-center gap-1 text-xs text-slate-500">{i.current.status === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <CircleAlert className="h-3.5 w-3.5" />}Last checked {dateTime(i.current.lastCheckedAt)}</p>}
              {i.webhookUrl && <div><p className="text-xs font-medium text-slate-500">Webhook URL</p><div className="mt-1 flex gap-2"><Input readOnly value={i.webhookUrl} className="h-8 text-xs" aria-label="Webhook URL" />
                <Button size="icon-sm" variant="outline" aria-label="Copy" onClick={() => navigator.clipboard.writeText(i.webhookUrl).then(() => toast.success('Copied'))}><Copy /></Button></div></div>}
              <div className="flex gap-2">{!['ai', 'storage'].includes(i.kind) && <Button size="sm" onClick={() => { const p = i.current?.provider ?? i.providers[0].provider; setEdit({ kind: i.kind, provider: p, mode: i.current?.mode ?? 'test', enabled: i.current?.enabled ?? true,
                config: i.current?.config ?? {}, secrets: {}, secretsSet: i.current?.secretsSet ?? [], providers: i.providers }); }}><Plug />{i.current ? 'Configure' : 'Connect'}</Button>}
                {i.current?.enabled && ['email', 'whatsapp', 'sms', 'maps'].includes(i.kind) && <Button size="sm" variant="outline" onClick={() => setTest({ kind: i.kind, to: '' })}>Send test</Button>}</div>
              {['ai', 'storage'].includes(i.kind) && <p className="text-xs text-slate-500">{i.providers[0].docs}</p>}
            </CardBody></Card>))}
      </div>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit ? `Configure ${LABEL[edit.kind]}` : ''} size="lg" footer={<Button onClick={save}>Save</Button>}>
        {edit && (() => { const def = edit.providers.find((p: any) => p.provider === edit.provider); return (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><Field label="Provider"><Select value={edit.provider} onChange={(e) => setEdit({ ...edit, provider: e.target.value, config: {}, secrets: {} })} options={edit.providers.map((p: any) => ({ value: p.provider, label: p.label }))} /></Field>
              <Field label="Mode" hint="Test mode never contacts real providers or moves money"><Select value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })} options={[{ value: 'test', label: 'Test / sandbox' }, { value: 'live', label: 'Live' }]} /></Field></div>
            <p className="text-xs text-slate-500">{def?.docs}</p>
            {def?.config.map((k: string) => <Field key={k} label={titleCase(k.replace(/([A-Z])/g, '_$1'))}><Input value={edit.config[k] ?? ''} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, [k]: e.target.value } })} /></Field>)}
            {def?.secrets.map((k: string) => <Field key={k} label={titleCase(k.replace(/([A-Z])/g, '_$1'))} hint={edit.secretsSet.includes(k) ? 'Saved — leave blank to keep the current value' : 'Stored encrypted; never displayed again'}>
              <Input type="password" autoComplete="off" placeholder={edit.secretsSet.includes(k) ? '••••••••' : ''} value={edit.secrets[k] ?? ''} onChange={(e) => setEdit({ ...edit, secrets: { ...edit.secrets, [k]: e.target.value } })} /></Field>)}
            <Checkbox label="Enabled" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />
          </div>); })()}
      </Dialog>
      <Dialog open={!!test} onOpenChange={(o) => !o && setTest(null)} title="Send a test" footer={<Button onClick={() => post(`/app/integrations/${test.kind}/test`, { to: test.to || undefined }).then(() => { toast.success('Test succeeded'); setTest(null); refetch(); }).catch((e) => { toastError(e); refetch(); })}>Send</Button>}>
        {test && <Field label={test.kind === 'email' ? 'Email (defaults to yours)' : test.kind === 'maps' ? 'Address to geocode' : 'Phone number with country code'}><Input value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} /></Field>}
      </Dialog>
    </div>
  );
}
