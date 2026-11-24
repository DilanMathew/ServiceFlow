import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Inbox, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { get, post } from '@/lib/api';
import { useAction, useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime, localToIso } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DataTable, DescriptionList, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatusBadge, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';
import { BackLink, CustomerPicker, DocumentsPanel, Timeline, useSettingsLists, useTechnicians } from './shared';
import { PriorityBadge } from './WorkOrders';

function NewRequestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { feature, can } = useAuth();
  const { data: s } = useSettingsLists();
  const empty = { customerId: '', contactName: '', contactPhone: '', description: '', serviceCategoryId: '', priority: 'normal', preferredDate: '', source: 'phone', addressText: '' };
  const [v, setV] = useState<any>(empty);
  const [ai, setAi] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const { data: cust } = useQuery({ queryKey: ['customer', v.customerId], queryFn: async () => (await get(`/app/customers/${v.customerId}`)).data, enabled: !!v.customerId });
  const f = (k: string) => ({ value: v[k], onChange: (e: any) => setV({ ...v, [k]: e.target.value }) });
  const interpret = async () => {
    setBusy(true);
    try { const r = await post('/app/ai/interpret', { text: v.description }); setAi(r.data); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post('/app/requests', { ...v, customerId: v.customerId || null, serviceCategoryId: v.serviceCategoryId || null, preferredDate: v.preferredDate || null,
        contactName: v.contactName || undefined, contactPhone: v.contactPhone || null, addressText: v.addressText || null, addressId: v.addressId || null, aiAnalysis: ai ?? null });
      qc.invalidateQueries({ queryKey: ['/app/requests'] }); toast.success(`Request ${r.data.number} created`); onOpenChange(false); setV(empty); setAi(null); nav(`/app/requests/${r.data.id}`);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New service request" size="lg" footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={busy} disabled={v.description.trim().length < 5} onClick={submit}>Create request</Button></>}>
      <div className="space-y-4">
        <Field label="Existing customer" hint="Leave empty for a new enquiry; the customer is created when you convert it."><CustomerPicker value={v.customerId} onChange={(id) => setV({ ...v, customerId: id })} /></Field>
        {!v.customerId ? <div className="grid gap-3 sm:grid-cols-2"><Field label="Contact name" required><Input {...f('contactName')} /></Field><Field label="Phone" required><Input type="tel" {...f('contactPhone')} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input {...f('addressText')} /></Field></div>
          : <Field label="Service address"><Select {...f('addressId')} placeholder="Default" options={(cust?.addresses ?? []).map((a: any) => ({ value: a.id, label: `${a.label}: ${a.line1}` }))} /></Field>}
        <Field label="What does the customer need?" required><Textarea rows={3} {...f('description')} placeholder="e.g. My AC is leaking water and making noise" /></Field>
        {feature('ai') && can('ai.use') && <Button size="sm" variant="outline" loading={busy} disabled={v.description.trim().length < 5} onClick={interpret}><Sparkles />Interpret with AI</Button>}
        {ai && <Alert tone="blue" title="AI suggestion — confirm before applying" action={<Button size="sm" onClick={() => setV({ ...v, serviceCategoryId: ai.serviceCategoryId ?? v.serviceCategoryId, priority: ai.priority })}>Apply</Button>}>
          <p>{ai.summary}</p><p className="mt-1 text-xs">Category: <b>{ai.serviceCategory ?? 'unclear'}</b> · Equipment: <b>{ai.equipmentType ?? '—'}</b> · Priority: <b>{ai.priority}</b> ({ai.priorityReason})</p>
          {ai.missingInformation?.length > 0 && <p className="mt-1 text-xs">Ask the customer for: {ai.missingInformation.join('; ')}</p>}</Alert>}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Category" className="sm:col-span-2"><Select {...f('serviceCategoryId')} placeholder="—" options={(s?.serviceCategories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Priority"><Select {...f('priority')} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: titleCase(p) }))} /></Field>
          <Field label="Source"><Select {...f('source')} options={['phone', 'email', 'whatsapp', 'admin'].map((p) => ({ value: p, label: titleCase(p) }))} /></Field>
          <Field label="Preferred date" className="sm:col-span-2"><Input type="date" {...f('preferredDate')} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

