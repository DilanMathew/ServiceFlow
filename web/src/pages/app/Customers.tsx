import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, Download, MapPin, MoreHorizontal, Pencil, Phone, Plus, RotateCcw, Trash2, Upload, Mail, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, del, openFile, patch, post } from '@/lib/api';
import { useAction, useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime, money } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DataTable, DescriptionList, Dialog, EmptyState, ErrorState, Field, Menu, PageHeader, PageLoader, SearchInput, Select, StatCard, StatusBadge, Tabs, Textarea, useConfirm } from '@/components/ui';
import { FormDialog, toastError, type FieldDef } from '@/components/form';
import { DocumentsPanel } from './shared';

export const customerFields: FieldDef[] = [
  { name: 'fullName', label: 'Full name', required: true },
  { name: 'customerType', label: 'Type', type: 'select', options: [{ value: 'individual', label: 'Individual' }, { value: 'business', label: 'Business' }] },
  { name: 'companyName', label: 'Company name' }, { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'altPhone', label: 'Alternate phone', type: 'tel' },
  { name: 'taxId', label: 'Tax ID (GSTIN / VAT)' }, { name: 'source', label: 'Source', placeholder: 'referral, google…' },
  { name: 'peppolId', label: 'Peppol ID (e-invoicing)', placeholder: '0204:991-01234-56', hint: 'Business buyers that receive e-invoices: scheme:identifier' },
  { name: 'buyerReference', label: 'Buyer reference', placeholder: 'Leitweg-ID / PO reference', hint: 'Required by German public-sector buyers (XRechnung)' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];
const addressFields: FieldDef[] = [
  { name: 'label', label: 'Label', placeholder: 'Home, Office…' }, { name: 'line1', label: 'Address line 1', required: true },
  { name: 'line2', label: 'Area / landmark' }, { name: 'city', label: 'City' }, { name: 'state', label: 'State / region' }, { name: 'postalCode', label: 'Postal code' },
  { name: 'accessNotes', label: 'Access notes', type: 'textarea', placeholder: 'Gate code, parking, pets…' }, { name: 'isDefault', label: 'Default service address', type: 'checkbox' },
];

/** Create customer with duplicate detection: exact matches block, similar names ask for confirmation. */
export function NewCustomerDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (c: any) => void }) {
  const qc = useQueryClient();
  const [similar, setSimilar] = useState<{ values: any; list: any[] } | null>(null);
  const create = async (values: any, force = false) => {
    const { line1, city, postalCode, ...rest } = values;
    try {
      const r = await post('/app/customers', { ...rest, force, addresses: line1 ? [{ line1, city, postalCode, isDefault: true }] : undefined });
      qc.invalidateQueries({ queryKey: ['/app/customers'] });
      toast.success(`Customer ${r.data.number} created`);
      onCreated?.(r.data); setSimilar(null);
    } catch (e) {
      if (e instanceof ApiError && e.details?.canForce) { setSimilar({ values, list: e.details.similar }); throw new Error('A similar customer exists — review below.'); }
      if (e instanceof ApiError && e.details?.duplicates) throw new Error(`${e.message} Existing: ${e.details.duplicates.map((d: any) => `${d.full_name} (${d.number})`).join(', ')}`);
      throw e;
    }
  };
  return (<>
    <FormDialog open={open} onOpenChange={onOpenChange} title="New customer" size="lg" defaultValues={{ customerType: 'individual' }}
      fields={[...customerFields, { name: 'line1', label: 'Service address', span: 2 }, { name: 'city', label: 'City' }, { name: 'postalCode', label: 'Postal code' }]}
      onSubmit={(v) => create(v)} submitLabel="Create customer" />
    <Dialog open={!!similar} onOpenChange={(o) => !o && setSimilar(null)} title="Possible duplicate" description="A customer with a similar name exists at this postcode."
      footer={<><Button variant="outline" onClick={() => setSimilar(null)}>Go back</Button><Button onClick={() => create(similar!.values, true).then(() => onOpenChange(false)).catch(toastError)}>Create anyway</Button></>}>
      <ul className="space-y-2">{similar?.list.map((s) => <li key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm"><Link to={`/app/customers/${s.id}`} className="font-medium text-brand-700">{s.full_name}</Link>
        <span className="text-slate-500"> · {s.number} · {s.phone ?? s.email ?? ''}</span></li>)}</ul>
    </Dialog>
  </>);
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try { const r = await post('/app/customers/import', { csv, dryRun }); setReport(r.data); if (!dryRun) { qc.invalidateQueries({ queryKey: ['/app/customers'] }); toast.success(`${r.data.created} customers imported`); } }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setCsv(''); setReport(null); } }} title="Import customers from CSV" size="lg"
      description="Columns: full_name (required), email, phone, alt_phone, company_name, customer_type, address, city, state, postal_code, country, notes."
      footer={<><Button variant="outline" disabled={!csv} loading={busy} onClick={() => run(true)}>Validate</Button><Button disabled={!csv} loading={busy} onClick={() => run(false)}>Import</Button></>}>
      <input type="file" accept=".csv,text/csv" className="text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); setReport(null); }} />
      {csv && <p className="mt-2 text-xs text-slate-500">{csv.split('\n').length - 1} data rows loaded</p>}
      {report && <div className="mt-4 space-y-2">
        <Alert tone={report.errors.length ? 'amber' : 'green'} title={report.dryRun ? 'Validation result (nothing saved)' : 'Import complete'}>
          {report.created} to create · {report.skipped} duplicates skipped · {report.errors.length} errors</Alert>
        {report.errors.length > 0 && <ul className="max-h-40 overflow-y-auto text-xs text-red-700">{report.errors.map((e: any) => <li key={e.row}>Row {e.row}: {e.message}</li>)}</ul>}
      </div>}
    </Dialog>
  );
}

