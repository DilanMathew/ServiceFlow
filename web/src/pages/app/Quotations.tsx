import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, FileDown, FileSignature, GitBranch, Plus, Receipt, Send } from 'lucide-react';
import { toast } from 'sonner';
import { get, openFile, post, put, del } from '@/lib/api';
import { useAction, useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime, money } from '@/lib/format';
import { Alert, Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatusBadge, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';
import { BackLink, CustomerPicker, ItemsTable, LineItemsEditor, Timeline, TotalsBlock, type Line } from './shared';

function QuoteEditor() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const editing = !!id;
  const { data: existing } = useData<any>(['quotation', id], editing ? `/app/quotations/${id}` : null);
  const [customerId, setCustomerId] = useState(sp.get('customerId') ?? '');
  const [meta, setMeta] = useState({ title: '', validUntil: '', notes: '', terms: '', workOrderId: sp.get('workOrderId') ?? '' });
  const [lines, setLines] = useState<Line[]>([{ itemType: 'labour', description: '', quantity: 1, unitPrice: 0, discountPercent: 0, taxRateId: undefined as any }]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (existing) { setCustomerId(existing.customer_id); setMeta({ title: existing.title ?? '', validUntil: existing.valid_until, notes: existing.notes ?? '', terms: existing.terms ?? '', workOrderId: existing.work_order_id ?? '' });
    setLines(existing.items.map((i: any) => ({ itemType: i.item_type, inventoryItemId: i.inventory_item_id, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), discountPercent: Number(i.discount_percent), taxRateId: i.tax_rate_id }))); } }, [existing]);
  const save = async () => {
    if (lines.some((l) => !l.description.trim() || l.quantity <= 0)) return toast.error('Every line needs a description and quantity');
    setBusy(true);
    const body = { title: meta.title || null, validUntil: meta.validUntil || null, notes: meta.notes || null, terms: meta.terms || null, workOrderId: meta.workOrderId || null, items: lines };
    try { const r = editing ? await put(`/app/quotations/${id}`, body) : await post('/app/quotations', { ...body, customerId }); toast.success('Quotation saved'); nav(`/app/quotations/${r.data.id}`); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader back={<BackLink to="/app/quotations" label="Quotations" />} title={editing ? `Edit ${existing?.number ?? ''}` : 'New quotation'} actions={<Button loading={busy} disabled={!customerId} onClick={save}>Save draft</Button>} />
      <div className="space-y-6">
        <Card><CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer" required className="sm:col-span-2"><CustomerPicker value={customerId} onChange={setCustomerId} disabled={editing} /></Field>
          <Field label="Title"><Input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} placeholder="e.g. Installation of 2 split ACs" /></Field>
          <Field label="Valid until" hint="Defaults to your validity setting"><Input type="date" value={meta.validUntil} onChange={(e) => setMeta({ ...meta, validUntil: e.target.value })} /></Field>
        </CardBody></Card>
        <Card><CardHeader title="Line items" description="Labour, parts and additional charges" /><CardBody><LineItemsEditor lines={lines} setLines={setLines} /></CardBody></Card>
        <Card><CardBody className="grid gap-4 sm:grid-cols-2"><Field label="Notes to customer"><Textarea rows={3} value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} /></Field>
          <Field label="Terms" hint="Defaults from settings"><Textarea rows={3} value={meta.terms} onChange={(e) => setMeta({ ...meta, terms: e.target.value })} /></Field></CardBody></Card>
      </div>
    </div>
  );
}

