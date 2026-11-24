import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { del, post, put } from '@/lib/api';
import { useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Tabs, Textarea } from '@/components/ui';
import { toastError } from '@/components/form';

export default function Communications() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState('logs');
  const { params, set } = useListState();
  const { data, isLoading, error, refetch } = usePaged<any>('/app/notifications/logs', { ...params, tab: undefined }, tab === 'logs');
  const { data: tpl } = useData<any>(['templates'], tab === 'templates' ? '/app/notifications/templates' : null);
  const [edit, setEdit] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [view, setView] = useState<any>(null);
  const stats = (data as any)?.stats as any[] | undefined;
  return (
    <div>
      <PageHeader title="Communications" description="Email, WhatsApp, SMS and in-app notifications. Notifications never block business transactions; failures are retried automatically." />
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'logs', label: 'Delivery log' }, { value: 'templates', label: 'Templates' }]} />
      <div className="mt-5">
        {tab === 'logs' && <>
          {stats && <div className="mb-4 flex flex-wrap gap-2">{['email', 'whatsapp', 'sms'].map((ch) => { const s = stats.filter((x) => x.channel === ch); const t = s.reduce((a, x) => a + x.n, 0); const f = s.find((x) => x.status === 'failed')?.n ?? 0;
            return <Card key={ch} className="px-4 py-3 text-sm"><span className="font-medium">{titleCase(ch)}</span> <span className="text-slate-500">· {t} in 30 days</span>{f > 0 && <Badge tone="red" className="ml-2">{f} failed</Badge>}</Card>; })}</div>}
          <Card>
            <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
              <Select aria-label="Channel" className="w-36" value={params.channel ?? ''} onChange={(e) => set({ channel: e.target.value })} placeholder="All channels" options={['email', 'whatsapp', 'sms'].map((s) => ({ value: s, label: titleCase(s) }))} />
              <Select aria-label="Status" className="w-36" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={['queued', 'sent', 'delivered', 'failed', 'skipped'].map((s) => ({ value: s, label: titleCase(s) }))} />
            </div>
            <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} onRowClick={(r: any) => setView(r)} empty={<EmptyState title="No notifications yet" />} columns={[
              { key: 'd', header: 'Created', cell: (r: any) => dateTime(r.created_at) }, { key: 'e', header: 'Event', cell: (r: any) => titleCase(r.event.replace('.', ' ')) },
              { key: 'c', header: 'Channel', cell: (r: any) => <Badge>{titleCase(r.channel)}</Badge> }, { key: 'r', header: 'Recipient', cell: (r: any) => <div><p>{r.customer_name ?? ''}</p><p className="text-xs text-slate-500">{r.recipient}</p></div> },
              { key: 's', header: 'Status', cell: (r: any) => <div><StatusBadge status={r.status} />{r.attempts > 1 && <span className="ml-1 text-xs text-slate-500">{r.attempts} attempts</span>}{r.last_error && <p className="max-w-[220px] truncate text-xs text-red-600">{r.last_error}</p>}</div> },
              { key: 'x', header: '', cell: (r: any) => ['failed', 'skipped'].includes(r.status) && can('communications.manage') && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); post(`/app/notifications/logs/${r.id}/retry`).then(() => { toast.success('Queued for retry'); refetch(); }).catch(toastError); }}><RotateCw />Retry</Button> }]} />
          </Card></>}
        {tab === 'templates' && tpl && <Card><CardHeader title="Message templates" description={`Variables: ${tpl.meta?.variables?.map((v: string) => `{{${v}}}`).join(' ') ?? ''}`} />
          <DataTable rows={tpl.data ?? tpl} columns={[{ key: 'e', header: 'Event', cell: (r: any) => titleCase(r.event.replace('.', ' · ')) }, { key: 'c', header: 'Channel', cell: (r: any) => <Badge>{titleCase(r.channel)}</Badge> },
            { key: 'b', header: 'Message', cell: (r: any) => <p className="max-w-md truncate text-xs text-slate-600">{r.subject ? `${r.subject} — ` : ''}{r.body}</p> },
            { key: 's', header: '', cell: (r: any) => r.customised ? <Badge tone="blue">Customised</Badge> : <Badge>Default</Badge> },
            { key: 'x', header: '', cell: (r: any) => can('communications.manage') && <Button size="sm" variant="ghost" onClick={() => setEdit({ event: r.event, channel: r.channel, subject: r.subject ?? '', body: r.body, whatsappTemplateName: r.whatsapp_template_name ?? '', isActive: r.is_active, customised: r.customised })}>Edit</Button> }]} /></Card>}
      </div>
      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)} title="Notification" size="lg">{view && <div className="space-y-2 text-sm"><p><b>To:</b> {view.recipient}</p>{view.subject && <p><b>Subject:</b> {view.subject}</p>}
        <p className="whitespace-pre-line rounded-lg bg-slate-50 p-3">{view.body ?? '(open log for body)'}</p>{view.last_error && <Alert tone="red">{view.last_error}</Alert>}</div>}</Dialog>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit ? `${titleCase(edit.event)} · ${titleCase(edit.channel)}` : ''} size="lg"
        footer={<>{edit?.customised && <Button variant="ghost" onClick={() => del(`/app/notifications/templates/${edit.event}/${edit.channel}`).then(() => { setEdit(null); qc.invalidateQueries({ queryKey: ['templates'] }); toast.success('Reset to default'); }).catch(toastError)}>Reset to default</Button>}
          <Button variant="outline" onClick={() => post('/app/notifications/templates/preview', { subject: edit.subject, body: edit.body }).then((r) => setPreview(r.data)).catch(toastError)}>Preview</Button>
          <Button onClick={() => put('/app/notifications/templates', { event: edit.event, channel: edit.channel, subject: edit.subject || null, body: edit.body, whatsappTemplateName: edit.whatsappTemplateName || null, isActive: edit.isActive })
            .then(() => { setEdit(null); qc.invalidateQueries({ queryKey: ['templates'] }); toast.success('Template saved'); }).catch(toastError)}>Save</Button></>}>
        {edit && <div className="space-y-3">{edit.channel === 'email' && <Field label="Subject"><Input value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>}
          <Field label="Message"><Textarea rows={6} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
          {edit.channel === 'whatsapp' && <Field label="Approved WhatsApp template name" hint="Business-initiated WhatsApp messages must use a template pre-approved in Meta WhatsApp Manager."><Input value={edit.whatsappTemplateName} onChange={(e) => setEdit({ ...edit, whatsappTemplateName: e.target.value })} /></Field>}
          <Checkbox label="Active" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} />
          {preview && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">{preview.subject && <p className="font-semibold">{preview.subject}</p>}<p className="whitespace-pre-line">{preview.body}</p></div>}</div>}
      </Dialog>
    </div>
  );
}
