import { useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import { BarChart3, Download, FileDown, Lock, Printer } from 'lucide-react';
import { openFile } from '@/lib/api';
import { useData } from '@/lib/hooks';
import { money, num, ymd } from '@/lib/format';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Select } from '@/components/ui';
import { toastError } from '@/components/form';
import { BackLink, useTechnicians, useSettingsLists } from './shared';

function ReportIndex() {
  const { data, isLoading, error, refetch } = useData<any[]>(['reports'], '/app/reports');
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div>
      <PageHeader title="Reports" description="Financial reports separate invoiced revenue, actual payments and estimates." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data!.map((r) => {
          const inner = <Card className={`h-full p-5 transition ${r.available ? 'hover:border-brand-300 hover:shadow-pop' : 'opacity-60'}`}>
            <div className="flex items-start justify-between gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><BarChart3 className="h-[18px] w-[18px]" /></div>
              {r.financial && <Badge tone="navy">Financial</Badge>}{r.requiresUpgrade && <Badge tone="amber"><Lock className="h-3 w-3" />Upgrade</Badge>}</div>
            <h3 className="mt-3 font-semibold text-navy-900">{r.title}</h3><p className="mt-1 text-sm text-slate-500">{r.description}</p></Card>;
          return r.available ? <Link key={r.key} to={`/app/reports/${r.key}`}>{inner}</Link> : <div key={r.key}>{inner}</div>;
        })}
      </div>
    </div>
  );
}

function ReportView() {
  const { key } = useParams();
  const { data: techs } = useTechnicians();
  const { data: s } = useSettingsLists();
  const [f, setF] = useState({ from: ymd(new Date(Date.now() - 90 * 864e5)), to: ymd(new Date()), groupBy: 'month', technicianId: '', categoryId: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as any).toString();
  const { data: r, isLoading, error, refetch } = useData<any>(['report', key, qs], `/app/reports/${key}?${qs}`);
  const fmt = (v: any, t?: string) => v === null || v === undefined ? '—' : t === 'money' ? money(v, r?.currency) : t === 'percent' ? `${v}%` : t === 'number' ? num(v) : String(v);
  return (
    <div>
      <PageHeader back={<BackLink to="/app/reports" label="Reports" />} title={r?.title ?? 'Report'} description={r?.description}
        actions={<><Button variant="outline" onClick={() => openFile(`/app/reports/${key}?${qs}&format=csv`, `${key}.csv`).catch(toastError)}><Download />CSV</Button>
          <Button variant="outline" onClick={() => openFile(`/app/reports/${key}?${qs}&format=pdf`).catch(toastError)}><FileDown />PDF</Button>
          <Button variant="outline" onClick={() => window.print()}><Printer />Print</Button></>} />
      <Card className="mb-4 print:hidden"><CardBody className="flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Group by"><Select value={f.groupBy} onChange={(e) => setF({ ...f, groupBy: e.target.value })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} /></Field>
        <Field label="Technician"><Select className="w-44" value={f.technicianId} onChange={(e) => setF({ ...f, technicianId: e.target.value })} placeholder="All" options={(techs ?? []).map((t) => ({ value: t.id, label: t.full_name }))} /></Field>
        <Field label="Category"><Select className="w-44" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} placeholder="All" options={(s?.serviceCategories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
      </CardBody></Card>
      {error ? <ErrorState error={error} onRetry={refetch} /> : isLoading ? <PageLoader /> : <>
        {r.summary && <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">{Object.entries(r.summary).map(([k, v]) => (
          <Card key={k} className="p-4"><p className="text-xs uppercase text-slate-500">{k.replace(/_/g, ' ')}</p><p className="mt-1 text-xl font-semibold text-navy-900 tabular">{/value|invoiced|collected|refunded|tax|outstanding|overdue/.test(k) ? money(v as number, r.currency) : /rate/.test(k) ? `${v}%` : num(v as number)}</p></Card>))}</div>}
        {r.notes && <div className="mb-4"><Alert tone="blue">{r.notes}</Alert></div>}
        <Card><CardHeader title={`${r.rows.length} rows`} description={`Generated ${new Date(r.generatedAt).toLocaleString()} · amounts in ${r.currency}`} />
          <DataTable rows={r.rows.map((x: any, i: number) => ({ ...x, id: String(i) }))} empty={<EmptyState title="No data for this period" />}
            columns={r.columns.map((c: any) => ({ key: c.key, header: c.label, className: ['money', 'number', 'percent'].includes(c.type) ? 'text-right tabular' : '', cell: (row: any) => fmt(row[c.key], c.type) }))} /></Card>
      </>}
    </div>
  );
}
export default function Reports() { return <Routes><Route index element={<ReportIndex />} /><Route path=":key" element={<ReportView />} /></Routes>; }
