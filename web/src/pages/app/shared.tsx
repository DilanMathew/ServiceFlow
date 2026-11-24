import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Eye, FileText, ImageIcon, Plus, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, del, get, openFile, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, money } from '@/lib/format';
import { fileSize, titleCase } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Input, Select, Spinner, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';

export const BackLink = ({ to, label }: { to: string; label: string }) => (
  <Link to={to} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />{label}</Link>
);

const CATS = [['photo_before', 'Before photo'], ['photo_after', 'After photo'], ['service_photo', 'Service photo'], ['equipment_document', 'Equipment document'], ['warranty_certificate', 'Warranty certificate'],
  ['contract', 'Contract'], ['customer_attachment', 'Customer attachment'], ['attachment', 'Other']].map(([value, label]) => ({ value, label }));

export function useFilePreview() {
  const [preview, setPreview] = useState<{ url: string; doc: any } | null>(null);
  const open = async (doc: any) => {
    try { const r = await post(`/app/documents/${doc.id}/link`); setPreview({ url: r.data.url, doc }); } catch (e) { toastError(e); }
  };
  const node = (
    <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)} title={preview?.doc.file_name ?? ''} size="xl">
      {preview && (preview.doc.mime_type.startsWith('image/') ? <img src={preview.url} alt={preview.doc.file_name} className="mx-auto max-h-[70vh] rounded-lg" />
        : preview.doc.mime_type === 'application/pdf' ? <iframe title="Preview" src={preview.url} className="h-[70vh] w-full rounded-lg border" sandbox="allow-same-origin" />
        : <p className="text-sm text-slate-500">Preview is not available for this file type. Use download.</p>)}
    </Dialog>
  );
  return { open, node };
}

export function UploadButton({ entityType, entityId, category = 'attachment', visibility = 'internal', onDone, label = 'Upload', capture, accept, variant = 'outline' }: {
  entityType: string; entityId: string; category?: string; visibility?: 'internal' | 'customer'; onDone?: () => void; label?: string; capture?: boolean; accept?: string; variant?: 'outline' | 'primary' | 'secondary';
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('entityType', entityType); fd.append('entityId', entityId); fd.append('category', category); fd.append('visibility', visibility);
      Array.from(files).forEach((f) => fd.append('files', f));
      await api('/app/documents', { method: 'POST', body: fd });
      toast.success(`${files.length} file(s) uploaded`);
      onDone?.();
    } catch (e) { toastError(e); } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  };
  return (<>
    <input ref={ref} type="file" multiple hidden accept={accept ?? 'image/*,application/pdf,.docx,.xlsx,.csv,.txt'} {...(capture ? { capture: 'environment' } : {})} onChange={(e) => upload(e.target.files)} />
    <Button size="sm" variant={variant} loading={busy} onClick={() => ref.current?.click()}><Upload />{label}</Button>
  </>);
}

export function DocumentsPanel({ entityType, entityId, onChange, title = 'Documents' }: { entityType: string; entityId: string; onChange?: () => void; title?: string }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [category, setCategory] = useState('attachment');
  const { data, isLoading } = useQuery({ queryKey: ['docs', entityType, entityId], queryFn: async () => (await get(`/app/documents?entityType=${entityType}&entityId=${entityId}`)).data as any[] });
  const pv = useFilePreview();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['docs', entityType, entityId] }); onChange?.(); };
  return (
    <Card>
      <CardHeader title={title} actions={can('documents.upload') && <div className="flex items-center gap-2"><Select aria-label="Category" className="h-8 w-44 py-1 text-xs" value={category} onChange={(e) => setCategory(e.target.value)} options={CATS} />
        <UploadButton entityType={entityType} entityId={entityId} category={category} onDone={refresh} /></div>} />
      {isLoading ? <div className="p-6"><Spinner /></div> : !data?.length ? <EmptyState icon={FileText} title="No documents" description="Uploads are stored privately and shared only through expiring links." /> : (
        <ul className="divide-y divide-slate-100">{data.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="flex min-w-0 items-center gap-3">{d.mime_type.startsWith('image/') ? <ImageIcon className="h-5 w-5 text-slate-400" /> : <FileText className="h-5 w-5 text-slate-400" />}
              <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{d.file_name}</p><p className="text-xs text-slate-500">{titleCase(d.category)} · {fileSize(Number(d.size_bytes))} · {dateTime(d.created_at)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}</p></div></div>
            <div className="flex shrink-0 gap-1">
              <Button size="icon-sm" variant="ghost" aria-label="Preview" onClick={() => pv.open(d)}><Eye /></Button>
              <Button size="icon-sm" variant="ghost" aria-label="Download" onClick={() => openFile(`/app/documents/${d.id}/download`, d.file_name).catch(toastError)}><Download /></Button>
              {can('documents.delete') && <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={async () => { if (await confirm({ title: 'Delete document?', danger: true, confirmLabel: 'Delete' })) del(`/app/documents/${d.id}`).then(refresh).catch(toastError); }}><Trash2 /></Button>}
            </div>
          </li>))}</ul>)}
      {pv.node}
    </Card>
  );
}

