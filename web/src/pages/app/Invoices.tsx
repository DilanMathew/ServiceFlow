import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Copy, CreditCard, Download, FileDown, Link2, Plus, Receipt, RotateCcw, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api, del, newIdempotencyKey, openFile, post, put } from '@/lib/api';
import { useAction, useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime, localToIso, money } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatCard, StatusBadge, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';
import { BackLink, CustomerPicker, ItemsTable, LineItemsEditor, TotalsBlock, type Line } from './shared';
import { EInvoicePanel } from './EInvoicePanel';

export function RecordPaymentDialog({ invoice, open, onOpenChange, onDone }: { invoice: any; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [v, setV] = useState({ amount: '', method: 'upi', reference: '', receivedAt: '', status: 'succeeded', notes: '' });
  const [key, setKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setV({ amount: String(invoice.balance_due), method: 'upi', reference: '', receivedAt: '', status: 'succeeded', notes: '' }); setKey(newIdempotencyKey()); } }, [open]); // eslint-disable-line
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/app/payments', { method: 'POST', headers: { 'Idempotency-Key': key }, body: { invoiceId: invoice.id, amount: Number(v.amount), method: v.method, reference: v.reference || null,
        receivedAt: v.receivedAt ? localToIso(v.receivedAt) : null, status: v.method === 'cheque' ? v.status : 'succeeded', notes: v.notes || null } });
      toast.success(r.meta?.duplicate ? 'This payment was already recorded' : 'Payment recorded'); onOpenChange(false); onDone();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Record payment — ${invoice.number}`} description={`Balance due ${money(invoice.balance_due, invoice.currency)}. Payments cannot exceed the balance.`}
      footer={<Button loading={busy} disabled={!(Number(v.amount) > 0)} onClick={submit}>Record payment</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" required><Input type="number" min={0.01} step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Method"><Select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} options={['upi', 'cash', 'bank_transfer', 'card', 'cheque', 'other'].map((m) => ({ value: m, label: titleCase(m) }))} /></Field>
        <Field label="Reference" hint="UTR / transaction / cheque no."><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
        <Field label="Received at" hint="Defaults to now"><Input type="datetime-local" value={v.receivedAt} onChange={(e) => setV({ ...v, receivedAt: e.target.value })} /></Field>
        {v.method === 'cheque' && <Field label="Cheque status" className="sm:col-span-2"><Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={[{ value: 'pending', label: 'Pending clearance (not counted yet)' }, { value: 'succeeded', label: 'Cleared' }]} /></Field>}
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function InvoiceEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: existing } = useData<any>(['invoice', id], id ? `/app/invoices/${id}` : null);
  const [customerId, setCustomerId] = useState('');
  const [meta, setMeta] = useState({ dueDate: '', notes: '', placeOfSupply: '' });
  const [lines, setLines] = useState<Line[]>([{ itemType: 'labour', description: '', quantity: 1, unitPrice: 0, discountPercent: 0, taxRateId: undefined as any }]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (existing) { setCustomerId(existing.customer_id); setMeta({ dueDate: existing.due_date ?? '', notes: existing.notes ?? '', placeOfSupply: existing.place_of_supply ?? '' });
    setLines(existing.items.map((i: any) => ({ itemType: i.item_type, inventoryItemId: i.inventory_item_id, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), discountPercent: Number(i.discount_percent), taxRateId: i.tax_rate_id, hsnSacCode: i.hsn_sac_code ?? '' }))); } }, [existing]);
  const save = async (issue: boolean) => {
    if (lines.some((l) => !l.description.trim())) return toast.error('Every line needs a description');
    setBusy(true);
    const items = lines.map((l) => ({ ...l, hsnSacCode: l.hsnSacCode || null }));
    try {
      const r = id ? await put(`/app/invoices/${id}`, { ...meta, dueDate: meta.dueDate || null, items }) : await post('/app/invoices', { customerId, ...meta, dueDate: meta.dueDate || null, items, issue });
      if (id && issue) await post(`/app/invoices/${id}/issue`);
      toast.success(issue ? 'Invoice issued' : 'Draft saved'); nav(`/app/invoices/${r.data.id}`);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader back={<BackLink to="/app/invoices" label="Invoices" />} title={id ? 'Edit draft invoice' : 'New invoice'}
        actions={<><Button variant="outline" loading={busy} disabled={!customerId} onClick={() => save(false)}>Save draft</Button><Button loading={busy} disabled={!customerId} onClick={() => save(true)}>Save & issue</Button></>} />
      <div className="space-y-6">
        <Card><CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="Customer" required className="sm:col-span-3"><CustomerPicker value={customerId} onChange={setCustomerId} disabled={!!id} /></Field>
          <Field label="Due date" hint="Defaults to payment terms"><Input type="date" value={meta.dueDate} onChange={(e) => setMeta({ ...meta, dueDate: e.target.value })} /></Field>
          <Field label="Place of supply" hint="State / region (GST)"><Input value={meta.placeOfSupply} onChange={(e) => setMeta({ ...meta, placeOfSupply: e.target.value })} /></Field>
        </CardBody></Card>
        <Card><CardHeader title="Line items" /><CardBody><LineItemsEditor lines={lines} setLines={setLines} invoice /></CardBody></Card>
        <Card><CardBody><Field label="Notes"><Textarea rows={2} value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} /></Field></CardBody></Card>
      </div>
    </div>
  );
}

function InvoiceList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { params, set, sort, toggleSort } = useListState();
  const { data, isLoading, error, refetch } = usePaged('/app/invoices', params);
  return (
    <div>
      <PageHeader title="Invoices" description="Issued invoices are immutable. Corrections use credit notes or cancellation."
        actions={<><Button variant="outline" onClick={() => openFile(`/app/invoices?format=csv&status=${params.status ?? ''}`, 'invoices.csv').catch(toastError)}><Download />Export</Button>
          {can('invoices.manage') && <Button onClick={() => nav('/app/invoices/new')}><Plus />New invoice</Button>}</>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4"><SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} />
          <Select aria-label="Status" className="w-48" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses"
            options={[['issued,partially_paid,overdue', 'Unpaid'], ['draft', 'Draft'], ['issued', 'Issued'], ['partially_paid', 'Partially paid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['cancelled', 'Cancelled'], ['refunded,partially_refunded', 'Refunded']].map(([value, label]) => ({ value, label }))} />
          <Checkbox label="Past due date" checked={params.overdue === '1'} onChange={(e) => set({ overdue: e.target.checked ? '1' : '' })} /></div>
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
          onRowClick={(r: any) => nav(`/app/invoices/${r.id}`)} empty={<EmptyState icon={Receipt} title="No invoices" />} columns={[
            { key: 'number', header: 'Invoice', sortable: true, cell: (r: any) => <div><p className="font-medium">{r.number ?? 'Draft'}</p><p className="text-xs text-slate-500">{r.work_order_number ?? ''}</p></div> },
            { key: 'c', header: 'Customer', cell: (r: any) => r.company_name ?? r.customer_name }, { key: 'issued', header: 'Issued', sortable: true, hideOnMobile: true, cell: (r: any) => date(r.issue_date) },
            { key: 'due', header: 'Due', sortable: true, hideOnMobile: true, cell: (r: any) => <span className={r.due_date && new Date(r.due_date) < new Date() && Number(r.balance_due) > 0 && r.status !== 'cancelled' ? 'text-red-600' : ''}>{date(r.due_date)}</span> },
            { key: 'total', header: 'Total', sortable: true, className: 'text-right', cell: (r: any) => <span className="tabular">{money(r.total, r.currency)}</span> },
            { key: 'balance', header: 'Balance', sortable: true, className: 'text-right', cell: (r: any) => <span className="tabular">{Number(r.balance_due) > 0 && r.status !== 'draft' && r.status !== 'cancelled' ? money(r.balance_due, r.currency) : '—'}</span> },
            { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} />
      </Card>
    </div>
  );
}

function InvoiceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: i, isLoading, error, refetch } = useData<any>(['invoice', id], `/app/invoices/${id}`);
  const [pay, setPay] = useState(false);
  const [credit, setCredit] = useState<any>(null);
  const [refund, setRefund] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['invoice', id] }); qc.invalidateQueries({ queryKey: ['/app/invoices'] }); };
  const act = useAction((fn: () => Promise<any>) => fn(), { onSuccess: refresh });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const payable = ['issued', 'partially_paid', 'overdue'].includes(i.status) && Number(i.balance_due) > 0;
  const link = `${location.origin}/i/${i.public_token}`;
  return (
    <div>
      <PageHeader back={<BackLink to="/app/invoices" label="Invoices" />} title={<span className="flex items-center gap-3">{i.number ?? 'Draft invoice'}<StatusBadge status={i.status} /></span>}
        description={<><Link to={`/app/customers/${i.customer_id}`} className="text-brand-700">{i.company_name ?? i.customer_name}</Link>{i.work_order_number && <> · job <Link className="text-brand-700" to={`/app/work-orders/${i.work_order_id}`}>{i.work_order_number}</Link></>}</>}
        actions={<>
          <Button variant="outline" onClick={() => openFile(`/app/invoices/${i.id}/pdf`).catch(toastError)}><FileDown />PDF</Button>
          {i.status === 'draft' && can('invoices.manage') && <><Button variant="outline" onClick={() => nav(`/app/invoices/${i.id}/edit`)}>Edit</Button>
            <Button onClick={async () => { if (await confirm({ title: 'Issue invoice?', description: 'An invoice number is assigned and the invoice becomes immutable. The customer is notified.', confirmLabel: 'Issue invoice' })) act.mutate(() => post(`/app/invoices/${i.id}/issue`).then(() => toast.success('Invoice issued'))); }}>Issue</Button>
            <Button variant="ghost" onClick={async () => { if (await confirm({ title: 'Delete draft?', danger: true, confirmLabel: 'Delete' })) act.mutate(() => del(`/app/invoices/${i.id}`).then(() => nav('/app/invoices'))); }}>Delete</Button></>}
          {payable && can('payments.record') && <Button onClick={() => setPay(true)}><CreditCard />Record payment</Button>}
          {i.status !== 'draft' && i.status !== 'cancelled' && can('invoices.manage') && <Button variant="outline" onClick={() => act.mutate(() => post(`/app/invoices/${i.id}/send`).then(() => toast.success('Invoice sent')))}><Send />Send</Button>}
        </>} />
      {i.status === 'cancelled' && <div className="mb-4"><Alert tone="red" title="Cancelled">{i.cancellation_reason} · {dateTime(i.cancelled_at)}</Alert></div>}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4"><StatCard label="Total" value={money(i.total, i.currency)} /><StatCard label="Paid" value={money(i.amount_paid, i.currency)} tone="green" />
        <StatCard label="Refunded / credited" value={money(Number(i.amount_refunded) + Number(i.amount_credited), i.currency)} tone="amber" /><StatCard label="Balance due" value={money(i.balance_due, i.currency)} tone="red" hint={i.due_date ? `Due ${date(i.due_date)}` : undefined} /></div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card><CardHeader title="Items" description={i.issue_date ? `Issued ${date(i.issue_date)}${i.place_of_supply ? ` · Place of supply: ${i.place_of_supply}` : ''}` : 'Draft — not yet issued'} />
            <CardBody><ItemsTable items={i.items} currency={i.currency} /><TotalsBlock d={i} />{i.notes && <p className="mt-6 whitespace-pre-line text-sm text-slate-600">{i.notes}</p>}</CardBody></Card>
          <Card><CardHeader title="Payments" />
            <DataTable rows={i.payments} empty={<EmptyState title="No payments yet" />} columns={[
              { key: 'r', header: 'Receipt', cell: (p: any) => p.receipt_number ?? '—' }, { key: 'd', header: 'Date', cell: (p: any) => dateTime(p.received_at) },
              { key: 'm', header: 'Method', cell: (p: any) => <div><p>{titleCase(p.method)}</p><p className="text-xs text-slate-500">{p.reference ?? p.provider_payment_id ?? ''}</p></div> },
              { key: 'a', header: 'Amount', className: 'text-right', cell: (p: any) => money(p.amount, p.currency) }, { key: 's', header: 'Status', cell: (p: any) => <StatusBadge status={p.status} /> },
              { key: 'x', header: '', cell: (p: any) => <div className="flex justify-end gap-1">
                {p.status === 'succeeded' && <Button size="sm" variant="ghost" onClick={() => openFile(`/app/payments/${p.id}/receipt.pdf`).catch(toastError)}>Receipt</Button>}
                {p.status === 'pending' && can('payments.record') && <><Button size="sm" variant="ghost" onClick={() => act.mutate(() => post(`/app/payments/${p.id}/confirm`))}>Cleared</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { const r = await confirm({ title: 'Mark payment failed?', requireReason: true, danger: true }); if (r) act.mutate(() => post(`/app/payments/${p.id}/fail`, { reason: r.reason })); }}>Bounced</Button></>}
                {p.status === 'succeeded' && can('payments.refund') && <Button size="sm" variant="ghost" onClick={() => setRefund({ payment: p, amount: '', reason: '', key: newIdempotencyKey() })}><RotateCcw />Refund</Button>}</div> }]} />
            {i.refunds.length > 0 && <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">{i.refunds.map((r: any) => <li key={r.id} className="flex justify-between px-5 py-2.5"><span>Refund {money(r.amount, i.currency)} · {r.reason} <span className="text-xs text-slate-500">{dateTime(r.created_at)}</span></span><StatusBadge status={r.status} /></li>)}</ul>}
          </Card>
          {i.creditNotes.length > 0 && <Card><CardHeader title="Credit notes" /><ul className="divide-y divide-slate-100 text-sm">{i.creditNotes.map((c: any) => <li key={c.id} className="flex justify-between px-5 py-2.5"><span>{c.number} · {c.reason}</span><span className="tabular">−{money(c.amount, i.currency)}</span></li>)}</ul></Card>}
        </div>
        <div className="space-y-6">
          {i.status !== 'draft' && i.status !== 'cancelled' && <Card><CardHeader title="Customer payment link" /><CardBody className="space-y-2"><div className="flex gap-2"><Input readOnly value={link} aria-label="Invoice link" />
            <Button size="icon" variant="outline" aria-label="Copy" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success('Copied'))}><Copy /></Button></div>
            {payable && <Button size="sm" variant="outline" onClick={() => act.mutate(() => post(`/app/invoices/${i.id}/payment-link`).then((r) => { navigator.clipboard.writeText(r.data.checkoutUrl); toast.success(`Checkout link copied (${r.data.provider}${r.data.mode === 'test' ? ', sandbox' : ''})`); }))}><Link2 />Create checkout link</Button>}
            <p className="text-xs text-slate-500">Online payments are confirmed only by verified gateway webhooks.</p></CardBody></Card>}
          {i.status !== 'draft' && i.status !== 'cancelled' && can('invoices.cancel') && <Card><CardHeader title="Corrections" /><CardBody className="space-y-2">
            {Number(i.balance_due) > 0 && <Button variant="outline" className="w-full" onClick={() => setCredit({ amount: '', reason: '' })}>Issue credit note</Button>}
            <Button variant="danger-outline" className="w-full" onClick={async () => { const r = await confirm({ title: 'Cancel invoice?', description: 'The invoice keeps its number and is marked cancelled. Payments must be refunded first.', requireReason: true, danger: true, confirmLabel: 'Cancel invoice' }); if (r) act.mutate(() => post(`/app/invoices/${i.id}/cancel`, { reason: r.reason })); }}><Ban />Cancel invoice</Button>
          </CardBody></Card>}
          {i.status !== 'draft' && <EInvoicePanel invoice={i} />}
          {i.seller?.name && <Card><CardHeader title="Billed to" /><CardBody className="text-sm"><p className="font-medium">{i.bill_to.name}</p><p className="text-slate-600">{i.bill_to.address}</p>{i.bill_to.tax_id && <p className="text-xs text-slate-500">Tax ID {i.bill_to.tax_id}</p>}</CardBody></Card>}
        </div>
      </div>
      <RecordPaymentDialog invoice={i} open={pay} onOpenChange={setPay} onDone={refresh} />
      <Dialog open={!!credit} onOpenChange={(o) => !o && setCredit(null)} title="Issue credit note" description={`Reduces the outstanding balance (max ${money(i.balance_due, i.currency)}).`}
        footer={<Button onClick={() => act.mutate(() => post(`/app/invoices/${i.id}/credit-notes`, { amount: Number(credit.amount), reason: credit.reason }).then(() => setCredit(null)))}>Issue</Button>}>
        {credit && <div className="space-y-3"><Field label="Amount"><Input type="number" step="0.01" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} /></Field>
          <Field label="Reason"><Textarea rows={2} value={credit.reason} onChange={(e) => setCredit({ ...credit, reason: e.target.value })} /></Field></div>}
      </Dialog>
      <Dialog open={!!refund} onOpenChange={(o) => !o && setRefund(null)} title="Refund payment" description={refund && `Payment of ${money(refund.payment.amount, i.currency)} via ${titleCase(refund.payment.method)}. Gateway payments are refunded through the provider.`}
        footer={<Button variant="danger" onClick={() => act.mutate(() => api(`/app/payments/${refund.payment.id}/refund`, { method: 'POST', headers: { 'Idempotency-Key': refund.key }, body: { amount: Number(refund.amount), reason: refund.reason } })
          .then((r) => { setRefund(null); toast.success(r.meta?.duplicate ? 'Refund already processed' : `Refund ${r.data.status}`); }))}>Refund</Button>}>
        {refund && <div className="space-y-3"><Field label="Amount"><Input type="number" step="0.01" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></Field>
          <Field label="Reason"><Textarea rows={2} value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}
export default function Invoices() { return <Routes><Route index element={<InvoiceList />} /><Route path="new" element={<InvoiceEditor />} /><Route path=":id/edit" element={<InvoiceEditor />} /><Route path=":id" element={<InvoiceDetail />} /></Routes>; }
