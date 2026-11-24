import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Pencil, Plus, QrCode, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api, get, patch, post } from '@/lib/api';
import { useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, DescriptionList, Dialog, EmptyState, ErrorState, Field, PageHeader, PageLoader, SearchInput, Select, StatusBadge } from '@/components/ui';
import { FormDialog, toastError, type FieldDef } from '@/components/form';
import { BackLink, CustomerPicker, DocumentsPanel, Timeline, useSettingsLists } from './shared';

function assetFields(cats: any[]): FieldDef[] {
  return [
    { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Bedroom AC' }, { name: 'equipmentCategoryId', label: 'Category', type: 'select', options: cats.map((c) => ({ value: c.id, label: c.name })) },
    { name: 'manufacturer', label: 'Manufacturer' }, { name: 'model', label: 'Model' }, { name: 'serialNumber', label: 'Serial number' }, { name: 'capacity', label: 'Capacity / rating' },
    { name: 'installationDate', label: 'Installation date', type: 'date' }, { name: 'purchaseDate', label: 'Purchase date', type: 'date' },
    { name: 'warrantyStart', label: 'Warranty start', type: 'date' }, { name: 'warrantyExpiry', label: 'Warranty expiry', type: 'date' },
    { name: 'nextServiceDue', label: 'Next service due', type: 'date', hint: 'Calculated from category interval if blank' },
    { name: 'status', label: 'Status', type: 'select', options: ['active', 'under_repair', 'inactive', 'decommissioned'].map((s) => ({ value: s, label: titleCase(s) })) },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

function NewAsset({ open, onOpenChange, presetCustomer }: { open: boolean; onOpenChange: (o: boolean) => void; presetCustomer?: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: s } = useSettingsLists();
  const [customerId, setCustomerId] = useState(presetCustomer ?? '');
  useEffect(() => { if (presetCustomer) setCustomerId(presetCustomer); }, [presetCustomer]);
  const { data: cust } = useQuery({ queryKey: ['customer', customerId], queryFn: async () => (await get(`/app/customers/${customerId}`)).data, enabled: !!customerId });
  const [addressId, setAddressId] = useState('');
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Register equipment" size="lg" fields={assetFields(s?.equipmentCategories ?? [])} defaultValues={{ status: 'active' }}
      onSubmit={async (v) => { if (!customerId) throw new Error('Choose a customer'); const r = await post('/app/assets', { ...v, customerId, addressId: addressId || null }); qc.invalidateQueries({ queryKey: ['/app/assets'] }); toast.success(`Asset ${r.data.number} registered`); nav(`/app/assets/${r.data.id}`); }}>
      <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
        <Field label="Customer" required><CustomerPicker value={customerId} onChange={(id) => { setCustomerId(id); setAddressId(''); }} /></Field>
        <Field label="Location"><Select value={addressId} onChange={(e) => setAddressId(e.target.value)} placeholder="—" disabled={!cust} options={(cust?.addresses ?? []).map((a: any) => ({ value: a.id, label: `${a.label}: ${a.line1}` }))} /></Field>
      </div>
    </FormDialog>
  );
}

function AssetList() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const { data: s } = useSettingsLists();
  const { params, set, sort, toggleSort } = useListState();
  const { data, isLoading, error, refetch } = usePaged('/app/assets', { ...params, new: undefined });
  const [open, setOpen] = useState(sp.get('new') === '1');
  return (
    <div>
      <PageHeader title="Assets & equipment" description="Installed equipment, warranties and service history." actions={can('assets.manage') && <Button onClick={() => setOpen(true)}><Plus />Register equipment</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} placeholder="Name, serial, model, customer…" />
          <Select aria-label="Category" className="w-44" value={params.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value })} placeholder="All categories" options={(s?.equipmentCategories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          <Select aria-label="Warranty" className="w-44" value={params.warranty ?? ''} onChange={(e) => set({ warranty: e.target.value })} placeholder="Any warranty" options={[{ value: 'active', label: 'Under warranty' }, { value: 'expiring', label: 'Expiring in 30 days' }, { value: 'expired', label: 'Expired' }]} />
          <Checkbox label="Service due (14 days)" checked={params.serviceDue === '1'} onChange={(e) => set({ serviceDue: e.target.checked ? '1' : '' })} />
        </div>
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
          onRowClick={(r: any) => nav(`/app/assets/${r.id}`)} empty={<EmptyState icon={Cpu} title="No equipment registered" />}
          columns={[
            { key: 'name', header: 'Equipment', sortable: true, cell: (r: any) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-slate-500">{r.number} · {r.category_name ?? 'Uncategorised'}</p></div> },
            { key: 'cust', header: 'Customer', cell: (r: any) => r.customer_name },
            { key: 'model', header: 'Make / model', hideOnMobile: true, cell: (r: any) => <div><p>{[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}</p><p className="text-xs text-slate-500">{r.serial_number}</p></div> },
            { key: 'warranty', header: 'Warranty', sortable: true, hideOnMobile: true, cell: (r: any) => r.warranty_expiry ? <span className={new Date(r.warranty_expiry) < new Date() ? 'text-slate-400' : 'text-emerald-700'}>{date(r.warranty_expiry)}</span> : '—' },
            { key: 'next', header: 'Next service', sortable: true, cell: (r: any) => r.next_service_due ? <span className={new Date(r.next_service_due) < new Date() ? 'font-medium text-red-600' : ''}>{date(r.next_service_due)}</span> : '—' },
            { key: 'status', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> },
          ]} />
      </Card>
      <NewAsset open={open} onOpenChange={(o) => { setOpen(o); if (!o && sp.get('new')) { sp.delete('new'); sp.delete('customerId'); setSp(sp); } }} presetCustomer={sp.get('customerId') ?? undefined} />
    </div>
  );
}

function AssetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data: s } = useSettingsLists();
  const { data: a, isLoading, error, refetch } = useData<any>(['asset', id], `/app/assets/${id}`);
  const [edit, setEdit] = useState(false);
  const [replace, setReplace] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['asset', id] });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const showQr = async () => { try { const res = await api<Response>(`/app/assets/${a.id}/qr.png`, { raw: true }); setQr(URL.createObjectURL(await res.blob())); } catch (e) { toastError(e); } };
  return (
    <div>
      <PageHeader back={<BackLink to="/app/assets" label="Assets" />} title={<span className="flex items-center gap-3">{a.name}<StatusBadge status={a.status} />
        <Badge tone={a.warrantyStatus === 'active' ? 'green' : a.warrantyStatus === 'expired' ? 'slate' : 'slate'}>Warranty {a.warrantyStatus}</Badge></span>}
        description={<>{a.number} · <Link className="text-brand-700" to={`/app/customers/${a.customer_id}`}>{a.customer_name}</Link></>}
        actions={<>
          <Button variant="outline" onClick={showQr}><QrCode />QR label</Button>
          {can('work_orders.create') && a.status !== 'replaced' && <Button onClick={() => nav(`/app/work-orders/new?customerId=${a.customer_id}`)}><Plus />New job</Button>}
          {can('assets.manage') && <><Button variant="outline" onClick={() => setEdit(true)}><Pencil />Edit</Button>{a.status !== 'replaced' && <Button variant="outline" onClick={() => setReplace(true)}><RefreshCw />Replace</Button>}</>}
        </>} />
      {a.replaced_by_asset_id && <div className="mb-4"><Alert tone="amber" title="Replaced" action={<Link to={`/app/assets/${a.replaced_by_asset_id}`}><Button size="sm">View {a.replaced_by_number}</Button></Link>}>{a.replacement_reason}</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card><CardHeader title="Service history" description="Every work order recorded against this equipment" />
            <CardBody>{a.workOrders.length ? <Timeline items={a.workOrders.map((w: any) => ({ title: <Link to={`/app/work-orders/${w.id}`} className="text-brand-700">{w.number} — {w.title}</Link>,
              meta: `${dateTime(w.actual_end ?? w.scheduled_start)} · ${w.technician_name ?? 'Unassigned'} · ${titleCase(w.status)}${w.equipment_condition ? ` · condition ${w.equipment_condition}` : ''}`, body: w.work_performed ?? w.findings }))} />
              : <EmptyState title="No service history yet" />}</CardBody></Card>
          <DocumentsPanel entityType="asset" entityId={a.id} title="Manuals, warranty & photos" />
        </div>
        <div className="space-y-6">
          <Card><CardHeader title="Details" /><CardBody><DescriptionList cols={1} items={[['Category', a.category_name], ['Make / model', [a.manufacturer, a.model].filter(Boolean).join(' ')], ['Serial number', a.serial_number],
            ['Capacity', a.capacity], ['Location', [a.line1, a.city, a.postal_code].filter(Boolean).join(', ')], ['Installed', date(a.installation_date)], ['Purchased', date(a.purchase_date)],
            ['Warranty', `${date(a.warranty_start)} → ${date(a.warranty_expiry)}`], ['Last service', date(a.last_service_date)], ['Next service due', date(a.next_service_due)]]} />
            {a.notes && <p className="mt-4 text-sm text-slate-600">{a.notes}</p>}</CardBody></Card>
          {a.contracts.length > 0 && <Card><CardHeader title="AMC coverage" /><ul className="divide-y divide-slate-100 text-sm">{a.contracts.map((c: any) => <li key={c.id}><Link to={`/app/amc/${c.id}`} className="flex justify-between px-5 py-2.5 hover:bg-slate-50"><span>{c.number} · until {date(c.end_date)}</span><StatusBadge status={c.status} /></Link></li>)}</ul></Card>}
          {a.replaces.length > 0 && <Card><CardHeader title="Replaced equipment" /><ul className="text-sm">{a.replaces.map((x: any) => <li key={x.id}><Link to={`/app/assets/${x.id}`} className="block px-5 py-2.5 text-brand-700">{x.number} · {x.name}</Link></li>)}</ul></Card>}
        </div>
      </div>
      <FormDialog open={edit} onOpenChange={setEdit} title="Edit equipment" size="lg" fields={assetFields(s?.equipmentCategories ?? [])}
        defaultValues={{ name: a.name, equipmentCategoryId: a.equipment_category_id ?? '', manufacturer: a.manufacturer ?? '', model: a.model ?? '', serialNumber: a.serial_number ?? '', capacity: a.capacity ?? '',
          installationDate: a.installation_date ?? '', purchaseDate: a.purchase_date ?? '', warrantyStart: a.warranty_start ?? '', warrantyExpiry: a.warranty_expiry ?? '', nextServiceDue: a.next_service_due ?? '', status: a.status, notes: a.notes ?? '' }}
        onSubmit={async (v) => { await patch(`/app/assets/${a.id}`, v); refresh(); }} successMessage="Equipment updated" />
      <FormDialog open={replace} onOpenChange={setReplace} title="Replace equipment" description="The current asset keeps its history and is marked as replaced. Active AMC coverage moves to the new asset." size="lg"
        fields={[{ name: 'reason', label: 'Reason for replacement', required: true, span: 2 }, ...assetFields(s?.equipmentCategories ?? []).filter((f) => !['status', 'nextServiceDue'].includes(f.name))]}
        defaultValues={{ name: a.name, equipmentCategoryId: a.equipment_category_id ?? '' }} onSubmit={async (v) => { const r = await post(`/app/assets/${a.id}/replace`, v); nav(`/app/assets/${r.data.id}`); }} successMessage="Replacement recorded" />
      <Dialog open={!!qr} onOpenChange={(o) => { if (!o && qr) URL.revokeObjectURL(qr); setQr(null); }} title={`QR label — ${a.number}`} description="Scanning shows non-personal equipment info and a service request link.">
        {qr && <div className="text-center"><img src={qr} alt="Asset QR code" className="mx-auto h-56 w-56" /><a href={qr} download={`${a.number}-qr.png`}><Button className="mt-4" variant="outline">Download PNG</Button></a></div>}
      </Dialog>
    </div>
  );
}

export default function Assets() { return <Routes><Route index element={<AssetList />} /><Route path=":id" element={<AssetDetail />} /></Routes>; }
