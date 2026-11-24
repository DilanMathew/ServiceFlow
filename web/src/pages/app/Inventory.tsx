import { useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Boxes, Download, PackagePlus, Pencil, Plus, SlidersHorizontal, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { openFile, patch, post } from '@/lib/api';
import { useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime, money, num } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatCard, Tabs, Textarea } from '@/components/ui';
import { FormDialog, toastError, type FieldDef } from '@/components/form';
import { BackLink, useSettingsLists } from './shared';

function itemFields(s: any, suppliers: any[], create: boolean): FieldDef[] {
  return [
    { name: 'sku', label: 'SKU', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'category', label: 'Category' }, { name: 'unit', label: 'Unit', placeholder: 'pcs, kg, m…' },
    { name: 'purchasePrice', label: 'Purchase price', type: 'money' }, { name: 'sellingPrice', label: 'Selling price', type: 'money' },
    { name: 'taxRateId', label: 'Tax rate', type: 'select', options: (s?.taxRates ?? []).map((t: any) => ({ value: t.id, label: t.name })) },
    { name: 'minStock', label: 'Minimum stock (alert level)', type: 'number', step: 'any' }, { name: 'supplierId', label: 'Supplier', type: 'select', options: suppliers.map((x) => ({ value: x.id, label: x.name })) },
    ...(create ? [{ name: 'openingStock', label: 'Opening stock', type: 'number' as const, step: 'any' }] : [{ name: 'isActive', label: 'Active', type: 'checkbox' as const }]),
    { name: 'description', label: 'Description', type: 'textarea' },
  ];
}