function CustomerList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { params, set, sort, toggleSort } = useListState({ status: 'active' });
  const { data, isLoading, error, refetch } = usePaged('/app/customers', params);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  return (
    <div>
      <PageHeader title="Customers" description="Every customer, their sites, equipment and history."
        actions={<>
          {can('customers.export') && <Button variant="outline" onClick={() => openFile(`/app/customers/export?status=${params.status ?? 'active'}`, 'customers.csv').catch(toastError)}><Download />Export</Button>}
          {can('customers.import') && <Button variant="outline" onClick={() => setImporting(true)}><Upload />Import</Button>}
          {can('customers.create') && <Button onClick={() => setCreating(true)}><Plus />New customer</Button>}
        </>} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} placeholder="Name, phone, email, number…" />
          <Select aria-label="Status" className="w-36" value={params.status} onChange={(e) => set({ status: e.target.value })}
            options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' }]} />
          <Select aria-label="Type" className="w-36" value={params.type ?? ''} onChange={(e) => set({ type: e.target.value })} placeholder="All types"
            options={[{ value: 'individual', label: 'Individual' }, { value: 'business', label: 'Business' }]} />
        </div>
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
          onRowClick={(r: any) => nav(`/app/customers/${r.id}`)}
          empty={<EmptyState title="No customers found" description="Add your first customer or import a CSV." action={can('customers.create') && <Button onClick={() => setCreating(true)}><Plus />New customer</Button>} />}
          columns={[
            { key: 'name', header: 'Customer', sortable: true, cell: (r: any) => <div><p className="font-medium text-slate-900">{r.full_name}</p><p className="text-xs text-slate-500">{r.company_name ?? r.number}</p></div> },
            { key: 'contact', header: 'Contact', hideOnMobile: true, cell: (r: any) => <div className="text-sm"><p>{r.phone ?? '—'}</p><p className="text-xs text-slate-500">{r.email}</p></div> },
            { key: 'city', header: 'City', hideOnMobile: true, cell: (r: any) => r.city ?? r.billing_city ?? '—' },
            { key: 'jobs', header: 'Jobs', sortable: true, className: 'text-right', cell: (r: any) => <span className="tabular">{r.job_count}</span> },
            { key: 'outstanding', header: 'Outstanding', className: 'text-right', hideOnMobile: true, cell: (r: any) => Number(r.outstanding) > 0 ? <span className="tabular text-red-700">{money(r.outstanding)}</span> : <span className="text-slate-400">—</span> },
            { key: 'status', header: 'Status', cell: (r: any) => <StatusBadge status={r.archived_at ? 'archived' : r.status} /> },
          ]} />
      </Card>
      <NewCustomerDialog open={creating} onOpenChange={setCreating} onCreated={(c) => nav(`/app/customers/${c.id}`)} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}

function CustomerDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: c, isLoading, error, refetch } = useData<any>(['customer', id], `/app/customers/${id}`);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [addr, setAddr] = useState<any>(null);
  const [note, setNote] = useState<{ channel: string; body: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['customer', id] });
  const action = useAction((fn: () => Promise<any>) => fn(), { invalidate: [['customer', id], ['/app/customers']] });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const archived = !!c.archived_at;
  return (
    <div>
      <PageHeader back={<Link to="/app/customers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />Customers</Link>}
        title={<span className="flex items-center gap-3">{c.full_name}<StatusBadge status={archived ? 'archived' : c.status} />{c.customer_type === 'business' && <Badge tone="navy">Business</Badge>}</span>}
        description={<span className="flex flex-wrap gap-x-4 gap-y-1">{c.number}{c.phone && <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 text-brand-700"><Phone className="h-3.5 w-3.5" />{c.phone}</a>}
          {c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-brand-700"><Mail className="h-3.5 w-3.5" />{c.email}</a>}</span>}
        actions={<>
          {!archived && can('work_orders.create') && <Button onClick={() => nav(`/app/work-orders/new?customerId=${c.id}`)}><Plus />New job</Button>}
          {!archived && can('quotations.manage') && <Button variant="outline" onClick={() => nav(`/app/quotations/new?customerId=${c.id}`)}>New quotation</Button>}
          <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal /></Button>} items={[
            ...(can('customers.update') ? [{ label: 'Edit details', icon: Pencil, onSelect: () => setEditing(true) }, { label: 'Log communication', icon: MessageSquarePlus, onSelect: () => setNote({ channel: 'phone', body: '' }) }] : []),
            ...(can('customers.delete') ? [archived ? { label: 'Restore', icon: RotateCcw, onSelect: () => action.mutate(() => post(`/app/customers/${c.id}/restore`)) }
              : { label: 'Archive', icon: Archive, onSelect: async () => { if (await confirm({ title: 'Archive customer?', description: 'Archived customers are hidden from lists but their history is kept.', confirmLabel: 'Archive', danger: true })) action.mutate(() => post(`/app/customers/${c.id}/archive`)); } },
              { label: 'Delete permanently', icon: Trash2, danger: true, onSelect: async () => { if (await confirm({ title: 'Delete customer?', description: 'Only customers with no jobs, invoices or equipment can be deleted.', confirmLabel: 'Delete', danger: true })) { try { await del(`/app/customers/${c.id}`); toast.success('Customer deleted'); nav('/app/customers'); } catch (e) { toastError(e); } } } }] : []),
          ]} />
        </>} />
      {c.anonymized_at && <div className="mb-4"><Alert tone="amber">This customer's personal data was erased on {date(c.anonymized_at)}. Financial records are retained as required by law.</Alert></div>}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard label="Total jobs" value={c.stats.total_jobs} /><StatCard label="Open jobs" value={c.stats.open_jobs} tone="amber" />
        {c.stats.lifetime_paid !== null && <><StatCard label="Lifetime paid" value={money(c.stats.lifetime_paid)} tone="green" /><StatCard label="Outstanding" value={money(c.stats.outstanding)} tone="red" /></>}
        <StatCard label="Rating" value={c.stats.avg_rating ? `${c.stats.avg_rating} ★` : '—'} tone="violet" />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'jobs', label: 'Jobs', count: c.workOrders.length }, { value: 'equipment', label: 'Equipment', count: c.assets.length },
        { value: 'billing', label: 'Quotes & billing', count: c.quotations.length + c.invoices.length }, { value: 'contracts', label: 'AMC', count: c.contracts.length },
        { value: 'comms', label: 'Communications', count: c.communications.length }, { value: 'documents', label: 'Documents', count: c.documents.length }]} />
      <div className="mt-5">
        {tab === 'overview' && <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2"><CardHeader title="Details" /><CardBody><DescriptionList items={[['Customer type', titleCase(c.customer_type)], ['Company', c.company_name], ['Alternate phone', c.alt_phone],
            ['Tax ID', c.tax_id], ['Source', titleCase(c.source)], ['Customer since', date(c.created_at)], ['Billing address', [c.billing_line1, c.billing_city, c.billing_postal_code].filter(Boolean).join(', ') || null],
            ['Notifications', Object.entries(c.notification_opt_out ?? {}).filter(([, v]) => v).map(([k]) => `${k} off`).join(', ') || 'All channels on']]} />
            {c.notes && <p className="mt-5 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{c.notes}</p>}</CardBody></Card>
          <Card><CardHeader title="Service locations" actions={can('customers.update') && <Button size="sm" variant="outline" onClick={() => setAddr({})}><Plus />Add</Button>} />
            <ul className="divide-y divide-slate-100">{c.addresses.length ? c.addresses.map((a: any) => (
              <li key={a.id} className="flex items-start justify-between gap-2 px-5 py-3 text-sm"><div><p className="font-medium">{a.label} {a.is_default && <Badge tone="blue">Default</Badge>}</p>
                <p className="text-slate-600">{[a.line1, a.line2, a.city, a.postal_code].filter(Boolean).join(', ')}</p>{a.access_notes && <p className="text-xs text-slate-500">{a.access_notes}</p>}
                <a className="mt-1 inline-flex items-center gap-1 text-xs text-brand-700" target="_blank" rel="noreferrer" href={a.latitude ? `https://www.google.com/maps?q=${a.latitude},${a.longitude}` : `https://www.google.com/maps/search/${encodeURIComponent([a.line1, a.city, a.postal_code].join(' '))}`}><MapPin className="h-3 w-3" />Map</a></div>
                {can('customers.update') && <Menu trigger={<Button size="icon-sm" variant="ghost" aria-label="Address actions"><MoreHorizontal /></Button>} items={[{ label: 'Edit', onSelect: () => setAddr(a) },
                  { label: 'Remove', danger: true, onSelect: () => action.mutate(() => del(`/app/customers/${c.id}/addresses/${a.id}`)) }]} />}</li>))
              : <EmptyState icon={MapPin} title="No addresses" />}</ul></Card>
          <Card className="lg:col-span-3"><CardHeader title="Service requests" /><ul className="divide-y divide-slate-100">{c.requests.length ? c.requests.map((r: any) => (
            <li key={r.id}><Link to={`/app/requests/${r.id}`} className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-slate-50"><span className="truncate"><span className="font-medium">{r.number}</span> · {r.description}</span><StatusBadge status={r.status} /></Link></li>))
            : <EmptyState title="No service requests" />}</ul></Card>
        </div>}
        {tab === 'jobs' && <Card><DataTable rows={c.workOrders} onRowClick={(r: any) => nav(`/app/work-orders/${r.id}`)} empty={<EmptyState title="No jobs yet" />} columns={[
          { key: 'n', header: 'Job', cell: (r: any) => <span className="font-medium">{r.number}</span> }, { key: 't', header: 'Title', cell: (r: any) => r.title },
          { key: 's', header: 'Scheduled', hideOnMobile: true, cell: (r: any) => dateTime(r.scheduled_start) }, { key: 'tech', header: 'Technician', hideOnMobile: true, cell: (r: any) => r.technician_name ?? '—' },
          { key: 'st', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>}
        {tab === 'equipment' && <Card><CardHeader title="Registered equipment" actions={can('assets.manage') && <Button size="sm" onClick={() => nav(`/app/assets?new=1&customerId=${c.id}`)}><Plus />Add equipment</Button>} />
          <DataTable rows={c.assets} onRowClick={(r: any) => nav(`/app/assets/${r.id}`)} empty={<EmptyState title="No equipment registered" />} columns={[
            { key: 'n', header: 'Asset', cell: (r: any) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-slate-500">{r.number}</p></div> },
            { key: 'm', header: 'Make / model', cell: (r: any) => [r.manufacturer, r.model].filter(Boolean).join(' ') || '—' }, { key: 'sn', header: 'Serial', hideOnMobile: true, cell: (r: any) => r.serial_number ?? '—' },
            { key: 'w', header: 'Warranty', cell: (r: any) => r.warranty_expiry ? <span className={r.warranty_expiry < new Date().toISOString() ? 'text-slate-400' : 'text-emerald-700'}>{date(r.warranty_expiry)}</span> : '—' },
            { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>}
        {tab === 'billing' && <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="Quotations" /><DataTable rows={c.quotations} onRowClick={(r: any) => nav(`/app/quotations/${r.id}`)} empty={<EmptyState title="No quotations" />} columns={[
            { key: 'n', header: 'Number', cell: (r: any) => `${r.number}${r.revision > 1 ? ` R${r.revision}` : ''}` }, { key: 'd', header: 'Date', cell: (r: any) => date(r.issue_date) },
            { key: 't', header: 'Total', className: 'text-right', cell: (r: any) => money(r.total, r.currency) }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>
          <Card><CardHeader title="Invoices" /><DataTable rows={c.invoices} onRowClick={(r: any) => nav(`/app/invoices/${r.id}`)} empty={<EmptyState title="No invoices" />} columns={[
            { key: 'n', header: 'Number', cell: (r: any) => r.number ?? 'Draft' }, { key: 'd', header: 'Due', cell: (r: any) => date(r.due_date) },
            { key: 'b', header: 'Balance', className: 'text-right', cell: (r: any) => money(r.balance_due, r.currency) }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>
          <Card className="lg:col-span-2"><CardHeader title="Payments" /><DataTable rows={c.payments} empty={<EmptyState title="No payments" />} columns={[
            { key: 'r', header: 'Receipt', cell: (r: any) => r.receipt_number ?? '—' }, { key: 'd', header: 'Date', cell: (r: any) => date(r.received_at) }, { key: 'i', header: 'Invoice', cell: (r: any) => r.invoice_number },
            { key: 'm', header: 'Method', cell: (r: any) => titleCase(r.method) }, { key: 'a', header: 'Amount', className: 'text-right', cell: (r: any) => money(r.amount, r.currency) }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>
        </div>}
        {tab === 'contracts' && <Card><DataTable rows={c.contracts} onRowClick={(r: any) => nav(`/app/amc/${r.id}`)} empty={<EmptyState title="No maintenance contracts" />} columns={[
          { key: 'n', header: 'Contract', cell: (r: any) => <div><p className="font-medium">{r.number}</p><p className="text-xs text-slate-500">{r.title}</p></div> },
          { key: 'p', header: 'Period', cell: (r: any) => `${date(r.start_date)} – ${date(r.end_date)}` }, { key: 'f', header: 'Frequency', cell: (r: any) => titleCase(r.frequency) },
          { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>}
        {tab === 'comms' && <Card><CardHeader title="Communication history" actions={can('customers.update') && <Button size="sm" variant="outline" onClick={() => setNote({ channel: 'phone', body: '' })}><Plus />Log</Button>} />
          <ul className="divide-y divide-slate-100">{c.communications.length ? c.communications.map((m: any) => (
            <li key={m.id} className="px-5 py-3 text-sm"><div className="flex items-center gap-2"><Badge tone={m.direction === 'inbound' ? 'violet' : m.direction === 'outbound' ? 'blue' : 'slate'}>{titleCase(m.channel)} · {m.direction}</Badge>
              <span className="text-xs text-slate-500">{dateTime(m.created_at)}{m.user_name ? ` · ${m.user_name}` : ''}</span></div>{m.subject && <p className="mt-1 font-medium">{m.subject}</p>}<p className="mt-1 whitespace-pre-line text-slate-600">{m.body}</p></li>))
            : <EmptyState title="No communication logged" />}</ul></Card>}
        {tab === 'documents' && <DocumentsPanel entityType="customer" entityId={c.id} onChange={refresh} />}
      </div>
      <FormDialog open={editing} onOpenChange={setEditing} title="Edit customer" size="lg" fields={customerFields}
        defaultValues={{ fullName: c.full_name, customerType: c.customer_type, companyName: c.company_name ?? '', email: c.email ?? '', phone: c.phone ?? '', altPhone: c.alt_phone ?? '', taxId: c.tax_id ?? '', source: c.source ?? '', peppolId: c.peppol_id ?? '', buyerReference: c.buyer_reference ?? '', notes: c.notes ?? '' }}
        onSubmit={async (v) => { await patch(`/app/customers/${c.id}`, v); refresh(); }} successMessage="Customer updated" />
      <FormDialog open={!!addr} onOpenChange={(o) => !o && setAddr(null)} title={addr?.id ? 'Edit address' : 'Add address'} fields={addressFields}
        defaultValues={addr?.id ? { label: addr.label, line1: addr.line1, line2: addr.line2 ?? '', city: addr.city ?? '', state: addr.state ?? '', postalCode: addr.postal_code ?? '', accessNotes: addr.access_notes ?? '', isDefault: addr.is_default } : { label: 'Primary', isDefault: c.addresses.length === 0 }}
        onSubmit={async (v) => { addr?.id ? await patch(`/app/customers/${c.id}/addresses/${addr.id}`, v) : await post(`/app/customers/${c.id}/addresses`, v); refresh(); }} successMessage="Address saved" />
      <Dialog open={!!note} onOpenChange={(o) => !o && setNote(null)} title="Log communication"
        footer={<Button disabled={!note?.body.trim()} onClick={() => post(`/app/customers/${c.id}/communications`, { channel: note!.channel, direction: note!.channel === 'note' ? 'internal' : 'inbound', body: note!.body }).then(() => { setNote(null); refresh(); toast.success('Logged'); }).catch(toastError)}>Save</Button>}>
        <div className="space-y-3"><Field label="Channel"><Select value={note?.channel} onChange={(e) => setNote({ ...note!, channel: e.target.value })} options={['phone', 'in_person', 'email', 'whatsapp', 'sms', 'note'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
          <Field label="Summary"><Textarea rows={4} value={note?.body ?? ''} onChange={(e) => setNote({ ...note!, body: e.target.value })} /></Field></div>
      </Dialog>
    </div>
  );
}

export default function Customers() {
  return <Routes><Route index element={<CustomerList />} /><Route path=":id" element={<CustomerDetail />} /></Routes>;
}