/** Async customer search select. */
export function CustomerPicker({ value, onChange, disabled }: { value: string; onChange: (id: string, c?: any) => void; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const { data: selected } = useQuery({ queryKey: ['customer-min', value], queryFn: async () => (await get(`/app/customers/${value}`)).data, enabled: !!value });
  const { data: results, isFetching } = useQuery({ queryKey: ['customer-search', q], queryFn: async () => (await get(`/app/customers?q=${encodeURIComponent(q)}&pageSize=8`)).data as any[], enabled: open });
  if (value && selected && !open) return (
    <div className="flex items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"><span><span className="font-medium">{selected.full_name}</span> <span className="text-slate-500">· {selected.number} {selected.phone ?? ''}</span></span>
      {!disabled && <button type="button" className="text-slate-400 hover:text-slate-700" aria-label="Change customer" onClick={() => { onChange(''); setOpen(true); }}><X className="h-4 w-4" /></button>}</div>
  );
  return (
    <div className="relative">
      <Input placeholder="Search customer by name, phone or number…" value={q} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
      {open && <div className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-pop">
        {isFetching && !results ? <div className="p-3"><Spinner /></div> : results?.length ? results.map((c) => (
          <button type="button" key={c.id} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50" onMouseDown={() => { onChange(c.id, c); setOpen(false); setQ(''); }}>
            <span className="font-medium">{c.full_name}</span> <span className="text-slate-500">· {c.number} · {c.phone ?? c.email ?? ''}</span></button>))
          : <p className="p-3 text-sm text-slate-500">No customers found</p>}
      </div>}
    </div>
  );
}

export function useSettingsLists() {
  return useQuery({ queryKey: ['settings-lists'], queryFn: async () => (await get('/app/settings')).data, staleTime: 60_000 });
}
export function useTechnicians() {
  return useQuery({ queryKey: ['technicians-min'], queryFn: async () => (await get('/app/technicians?status=active')).data as any[], staleTime: 60_000 });
}

// ---------------------------------------------------------------- line items editor (quotations & invoices)
export interface Line { itemType: 'labour' | 'part' | 'charge' | 'amc'; inventoryItemId?: string | null; description: string; quantity: number; unitPrice: number; discountPercent: number; taxRateId: string | null; hsnSacCode?: string }

export function computeTotals(lines: Line[], rates: any[], inclusive: boolean) {
  let sub = 0, disc = 0, tax = 0;
  for (const l of lines) {
    const rate = Number(rates.find((r) => r.id === l.taxRateId)?.rate ?? 0);
    let gross = Math.round(l.quantity * l.unitPrice * 100);
    const d = Math.round((gross * (l.discountPercent || 0)) / 100);
    let net = gross - d, t: number;
    if (inclusive && rate > 0) { const base = Math.round(net / (1 + rate / 100)); t = net - base; net = base; gross = base + d; } else t = Math.round((net * rate) / 100);
    sub += gross; disc += d; tax += t;
  }
  return { subtotal: sub / 100, discount: disc / 100, tax: tax / 100, total: (sub - disc + tax) / 100 };
}

export function LineItemsEditor({ lines, setLines, invoice }: { lines: Line[]; setLines: (l: Line[]) => void; invoice?: boolean }) {
  const { data: s } = useSettingsLists();
  const { feature } = useAuth();
  const [search, setSearch] = useState('');
  const { data: items } = useQuery({ queryKey: ['inv-items', search], queryFn: async () => (await get(`/app/inventory/items?q=${encodeURIComponent(search)}&pageSize=10`)).data as any[], enabled: feature('inventory') && search.length > 1 });
  const rates = s?.taxRates ?? [];
  const def = rates.find((r: any) => r.is_default)?.id ?? null;
  const totals = useMemo(() => computeTotals(lines, rates, !!s?.settings.prices_include_tax), [lines, rates, s]);
  const upd = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  useEffect(() => { if (def && lines.some((l) => l.taxRateId === undefined)) setLines(lines.map((l) => ({ ...l, taxRateId: l.taxRateId === undefined ? def : l.taxRateId }))); }, [def]); // eslint-disable-line
  const add = (l: Partial<Line> = {}) => setLines([...lines, { itemType: 'labour', description: '', quantity: 1, unitPrice: 0, discountPercent: 0, taxRateId: def, ...l }]);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-[760px] w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="w-28 pb-2">Type</th><th className="pb-2">Description</th>{invoice && <th className="w-24 pb-2">HSN/SAC</th>}<th className="w-20 pb-2">Qty</th>
            <th className="w-28 pb-2">Unit price</th><th className="w-20 pb-2">Disc %</th><th className="w-36 pb-2">Tax</th><th className="w-28 pb-2 text-right">Amount</th><th className="w-8" /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const t = computeTotals([l], rates, !!s?.settings.prices_include_tax);
            return (
              <tr key={i} className="align-top">
                <td className="py-1 pr-2"><Select aria-label="Type" value={l.itemType} onChange={(e) => upd(i, { itemType: e.target.value as any })} options={['labour', 'part', 'charge', ...(invoice ? ['amc'] : [])].map((v) => ({ value: v, label: titleCase(v) }))} /></td>
                <td className="py-1 pr-2"><Input aria-label="Description" value={l.description} onChange={(e) => upd(i, { description: e.target.value })} /></td>
                {invoice && <td className="py-1 pr-2"><Input aria-label="HSN/SAC" value={l.hsnSacCode ?? ''} onChange={(e) => upd(i, { hsnSacCode: e.target.value })} /></td>}
                <td className="py-1 pr-2"><Input aria-label="Quantity" type="number" min={0} step="any" value={l.quantity} onChange={(e) => upd(i, { quantity: Number(e.target.value) })} /></td>
                <td className="py-1 pr-2"><Input aria-label="Unit price" type="number" min={0} step="0.01" value={l.unitPrice} onChange={(e) => upd(i, { unitPrice: Number(e.target.value) })} /></td>
                <td className="py-1 pr-2"><Input aria-label="Discount" type="number" min={0} max={100} value={l.discountPercent} onChange={(e) => upd(i, { discountPercent: Number(e.target.value) })} /></td>
                <td className="py-1 pr-2"><Select aria-label="Tax rate" value={l.taxRateId ?? ''} onChange={(e) => upd(i, { taxRateId: e.target.value || null })} placeholder="No tax" options={rates.filter((r: any) => r.is_active).map((r: any) => ({ value: r.id, label: r.name }))} /></td>
                <td className="py-1 pt-3 text-right tabular">{money(t.total)}</td>
                <td className="py-1"><Button size="icon-sm" variant="ghost" aria-label="Remove line" onClick={() => setLines(lines.filter((_, k) => k !== i))}><X /></Button></td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => add()}><Plus />Add line</Button>
        {feature('inventory') && <div className="relative"><Input className="h-8 w-60 text-xs" placeholder="Add part from inventory…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {items && search.length > 1 && <div className="absolute z-30 mt-1 w-80 rounded-lg border bg-white p-1 shadow-pop">{items.length ? items.map((it) => (
            <button type="button" key={it.id} className="block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-slate-50" onClick={() => { add({ itemType: 'part', inventoryItemId: it.id, description: it.name, unitPrice: Number(it.selling_price) }); setSearch(''); }}>
              {it.sku} · {it.name} · {money(it.selling_price)} <Badge>{Number(it.on_hand)} in stock</Badge></button>)) : <p className="p-2 text-xs text-slate-500">No items</p>}</div>}</div>}
      </div>
      <div className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
        <div className="flex justify-between text-slate-600"><span>Subtotal</span><span className="tabular">{money(totals.subtotal)}</span></div>
        {totals.discount > 0 && <div className="flex justify-between text-slate-600"><span>Discount</span><span className="tabular">−{money(totals.discount)}</span></div>}
        <div className="flex justify-between text-slate-600"><span>Tax</span><span className="tabular">{money(totals.tax)}</span></div>
        <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-navy-900"><span>Total</span><span className="tabular">{money(totals.total)}</span></div>
        <p className="text-[11px] text-slate-400">Final amounts are calculated by the server.</p>
      </div>
    </div>
  );
}