function ItemList() {
  const nav = useNavigate();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const { data: s } = useSettingsLists();
  const { data: suppliers } = useData<any[]>(['suppliers'], '/app/inventory/suppliers');
  const { params, set, sort, toggleSort } = useListState();
  const [tab, setTab] = useState('items');
  const { data, isLoading, error, refetch } = usePaged('/app/inventory/items', { ...params, tab: undefined }, tab === 'items');
  const { data: purchases } = useData<any[]>(['purchases'], tab === 'purchases' ? '/app/inventory/purchases' : null);
  const [creating, setCreating] = useState(false);
  const [supplier, setSupplier] = useState<any>(null);
  const [purchase, setPurchase] = useState<any>(null);
  const manage = can('inventory.manage');
  return (
    <div>
      <PageHeader title="Parts & inventory" description="Stock is only changed through recorded transactions: purchases, job usage, adjustments and transfers."
        actions={manage && <><Button variant="outline" onClick={() => openFile('/app/inventory/items?format=csv', 'inventory.csv').catch(toastError)}><Download />Export</Button>
          <Button variant="outline" onClick={() => setPurchase({ supplierId: '', locationId: s?.stockLocations?.[0]?.id ?? '', reference: '', items: [{ itemId: '', quantity: 1, unitCost: 0 }] })}><Truck />Record purchase</Button>
          <Button onClick={() => setCreating(true)}><Plus />New item</Button></>} />
      {!me?.settings?.inventory_enabled && <div className="mb-4"><Alert tone="amber">Inventory tracking is turned off in settings: parts used on jobs are recorded without deducting stock.</Alert></div>}
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'items', label: 'Catalogue' }, { value: 'purchases', label: 'Purchases' }, { value: 'suppliers', label: 'Suppliers', count: suppliers?.length }]} />
      <div className="mt-5">
        {tab === 'items' && <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4"><SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} placeholder="SKU, name, category…" />
            <Select aria-label="Location" className="w-48" value={params.locationId ?? ''} onChange={(e) => set({ locationId: e.target.value })} placeholder="All locations" options={(s?.stockLocations ?? []).map((l: any) => ({ value: l.id, label: l.name }))} />
            <Checkbox label="Low stock only" checked={params.lowStock === '1'} onChange={(e) => set({ lowStock: e.target.checked ? '1' : '' })} /></div>
          <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
            onRowClick={(r: any) => nav(`/app/inventory/${r.id}`)} empty={<EmptyState icon={Boxes} title="No items" />} columns={[
              { key: 'sku', header: 'SKU', sortable: true, cell: (r: any) => <span className="font-mono text-xs">{r.sku}</span> },
              { key: 'name', header: 'Item', sortable: true, cell: (r: any) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-slate-500">{r.category}</p></div> },
              { key: 'stock', header: 'On hand', sortable: true, className: 'text-right', cell: (r: any) => <span className={cn('tabular', r.low_stock && 'font-semibold text-red-600')}>{num(r.on_hand)} {r.unit}</span> },
              { key: 'min', header: 'Min', className: 'text-right', hideOnMobile: true, cell: (r: any) => num(r.min_stock) },
              { key: 'cost', header: 'Cost', className: 'text-right', hideOnMobile: true, cell: (r: any) => r.purchase_price !== undefined ? money(r.purchase_price) : '—' },
              { key: 'price', header: 'Price', className: 'text-right', cell: (r: any) => money(r.selling_price) },
              { key: 'flag', header: '', cell: (r: any) => r.low_stock ? <Badge tone="red">Low stock</Badge> : !r.is_active ? <Badge>Inactive</Badge> : null }]} />
        </Card>}
        {tab === 'purchases' && <Card><DataTable rows={purchases} empty={<EmptyState title="No purchases recorded" />} columns={[
          { key: 'd', header: 'Date', cell: (r: any) => date(r.purchase_date) }, { key: 'ref', header: 'Reference', cell: (r: any) => r.reference ?? '—' }, { key: 's', header: 'Supplier', cell: (r: any) => r.supplier_name ?? '—' },
          { key: 'l', header: 'Location', cell: (r: any) => r.location_name }, { key: 'i', header: 'Items', cell: (r: any) => (r.items ?? []).map((x: any) => `${x.sku} × ${Number(x.quantity)}`).join(', ') },
          { key: 't', header: 'Total', className: 'text-right', cell: (r: any) => money(r.total_amount) }]} /></Card>}
        {tab === 'suppliers' && <Card><CardHeader title="Suppliers" actions={manage && <Button size="sm" onClick={() => setSupplier({})}><Plus />Add supplier</Button>} />
          <DataTable rows={suppliers} onRowClick={manage ? (r: any) => setSupplier(r) : undefined} empty={<EmptyState title="No suppliers" />} columns={[
            { key: 'n', header: 'Name', cell: (r: any) => r.name }, { key: 'c', header: 'Contact', cell: (r: any) => [r.contact_name, r.phone, r.email].filter(Boolean).join(' · ') }, { key: 't', header: 'Tax ID', cell: (r: any) => r.tax_id ?? '—' },
            { key: 'a', header: 'Status', cell: (r: any) => r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge> }]} /></Card>}
      </div>
      <FormDialog open={creating} onOpenChange={setCreating} title="New inventory item" size="lg" fields={itemFields(s, suppliers ?? [], true)} defaultValues={{ unit: 'pcs', minStock: 0, taxRateId: s?.taxRates?.find((t: any) => t.is_default)?.id ?? '' }}
        onSubmit={async (v) => { const r = await post('/app/inventory/items', { ...v, purchasePrice: v.purchasePrice ?? 0, sellingPrice: v.sellingPrice ?? 0, minStock: v.minStock ?? 0, openingStock: v.openingStock ?? undefined, unit: v.unit ?? 'pcs' }); qc.invalidateQueries({ queryKey: ['/app/inventory/items'] }); nav(`/app/inventory/${r.data.id}`); }} successMessage="Item created" />
      <FormDialog open={!!supplier} onOpenChange={(o) => !o && setSupplier(null)} title={supplier?.id ? 'Edit supplier' : 'New supplier'}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'contactName', label: 'Contact person' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
          { name: 'taxId', label: 'Tax ID' }, { name: 'isActive', label: 'Active', type: 'checkbox' }, { name: 'address', label: 'Address', type: 'textarea' }]}
        defaultValues={supplier?.id ? { name: supplier.name, contactName: supplier.contact_name ?? '', phone: supplier.phone ?? '', email: supplier.email ?? '', taxId: supplier.tax_id ?? '', isActive: supplier.is_active, address: supplier.address ?? '' } : { isActive: true }}
        onSubmit={async (v) => { supplier?.id ? await patch(`/app/inventory/suppliers/${supplier.id}`, v) : await post('/app/inventory/suppliers', v); qc.invalidateQueries({ queryKey: ['suppliers'] }); }} successMessage="Supplier saved" />
      <PurchaseDialog p={purchase} setP={setPurchase} suppliers={suppliers ?? []} locations={s?.stockLocations ?? []} onDone={() => { qc.invalidateQueries({ queryKey: ['purchases'] }); qc.invalidateQueries({ queryKey: ['/app/inventory/items'] }); }} />
    </div>
  );
}