function RequestList() {
  const nav = useNavigate();
  const { can, me } = useAuth();
  const { params, set, sort, toggleSort } = useListState();
  const { data, isLoading, error, refetch } = usePaged('/app/requests', params);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Service requests" description={<>Enquiries from the portal, public form, phone and WhatsApp. Public form: <a className="text-brand-700" href={`/r/${me?.tenant?.slug}`} target="_blank" rel="noreferrer">/r/{me?.tenant?.slug}</a></>}
        actions={can('requests.create') && <Button onClick={() => setOpen(true)}><Plus />New request</Button>} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} />
          <Select aria-label="Status" className="w-44" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses"
            options={[['new,under_review', 'Needs review'], ['new', 'New'], ['under_review', 'Under review'], ['approved', 'Approved'], ['converted', 'Converted'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled']].map(([value, label]) => ({ value, label }))} />
          <Select aria-label="Source" className="w-40" value={params.source ?? ''} onChange={(e) => set({ source: e.target.value })} placeholder="All sources" options={['portal', 'public_form', 'whatsapp', 'phone', 'email', 'admin'].map((s) => ({ value: s, label: titleCase(s) }))} />
        </div>
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
          onRowClick={(r: any) => nav(`/app/requests/${r.id}`)} empty={<EmptyState icon={Inbox} title="No service requests" />}
          columns={[
            { key: 'number', header: 'Request', sortable: true, cell: (r: any) => <div><p className="font-medium">{r.number}</p><p className="max-w-xs truncate text-xs text-slate-500">{r.description}</p></div> },
            { key: 'contact', header: 'Contact', cell: (r: any) => <div><p>{r.contact_name}</p><p className="text-xs text-slate-500">{r.contact_phone}</p></div> },
            { key: 'cat', header: 'Category', hideOnMobile: true, cell: (r: any) => r.category_name ?? '—' },
            { key: 'source', header: 'Source', hideOnMobile: true, cell: (r: any) => <Badge>{titleCase(r.source)}</Badge> },
            { key: 'priority', header: 'Priority', sortable: true, hideOnMobile: true, cell: (r: any) => <PriorityBadge p={r.priority} /> },
            { key: 'created', header: 'Received', sortable: true, hideOnMobile: true, cell: (r: any) => dateTime(r.created_at) },
            { key: 'status', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> },
          ]} />
      </Card>
      <NewRequestDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function RequestDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: r, isLoading, error, refetch } = useData<any>(['request', id], `/app/requests/${id}`);
  const { data: techs } = useTechnicians();
  const [conv, setConv] = useState<any>(null);
  const act = useAction((fn: () => Promise<any>) => fn(), { onSuccess: () => qc.invalidateQueries({ queryKey: ['request', id] }) });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const setStatus = async (status: string) => {
    let reason: string | undefined;
    if (['rejected', 'cancelled'].includes(status)) { const c = await confirm({ title: `${titleCase(status)} request?`, requireReason: true, danger: true, confirmLabel: titleCase(status) }); if (!c) return; reason = c.reason; }
    act.mutate(() => post(`/app/requests/${r.id}/status`, { status, reason }).then(() => toast.success(`Request ${status.replace('_', ' ')}`)));
  };
  const open = ['new', 'under_review', 'approved'].includes(r.status);
  return (
    <div>
      <PageHeader back={<BackLink to="/app/requests" label="Service requests" />} title={<span className="flex items-center gap-3">{r.number}<StatusBadge status={r.status} /><PriorityBadge p={r.priority} /></span>}
        description={`${titleCase(r.source)} · received ${dateTime(r.created_at)}`}
        actions={can('requests.review') && open && <>
          {r.status === 'new' && <Button variant="outline" onClick={() => setStatus('under_review')}>Start review</Button>}
          {r.status !== 'approved' && <Button variant="outline" onClick={() => setStatus('approved')}>Approve</Button>}
          {can('work_orders.create') && <Button onClick={() => setConv({ title: '', scheduledStart: '', technicianId: '' })}>Convert to job<ArrowRight /></Button>}
          <Button variant="danger-outline" onClick={() => setStatus('rejected')}>Reject</Button>
        </>} />
      {r.work_order_id && <div className="mb-4"><Alert tone="green" title="Converted" action={<Link to={`/app/work-orders/${r.work_order_id}`}><Button size="sm">Open {r.work_order_number}</Button></Link>}>This request became work order {r.work_order_number}.</Alert></div>}
      {r.rejection_reason && <div className="mb-4"><Alert tone="red" title="Reason">{r.rejection_reason}</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card><CardHeader title="Request" /><CardBody>
            <p className="whitespace-pre-line text-sm text-slate-800">{r.description}</p>
            <div className="mt-5"><DescriptionList items={[['Category', r.category_name], ['Equipment', r.asset_name], ['Preferred date', date(r.preferred_date)], ['Preferred time', titleCase(r.preferred_time_slot)],
              ['Address', r.address ? [r.address.line1, r.address.city, r.address.postal_code].filter(Boolean).join(', ') : r.address_text], ['Reviewed by', r.reviewed_by_name ? `${r.reviewed_by_name} · ${dateTime(r.reviewed_at)}` : '—']]} /></div>
            {r.ai_analysis && <div className="mt-5 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm"><p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase text-violet-800"><Sparkles className="h-3.5 w-3.5" />AI triage (suggestion)</p>
              <p>{r.ai_analysis.summary}</p>{r.ai_analysis.missingInformation?.length > 0 && <p className="mt-1 text-xs text-violet-900">Missing: {r.ai_analysis.missingInformation.join('; ')}</p>}</div>}
          </CardBody></Card>
          <DocumentsPanel entityType="service_request" entityId={r.id} title="Photos & attachments" />
        </div>
        <div className="space-y-6">
          <Card><CardHeader title="Contact" /><CardBody className="space-y-1 text-sm">
            {r.customer_id ? <Link to={`/app/customers/${r.customer_id}`} className="font-medium text-brand-700">{r.customer_name} ({r.customer_number})</Link> : <p className="font-medium">{r.contact_name} <Badge tone="amber">New lead</Badge></p>}
            {r.contact_phone && <p><a href={`tel:${r.contact_phone}`} className="text-brand-700">{r.contact_phone}</a></p>}{r.contact_email && <p>{r.contact_email}</p>}
          </CardBody></Card>
          <Card><CardHeader title="History" /><CardBody><Timeline items={r.history.map((h: any) => ({ title: titleCase(h.action.split('.')[1] ?? h.action), meta: `${dateTime(h.created_at)}${h.user_email ? ` · ${h.user_email}` : ''}`, body: h.after_data?.reason }))} /></CardBody></Card>
        </div>
      </div>
      <Dialog open={!!conv} onOpenChange={(o) => !o && setConv(null)} title="Convert to work order" description={!r.customer_id ? 'A customer record will be created from the contact details (or linked if one already exists).' : undefined}
        footer={<Button loading={act.isPending} onClick={() => act.mutate(() => post(`/app/requests/${r.id}/convert`, { title: conv.title || undefined, scheduledStart: conv.scheduledStart ? localToIso(conv.scheduledStart) : null,
          technicianId: conv.technicianId || null, force: true }).then((x) => { toast.success(`Job ${x.data.number} created`); nav(`/app/work-orders/${x.data.id}`); }))}>Create work order</Button>}>
        {conv && <div className="space-y-3"><Field label="Job title" hint="Defaults to category and description"><Input value={conv.title} onChange={(e) => setConv({ ...conv, title: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Schedule (optional)"><Input type="datetime-local" value={conv.scheduledStart} onChange={(e) => setConv({ ...conv, scheduledStart: e.target.value })} /></Field>
            <Field label="Technician (optional)"><Select value={conv.technicianId} onChange={(e) => setConv({ ...conv, technicianId: e.target.value })} placeholder="Later" disabled={!conv.scheduledStart}
              options={(techs ?? []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: t.full_name }))} /></Field></div></div>}
      </Dialog>
    </div>
  );
}

export default function Requests() { return <Routes><Route index element={<RequestList />} /><Route path=":id" element={<RequestDetail />} /></Routes>; }
