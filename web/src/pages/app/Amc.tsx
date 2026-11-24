import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCcw, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { get, patch, post } from '@/lib/api';
import { useAction, useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, money } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, DataTable, DescriptionList, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatCard, StatusBadge, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';
import { BackLink, CustomerPicker, DocumentsPanel, useSettingsLists } from './shared';

const FREQ = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['half_yearly', 'Half-yearly'], ['annual', 'Annual']].map(([value, label]) => ({ value, label }));

function AmcForm({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const nav = useNavigate();
  const { data: s } = useSettingsLists();
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = new Date(Date.now() + 364 * 864e5).toISOString().slice(0, 10);
  const [v, setV] = useState<any>({ customerId: '', title: 'Annual maintenance contract', startDate: today, endDate: yearEnd, frequency: 'quarterly', visitsIncluded: '', contractValue: '', serviceCategoryId: '', addressId: '', coverage: '', exclusions: '', autoRenew: false, assetIds: [] as string[] });
  const { data: cust } = useQuery({ queryKey: ['customer', v.customerId], queryFn: async () => (await get(`/app/customers/${v.customerId}`)).data, enabled: !!v.customerId });
  const [busy, setBusy] = useState(false);
  const f = (k: string) => ({ value: v[k], onChange: (e: any) => setV({ ...v, [k]: e.target.value }) });
  const submit = async () => {
    setBusy(true);
    try { const r = await post('/app/amc', { ...v, visitsIncluded: v.visitsIncluded ? Number(v.visitsIncluded) : undefined, contractValue: Number(v.contractValue || 0), serviceCategoryId: v.serviceCategoryId || null, addressId: v.addressId || null, coverage: v.coverage || null, exclusions: v.exclusions || null });
      toast.success(`Contract ${r.data.number} created as draft`); onOpenChange(false); nav(`/app/amc/${r.data.id}`); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New AMC contract" size="lg" footer={<Button loading={busy} disabled={!v.customerId} onClick={submit}>Create draft</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer" required className="sm:col-span-2"><CustomerPicker value={v.customerId} onChange={(id) => setV({ ...v, customerId: id, assetIds: [], addressId: '' })} /></Field>
        <Field label="Title" className="sm:col-span-2"><Input {...f('title')} /></Field>
        <Field label="Start date"><Input type="date" {...f('startDate')} /></Field><Field label="End date"><Input type="date" {...f('endDate')} /></Field>
        <Field label="Visit frequency"><Select {...f('frequency')} options={FREQ} /></Field><Field label="Visits included" hint="Defaults from frequency"><Input type="number" min={1} {...f('visitsIncluded')} /></Field>
        <Field label="Contract value"><Input type="number" min={0} step="0.01" {...f('contractValue')} /></Field>
        <Field label="Service category"><Select {...f('serviceCategoryId')} placeholder="—" options={(s?.serviceCategories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
        {cust && <><Field label="Site"><Select {...f('addressId')} placeholder="Default" options={cust.addresses.map((a: any) => ({ value: a.id, label: `${a.label}: ${a.line1}` }))} /></Field>
          <Field label="Covered equipment"><div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">{cust.assets.length ? cust.assets.map((a: any) => <Checkbox key={a.id} label={`${a.name} · ${a.number}`} checked={v.assetIds.includes(a.id)}
            onChange={(e) => setV({ ...v, assetIds: e.target.checked ? [...v.assetIds, a.id] : v.assetIds.filter((x: string) => x !== a.id) })} />) : <p className="text-xs text-slate-500">No equipment registered</p>}</div></Field></>}
        <Field label="Coverage"><Textarea rows={2} {...f('coverage')} /></Field><Field label="Exclusions"><Textarea rows={2} {...f('exclusions')} /></Field>
        <Checkbox label="Auto-renew reminder" checked={v.autoRenew} onChange={(e) => setV({ ...v, autoRenew: e.target.checked })} />
      </div>
    </Dialog>
  );
}

function AmcList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { params, set, sort, toggleSort } = useListState();
  const { data, isLoading, error, refetch } = usePaged('/app/amc', { ...params, expiringDays: params.expiring ? 60 : undefined, expiring: undefined });
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="AMC contracts" description="Recurring maintenance with automatic visit scheduling and renewals." actions={can('amc.manage') && <Button onClick={() => setOpen(true)}><Plus />New contract</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4"><SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} />
          <Select aria-label="Status" className="w-40" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={['draft', 'active', 'expired', 'renewed', 'cancelled'].map((s) => ({ value: s, label: titleCase(s) }))} />
          <Checkbox label="Due for renewal (60 days)" checked={!!params.expiring} onChange={(e) => set({ expiring: e.target.checked ? '1' : '' })} /></div>
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
          onRowClick={(r: any) => nav(`/app/amc/${r.id}`)} empty={<EmptyState icon={ScrollText} title="No contracts" />} columns={[
            { key: 'number', header: 'Contract', sortable: true, cell: (r: any) => <div><p className="font-medium">{r.number}</p><p className="text-xs text-slate-500">{r.title}</p></div> },
            { key: 'c', header: 'Customer', cell: (r: any) => r.customer_name }, { key: 'end', header: 'Period', sortable: true, hideOnMobile: true, cell: (r: any) => `${date(r.start_date)} – ${date(r.end_date)}` },
            { key: 'v', header: 'Visits', cell: (r: any) => `${r.visits_completed}/${r.visits_included}` }, { key: 'n', header: 'Next visit', hideOnMobile: true, cell: (r: any) => date(r.next_visit) },
            { key: 'value', header: 'Value', sortable: true, className: 'text-right', cell: (r: any) => money(r.contract_value, r.currency) },
            { key: 's', header: 'Status', cell: (r: any) => <div className="flex gap-1"><StatusBadge status={r.status} />{r.status === 'active' && <StatusBadge status={r.payment_status === 'paid' ? 'paid' : 'pending'} label={titleCase(r.payment_status)} />}</div> }]} />
      </Card>
      <AmcForm open={open} onOpenChange={setOpen} />
    </div>
  );
}

function AmcDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: m, isLoading, error, refetch } = useData<any>(['amc', id], `/app/amc/${id}`);
  const [activate, setActivate] = useState<any>(null);
  const act = useAction((fn: () => Promise<any>) => fn(), { onSuccess: () => qc.invalidateQueries({ queryKey: ['amc', id] }) });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div>
      <PageHeader back={<BackLink to="/app/amc" label="AMC contracts" />} title={<span className="flex items-center gap-3">{m.number}<StatusBadge status={m.status} /></span>}
        description={<><Link className="text-brand-700" to={`/app/customers/${m.customer_id}`}>{m.customer_name}</Link> · {m.title}</>}
        actions={can('amc.manage') && <>
          {m.status === 'draft' && <Button onClick={() => setActivate({ createInvoice: true, issueInvoice: false })}>Activate</Button>}
          {['active', 'expired'].includes(m.status) && !m.renewal_id && <Button variant="outline" onClick={() => act.mutate(() => post(`/app/amc/${m.id}/renew`, {}).then((r) => { toast.success('Renewal draft and quotation created'); nav(`/app/amc/${r.data.renewal.id}`); }))}><RefreshCcw />Renew</Button>}
          {['draft', 'active'].includes(m.status) && <Button variant="danger-outline" onClick={async () => { const r = await confirm({ title: 'Cancel contract?', description: 'Remaining scheduled visits are cancelled.', requireReason: true, danger: true }); if (r) act.mutate(() => post(`/app/amc/${m.id}/cancel`, { reason: r.reason })); }}>Cancel</Button>}
        </>} />
      {m.renewal_id && <div className="mb-4"><Alert tone="blue" action={<Link to={`/app/amc/${m.renewal_id}`}><Button size="sm">Open renewal</Button></Link>}>A renewal contract exists.</Alert></div>}
      {m.renewed_from_number && <div className="mb-4"><Alert tone="blue">Renewal of {m.renewed_from_number}.</Alert></div>}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4"><StatCard label="Contract value" value={money(m.contract_value, m.currency)} hint={titleCase(m.payment_status)} />
        <StatCard label="Visits completed" value={`${m.visitsCompleted}/${m.visits_included}`} tone="green" /><StatCard label="Visits remaining" value={m.visitsRemaining} tone="violet" /><StatCard label="Ends" value={date(m.end_date)} tone="amber" /></div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="Visit schedule" description="Work orders are created automatically 14 days before each due date" />
          <DataTable rows={m.visits} empty={<EmptyState title="Visits are generated on activation" />} columns={[{ key: 'n', header: '#', cell: (v: any) => v.visit_number }, { key: 'd', header: 'Due', cell: (v: any) => date(v.due_date) },
            { key: 'w', header: 'Work order', cell: (v: any) => v.work_order_id ? <Link className="text-brand-700" to={`/app/work-orders/${v.work_order_id}`}>{v.work_order_number}</Link> : '—' },
            { key: 's', header: 'Status', cell: (v: any) => <StatusBadge status={v.status} /> },
            { key: 'x', header: '', cell: (v: any) => v.status === 'scheduled' && m.status === 'active' && can('amc.manage') && <Button size="sm" variant="ghost" onClick={() => act.mutate(() => post(`/app/amc/visits/${v.id}/work-order`).then((r) => nav(`/app/work-orders/${r.data.id}`)))}>Create job</Button> }]} /></Card>
        <div className="space-y-6">
          <Card><CardHeader title="Terms" /><CardBody><DescriptionList cols={1} items={[['Period', `${date(m.start_date)} – ${date(m.end_date)}`], ['Frequency', titleCase(m.frequency)], ['Category', m.category_name],
            ['Site', m.address ? [m.address.line1, m.address.city].filter(Boolean).join(', ') : '—'], ['Auto renew', m.auto_renew ? 'Yes' : 'No'], ['Coverage', m.coverage], ['Exclusions', m.exclusions]]} /></CardBody></Card>
          <Card><CardHeader title="Covered equipment" /><ul className="divide-y divide-slate-100 text-sm">{m.assets.length ? m.assets.map((a: any) => <li key={a.id}><Link to={`/app/assets/${a.id}`} className="block px-5 py-2.5 text-brand-700">{a.name} · {a.number}</Link></li>) : <li className="px-5 py-3 text-slate-500">All equipment at the site</li>}</ul></Card>
          {(m.invoices.length > 0 || m.quotations.length > 0) && <Card><CardHeader title="Billing" /><ul className="divide-y divide-slate-100 text-sm">
            {m.invoices.map((i: any) => <li key={i.id}><Link to={`/app/invoices/${i.id}`} className="flex justify-between px-5 py-2.5 hover:bg-slate-50"><span>Invoice {i.number ?? 'draft'}</span><StatusBadge status={i.status} /></Link></li>)}
            {m.quotations.map((q: any) => <li key={q.id}><Link to={`/app/quotations/${q.id}`} className="flex justify-between px-5 py-2.5 hover:bg-slate-50"><span>Quotation {q.number}</span><StatusBadge status={q.status} /></Link></li>)}</ul></Card>}
        </div>
        <div className="lg:col-span-3"><DocumentsPanel entityType="amc_contract" entityId={m.id} title="Contract documents" /></div>
      </div>
      <Dialog open={!!activate} onOpenChange={(o) => !o && setActivate(null)} title="Activate contract" description="Generates the visit schedule. Visit generation is idempotent and never duplicates."
        footer={<Button onClick={() => act.mutate(() => post(`/app/amc/${m.id}/activate`, activate).then((r) => { setActivate(null); toast.success(`${r.data.visitsGenerated} visits scheduled`); }))}>Activate</Button>}>
        {activate && <div className="space-y-2"><Checkbox label="Create contract invoice" checked={activate.createInvoice} onChange={(e) => setActivate({ ...activate, createInvoice: e.target.checked })} />
          {activate.createInvoice && <Checkbox label="Issue the invoice immediately" checked={activate.issueInvoice} onChange={(e) => setActivate({ ...activate, issueInvoice: e.target.checked })} />}</div>}
      </Dialog>
    </div>
  );
}
export default function Amc() { return <Routes><Route index element={<AmcList />} /><Route path=":id" element={<AmcDetail />} /></Routes>; }
export { patch };