function PurchaseDialog({ p, setP, suppliers, locations, onDone }: any) {
  const { data: items } = usePaged('/app/inventory/items', { pageSize: 200 }, !!p);
  if (!p) return null;
  const upd = (i: number, k: string, v: any) => setP({ ...p, items: p.items.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)) });
  return (
    <Dialog open onOpenChange={(o) => !o && setP(null)} title="Record purchase" description="Increases stock at the chosen location and updates cost prices." size="lg"
      footer={<Button onClick={() => post('/app/inventory/purchases', { ...p, supplierId: p.supplierId || null, items: p.items.filter((x: any) => x.itemId).map((x: any) => ({ itemId: x.itemId, quantity: Number(x.quantity), unitCost: Number(x.unitCost) })) })
        .then(() => { toast.success('Purchase recorded'); setP(null); onDone(); }).catch(toastError)}>Save purchase</Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Supplier"><Select value={p.supplierId} onChange={(e) => setP({ ...p, supplierId: e.target.value })} placeholder="—" options={suppliers.map((x: any) => ({ value: x.id, label: x.name }))} /></Field>
        <Field label="Into location"><Select value={p.locationId} onChange={(e) => setP({ ...p, locationId: e.target.value })} options={locations.map((l: any) => ({ value: l.id, label: l.name }))} /></Field>
        <Field label="Bill / reference"><Input value={p.reference} onChange={(e) => setP({ ...p, reference: e.target.value })} /></Field>
      </div>
      <div className="mt-4 space-y-2">{p.items.map((x: any, i: number) => (
        <div key={i} className="grid grid-cols-[1fr_90px_110px] gap-2"><Select aria-label="Item" value={x.itemId} onChange={(e) => { const it = items?.data.find((y: any) => y.id === e.target.value); upd(i, 'itemId', e.target.value); if (it?.purchase_price) upd(i, 'unitCost', it.purchase_price); }}
          placeholder="Select item…" options={(items?.data ?? []).map((y: any) => ({ value: y.id, label: `${y.sku} · ${y.name}` }))} />
          <Input aria-label="Quantity" type="number" min={0} step="any" value={x.quantity} onChange={(e) => upd(i, 'quantity', e.target.value)} />
          <Input aria-label="Unit cost" type="number" min={0} step="0.01" value={x.unitCost} onChange={(e) => upd(i, 'unitCost', e.target.value)} /></div>))}
        <Button size="sm" variant="outline" onClick={() => setP({ ...p, items: [...p.items, { itemId: '', quantity: 1, unitCost: 0 }] })}><Plus />Add line</Button></div>
    </Dialog>
  );
}

function ItemDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data: s } = useSettingsLists();
  const { data: suppliers } = useData<any[]>(['suppliers'], '/app/inventory/suppliers');
  const { data: it, isLoading, error, refetch } = useData<any>(['inv-item', id], `/app/inventory/items/${id}`);
  const [edit, setEdit] = useState(false);
  const [adj, setAdj] = useState<any>(null);
  const [tr, setTr] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['inv-item', id] });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div>
      <PageHeader back={<BackLink to="/app/inventory" label="Inventory" />} title={it.name} description={<span className="font-mono">{it.sku}</span>}
        actions={can('inventory.manage') && <><Button variant="outline" onClick={() => setAdj({ locationId: it.stock[0]?.location_id, quantityChange: '', reason: '' })}><SlidersHorizontal />Adjust stock</Button>
          <Button variant="outline" onClick={() => setTr({ fromLocationId: it.stock[0]?.location_id, toLocationId: '', quantity: '' })}><ArrowLeftRight />Transfer</Button><Button variant="outline" onClick={() => setEdit(true)}><Pencil />Edit</Button></>} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4"><StatCard label="On hand" value={`${num(it.onHand)} ${it.unit}`} tone={it.onHand <= Number(it.min_stock) ? 'red' : 'blue'} hint={`Min ${num(it.min_stock)}`} />
        <StatCard label="Used (30 days)" value={num(it.usage.used_30d)} tone="violet" /><StatCard label="Selling price" value={money(it.selling_price)} tone="green" />{it.purchase_price !== undefined && <StatCard label="Cost price" value={money(it.purchase_price)} tone="navy" />}</div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card><CardHeader title="Stock by location" /><ul className="divide-y divide-slate-100 text-sm">{it.stock.map((s: any) => <li key={s.location_id} className="flex justify-between px-5 py-2.5"><span>{s.location_name} <span className="text-xs text-slate-500">{titleCase(s.location_type)}</span></span><span className="tabular font-medium">{num(s.quantity)}</span></li>)}</ul></Card>
        <Card className="lg:col-span-2"><CardHeader title="Stock history" description="Immutable ledger of every movement" />
          <DataTable rows={it.transactions} empty={<EmptyState title="No movements" />} columns={[{ key: 'd', header: 'Date', cell: (r: any) => dateTime(r.created_at) },
            { key: 't', header: 'Type', cell: (r: any) => <Badge tone={Number(r.quantity_change) > 0 ? 'green' : 'amber'}>{titleCase(r.txn_type)}</Badge> }, { key: 'l', header: 'Location', cell: (r: any) => r.location_name },
            { key: 'q', header: 'Change', className: 'text-right', cell: (r: any) => <span className="tabular">{Number(r.quantity_change) > 0 ? '+' : ''}{num(r.quantity_change)}</span> },
            { key: 'a', header: 'After', className: 'text-right', cell: (r: any) => num(r.quantity_after) }, { key: 'r', header: 'Reason', cell: (r: any) => <span className="text-xs">{r.work_order_number ?? r.reason}{r.user_name ? ` · ${r.user_name}` : ''}</span> }]} /></Card>
      </div>
      <FormDialog open={edit} onOpenChange={setEdit} title="Edit item" size="lg" fields={itemFields(s, suppliers ?? [], false)}
        defaultValues={{ sku: it.sku, name: it.name, category: it.category ?? '', unit: it.unit, purchasePrice: it.purchase_price, sellingPrice: it.selling_price, taxRateId: it.tax_rate_id ?? '', minStock: it.min_stock, supplierId: it.supplier_id ?? '', isActive: it.is_active, description: it.description ?? '' }}
        onSubmit={async (v) => { await patch(`/app/inventory/items/${it.id}`, v); refresh(); }} successMessage="Item updated" />
      <Dialog open={!!adj} onOpenChange={(o) => !o && setAdj(null)} title="Adjust stock" description="Use for counts, damage or loss. Positive adds, negative removes." footer={<Button onClick={() => post('/app/inventory/adjustments', { itemId: it.id, locationId: adj.locationId, quantityChange: Number(adj.quantityChange), reason: adj.reason }).then(() => { setAdj(null); refresh(); toast.success('Stock adjusted'); }).catch(toastError)}>Save</Button>}>
        {adj && <div className="grid gap-3 sm:grid-cols-2"><Field label="Location"><Select value={adj.locationId} onChange={(e) => setAdj({ ...adj, locationId: e.target.value })} options={it.stock.map((s: any) => ({ value: s.location_id, label: s.location_name }))} /></Field>
          <Field label="Change (+/−)"><Input type="number" step="any" value={adj.quantityChange} onChange={(e) => setAdj({ ...adj, quantityChange: e.target.value })} /></Field>
          <Field label="Reason" className="sm:col-span-2" required><Textarea rows={2} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field></div>}
      </Dialog>
      <Dialog open={!!tr} onOpenChange={(o) => !o && setTr(null)} title="Transfer stock" footer={<Button onClick={() => post('/app/inventory/transfers', { itemId: it.id, fromLocationId: tr.fromLocationId, toLocationId: tr.toLocationId, quantity: Number(tr.quantity) }).then(() => { setTr(null); refresh(); toast.success('Transferred'); }).catch(toastError)}>Transfer</Button>}>
        {tr && <div className="grid gap-3 sm:grid-cols-3"><Field label="From"><Select value={tr.fromLocationId} onChange={(e) => setTr({ ...tr, fromLocationId: e.target.value })} options={it.stock.map((s: any) => ({ value: s.location_id, label: s.location_name }))} /></Field>
          <Field label="To"><Select value={tr.toLocationId} onChange={(e) => setTr({ ...tr, toLocationId: e.target.value })} placeholder="Select…" options={it.stock.map((s: any) => ({ value: s.location_id, label: s.location_name }))} /></Field>
          <Field label="Quantity"><Input type="number" min={0} step="any" value={tr.quantity} onChange={(e) => setTr({ ...tr, quantity: e.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}
export default function Inventory() { return <Routes><Route index element={<ItemList />} /><Route path=":id" element={<ItemDetail />} /></Routes>; }
export { PackagePlus };