export function TotalsBlock({ d }: { d: any }) {
  return (
    <div className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
      <div className="flex justify-between text-slate-600"><span>Subtotal</span><span className="tabular">{money(d.subtotal, d.currency)}</span></div>
      {Number(d.discount_total) > 0 && <div className="flex justify-between text-slate-600"><span>Discount</span><span className="tabular">−{money(d.discount_total, d.currency)}</span></div>}
      <div className="flex justify-between text-slate-600"><span>Tax</span><span className="tabular">{money(d.tax_total, d.currency)}</span></div>
      {(d.tax_breakdown ?? []).map((t: any) => <div key={t.name + t.rate} className="flex justify-between pl-3 text-xs text-slate-400"><span>{t.name} @ {t.rate}%</span><span className="tabular">{money(t.amount, d.currency)}</span></div>)}
      <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-navy-900"><span>Total</span><span className="tabular">{money(d.total, d.currency)}</span></div>
    </div>
  );
}

export function ItemsTable({ items, currency }: { items: any[]; currency: string }) {
  return (
    <div className="overflow-x-auto"><table className="min-w-full text-sm">
      <thead className="bg-slate-50"><tr><th className="table-th">Item</th><th className="table-th text-right">Qty</th><th className="table-th text-right">Unit price</th><th className="table-th text-right">Tax</th><th className="table-th text-right">Amount</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{items.map((i) => <tr key={i.id}><td className="table-td"><p>{i.description}</p><p className="text-xs text-slate-400">{titleCase(i.item_type)}{Number(i.discount_percent) > 0 && ` · ${Number(i.discount_percent)}% off`}{i.hsn_sac_code && ` · HSN/SAC ${i.hsn_sac_code}`}</p></td>
        <td className="table-td text-right tabular">{Number(i.quantity)}</td><td className="table-td text-right tabular">{money(i.unit_price, currency)}</td><td className="table-td text-right">{Number(i.tax_rate)}%</td><td className="table-td text-right tabular">{money(i.line_total, currency)}</td></tr>)}</tbody>
    </table></div>
  );
}

export function Timeline({ items }: { items: { title: React.ReactNode; meta?: React.ReactNode; body?: React.ReactNode }[] }) {
  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5">
      {items.map((it, i) => <li key={i} className="relative"><span className="absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500 ring-1 ring-brand-200" />
        <p className="text-sm font-medium text-slate-800">{it.title}</p>{it.meta && <p className="text-xs text-slate-500">{it.meta}</p>}{it.body && <p className="mt-1 text-sm text-slate-600">{it.body}</p>}</li>)}
    </ol>
  );
}