function QuoteList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { params, set, sort, toggleSort } = useListState();
  const { data, isLoading, error, refetch } = usePaged('/app/quotations', params);
  return (
    <div>
      <PageHeader title="Quotations" description="Estimates with approval tracking and revision history." actions={can('quotations.manage') && <Button onClick={() => nav('/app/quotations/new')}><Plus />New quotation</Button>} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4"><SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} />
          <Select aria-label="Status" className="w-40" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={['draft', 'sent', 'viewed', 'approved', 'rejected', 'expired', 'converted'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} /></div>
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
          onRowClick={(r: any) => nav(`/app/quotations/${r.id}`)} empty={<EmptyState icon={FileSignature} title="No quotations" />} columns={[
            { key: 'number', header: 'Quotation', sortable: true, cell: (r: any) => <div><p className="font-medium">{r.number}{r.revision > 1 && <span className="text-slate-500"> · R{r.revision}</span>}</p><p className="text-xs text-slate-500">{r.title}</p></div> },
            { key: 'c', header: 'Customer', cell: (r: any) => r.customer_name }, { key: 'issued', header: 'Date', sortable: true, hideOnMobile: true, cell: (r: any) => date(r.issue_date) },
            { key: 'valid', header: 'Valid until', sortable: true, hideOnMobile: true, cell: (r: any) => date(r.valid_until) },
            { key: 'total', header: 'Total', sortable: true, className: 'text-right', cell: (r: any) => <span className="tabular">{money(r.total, r.currency)}</span> },
            { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} />
      </Card>
    </div>
  );
}

function QuoteDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: q, isLoading, error, refetch } = useData<any>(['quotation', id], `/app/quotations/${id}`);
  const [approve, setApprove] = useState<string | null>(null);
  const act = useAction((fn: () => Promise<any>) => fn(), { onSuccess: () => { qc.invalidateQueries({ queryKey: ['quotation', id] }); qc.invalidateQueries({ queryKey: ['/app/quotations'] }); } });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const publicUrl = `${location.origin}/q/view/${q.public_token}`;
  return (
    <div>
      <PageHeader back={<BackLink to="/app/quotations" label="Quotations" />} title={<span className="flex items-center gap-3">{q.number}{q.revision > 1 && <span className="text-slate-400">R{q.revision}</span>}<StatusBadge status={q.status} /></span>}
        description={<><Link to={`/app/customers/${q.customer_id}`} className="text-brand-700">{q.customer_name}</Link> · {money(q.total, q.currency)} · valid until {date(q.valid_until)}</>}
        actions={<>
          <Button variant="outline" onClick={() => openFile(`/app/quotations/${q.id}/pdf`).catch(toastError)}><FileDown />PDF</Button>
          {can('quotations.manage') && q.status === 'draft' && <><Button variant="outline" onClick={() => nav(`/app/quotations/${q.id}/edit`)}>Edit</Button>
            <Button onClick={() => act.mutate(() => post(`/app/quotations/${q.id}/send`).then(() => toast.success('Quotation sent to customer')))}><Send />Send</Button></>}
          {can('quotations.manage') && ['sent', 'viewed'].includes(q.status) && <Button variant="outline" onClick={() => act.mutate(() => post(`/app/quotations/${q.id}/send`).then(() => toast.success('Resent')))}><Send />Resend</Button>}
          {can('quotations.approve', 'quotations.manage') && ['sent', 'viewed'].includes(q.status) && <><Button onClick={() => setApprove('')}>Record approval</Button>
            <Button variant="danger-outline" onClick={async () => { const r = await confirm({ title: 'Record rejection', requireReason: true, danger: true, confirmLabel: 'Reject' }); if (r) act.mutate(() => post(`/app/quotations/${q.id}/reject`, { reason: r.reason })); }}>Rejected</Button></>}
          {q.status === 'approved' && can('invoices.manage') && !q.invoice_id && <Button variant="navy" onClick={() => act.mutate(() => post('/app/invoices', { quotationId: q.id }).then((r) => nav(`/app/invoices/${r.data.id}`)))}><Receipt />Convert to invoice</Button>}
          {can('quotations.manage') && ['sent', 'viewed', 'approved', 'rejected', 'expired'].includes(q.status) && q.revisions.at(-1)?.id === q.id && <Button variant="outline" onClick={async () => {
            const r = await confirm({ title: 'Create a revision?', description: 'The current version is preserved as superseded and a new editable draft is created.', requireReason: true, reasonLabel: 'Reason for revision', confirmLabel: 'Create revision' });
            if (r) act.mutate(() => post(`/app/quotations/${q.id}/revise`, { reason: r.reason }).then((x) => nav(`/app/quotations/${x.data.id}/edit`))); }}><GitBranch />Revise</Button>}
          {q.status === 'draft' && can('quotations.manage') && <Button variant="ghost" onClick={async () => { if (await confirm({ title: 'Delete draft?', danger: true, confirmLabel: 'Delete' })) act.mutate(() => del(`/app/quotations/${q.id}`).then(() => nav('/app/quotations'))); }}>Delete</Button>}
        </>} />
      {q.status === 'approved' && <div className="mb-4"><Alert tone="green" title="Approved">By {q.approved_by_name} on {dateTime(q.approved_at)}. Approved quotations are locked — create a revision to change them.</Alert></div>}
      {q.status === 'rejected' && <div className="mb-4"><Alert tone="red" title="Rejected">{q.rejection_reason}</Alert></div>}
      {q.invoice_id && <div className="mb-4"><Alert tone="blue" action={<Link to={`/app/invoices/${q.invoice_id}`}><Button size="sm">Open invoice</Button></Link>}>Converted to an invoice.</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title={q.title ?? 'Items'} /><CardBody><ItemsTable items={q.items} currency={q.currency} /><TotalsBlock d={q} />
          {q.notes && <p className="mt-6 whitespace-pre-line text-sm text-slate-600">{q.notes}</p>}{q.terms && <p className="mt-3 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{q.terms}</p>}</CardBody></Card>
        <div className="space-y-6">
          {q.status !== 'draft' && <Card><CardHeader title="Customer link" description="Customer can view, approve or decline online" /><CardBody className="flex gap-2"><Input readOnly value={publicUrl} aria-label="Public link" />
            <Button size="icon" variant="outline" aria-label="Copy link" onClick={() => navigator.clipboard.writeText(publicUrl).then(() => toast.success('Link copied'))}><Copy /></Button></CardBody></Card>}
          <Card><CardHeader title="Tracking" /><CardBody><Timeline items={[{ title: 'Created', meta: dateTime(q.created_at) }, ...(q.sent_at ? [{ title: 'Sent', meta: dateTime(q.sent_at) }] : []),
            ...(q.viewed_at ? [{ title: 'Viewed by customer', meta: dateTime(q.viewed_at) }] : []), ...(q.approved_at ? [{ title: 'Approved', meta: `${dateTime(q.approved_at)} · ${q.approved_by_name}` }] : []),
            ...(q.rejected_at ? [{ title: 'Rejected', meta: dateTime(q.rejected_at) }] : [])]} /></CardBody></Card>
          {q.revisions.length > 1 && <Card><CardHeader title="Revision history" /><ul className="divide-y divide-slate-100 text-sm">{q.revisions.map((r: any) => (
            <li key={r.id}><Link to={`/app/quotations/${r.id}`} className={`flex items-center justify-between px-5 py-2.5 hover:bg-slate-50 ${r.id === q.id ? 'bg-brand-50' : ''}`}>
              <span>Revision {r.revision} · {money(r.total, q.currency)}{r.revision_reason && <span className="block text-xs text-slate-500">{r.revision_reason}</span>}</span><StatusBadge status={r.status} /></Link></li>))}</ul></Card>}
        </div>
      </div>
      <Dialog open={approve !== null} onOpenChange={(o) => !o && setApprove(null)} title="Record customer approval" description="Use when the customer approved by phone, email or in person."
        footer={<Button disabled={!approve || approve.trim().length < 2} onClick={() => act.mutate(() => post(`/app/quotations/${q.id}/approve`, { approvedByName: approve }).then(() => setApprove(null)))}>Record approval</Button>}>
        <Field label="Approved by (name)" hint={`Recorded by ${me?.user.full_name}`}><Input value={approve ?? ''} onChange={(e) => setApprove(e.target.value)} /></Field>
      </Dialog>
    </div>
  );
}
export default function Quotations() { return <Routes><Route index element={<QuoteList />} /><Route path="new" element={<QuoteEditor />} /><Route path=":id/edit" element={<QuoteEditor />} /><Route path=":id" element={<QuoteDetail />} /></Routes>; }
export { get };
