import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCheck, CreditCard, Download } from 'lucide-react';
import { toast } from 'sonner';
import { openFile, post } from '@/lib/api';
import { useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { dateTime, money } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Badge, Button, Card, DataTable, EmptyState, PageHeader, SearchInput, Select, StatusBadge } from '@/components/ui';
import { toastError } from '@/components/form';

export default function Payments() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { params, set, sort, toggleSort } = useListState();
  const { data, isLoading, error, refetch } = usePaged('/app/payments', params);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const reconcile = async (reconciled: boolean) => {
    try { const r = await post('/app/payments/reconcile', { ids: [...sel], reconciled }); toast.success(`${r.data.updated} payment(s) ${reconciled ? 'reconciled' : 'unreconciled'}`); setSel(new Set()); qc.invalidateQueries({ queryKey: ['/app/payments'] }); } catch (e) { toastError(e); }
  };
  return (
    <div>
      <PageHeader title="Payments" description="Money received from your customers, refunds and bank reconciliation."
        actions={<Button variant="outline" onClick={() => openFile(`/app/payments?format=csv`, 'payments.csv').catch(toastError)}><Download />Export</Button>} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} placeholder="Receipt, reference, invoice, customer…" />
          <Select aria-label="Status" className="w-36" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={['succeeded', 'pending', 'failed'].map((s) => ({ value: s, label: titleCase(s) }))} />
          <Select aria-label="Method" className="w-40" value={params.method ?? ''} onChange={(e) => set({ method: e.target.value })} placeholder="All methods" options={['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'gateway', 'other'].map((s) => ({ value: s, label: titleCase(s) }))} />
          <Select aria-label="Reconciliation" className="w-44" value={params.reconciled ?? ''} onChange={(e) => set({ reconciled: e.target.value })} placeholder="Any reconciliation" options={[{ value: 'no', label: 'Not reconciled' }, { value: 'yes', label: 'Reconciled' }]} />
        </div>
        {sel.size > 0 && can('payments.reconcile') && <div className="flex items-center gap-2 border-b border-slate-100 bg-brand-50 px-4 py-2 text-sm"><span className="font-medium">{sel.size} selected</span>
          <Button size="sm" onClick={() => reconcile(true)}><CheckCheck />Mark reconciled</Button><Button size="sm" variant="outline" onClick={() => reconcile(false)}>Unreconcile</Button></div>}
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
          selectable={can('payments.reconcile')} selected={sel} onSelect={setSel} onRowClick={(r: any) => nav(`/app/invoices/${r.invoice_id}`)} empty={<EmptyState icon={CreditCard} title="No payments yet" />}
          columns={[
            { key: 'received', header: 'Date', sortable: true, cell: (r: any) => dateTime(r.received_at) },
            { key: 'r', header: 'Receipt', cell: (r: any) => <div><p className="font-medium">{r.receipt_number ?? '—'}</p><p className="text-xs text-slate-500">{r.invoice_number}</p></div> },
            { key: 'c', header: 'Customer', cell: (r: any) => r.customer_name },
            { key: 'm', header: 'Method', hideOnMobile: true, cell: (r: any) => <div><p>{titleCase(r.method)}{r.provider && r.provider !== 'manual' && ` · ${r.provider}`}</p><p className="max-w-[160px] truncate text-xs text-slate-500">{r.reference ?? r.provider_payment_id ?? r.failure_reason ?? ''}</p></div> },
            { key: 'amount', header: 'Amount', sortable: true, className: 'text-right', cell: (r: any) => <div className="tabular"><p>{money(r.amount, r.currency)}</p>{Number(r.refunded) > 0 && <p className="text-xs text-amber-700">−{money(r.refunded, r.currency)} refunded</p>}</div> },
            { key: 's', header: 'Status', cell: (r: any) => <div className="flex gap-1"><StatusBadge status={r.status} />{r.reconciled_at && <Badge tone="green">Reconciled</Badge>}</div> },
          ]} />
      </Card>
    </div>
  );
}
