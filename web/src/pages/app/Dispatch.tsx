import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, UserPlus } from 'lucide-react';
import { useData } from '@/lib/hooks';
import { dateTime, time, ymd } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, PageHeader, PageLoader, StatusBadge } from '@/components/ui';
import { AssignDialog, PriorityBadge } from './WorkOrders';

const STATUS_BG: Record<string, string> = { assigned: 'bg-violet-100 border-violet-300 text-violet-900', en_route: 'bg-amber-100 border-amber-300 text-amber-900', in_progress: 'bg-amber-100 border-amber-400 text-amber-900',
  on_hold: 'bg-red-50 border-red-300 text-red-900', completed: 'bg-emerald-50 border-emerald-300 text-emerald-900', invoiced: 'bg-emerald-50 border-emerald-300 text-emerald-900', paid: 'bg-emerald-50 border-emerald-300 text-emerald-900' };

export default function Dispatch() {
  const qc = useQueryClient();
  // Empty = "today" in the BUSINESS time zone (resolved by the server), not the browser's.
  const [day, setDay] = useState('');
  const { data, isLoading, error, refetch } = useData<any>(['dispatch', day], `/app/dispatch/board${day ? `?date=${day}` : ''}`, { refetchInterval: 60_000 });
  const [assign, setAssign] = useState<any>(null);
  const shift = (n: number) => { const d = new Date(`${data?.date ?? ymd(new Date())}T12:00:00`); d.setDate(d.getDate() + n); setDay(ymd(d)); };
  const hours = useMemo(() => {
    const s = Number((data?.workingHours.start ?? '08:00').slice(0, 2)), e = Number((data?.workingHours.end ?? '19:00').slice(0, 2)) + 1;
    return Array.from({ length: Math.max(1, e - s) }, (_, i) => s + i);
  }, [data]);
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const first = hours[0], span = hours.length;
  const pos = (iso: string) => { const d = new Date(iso); const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: data.timezone }).format(d)) + d.getMinutes() / 60; return ((h - first) / span) * 100; };
  return (
    <div>
      <PageHeader title="Dispatch & scheduling" description="Assign the unassigned queue and balance technician workloads. Suggestions are advisory — you decide."
        actions={<div className="flex items-center gap-2"><Button size="icon" variant="outline" onClick={() => shift(-1)} aria-label="Previous day"><ChevronLeft /></Button>
          <Input type="date" className="w-40" value={day || data?.date || ''} onChange={(e) => setDay(e.target.value)} /><Button size="icon" variant="outline" onClick={() => shift(1)} aria-label="Next day"><ChevronRight /></Button>
          <Button variant="outline" onClick={() => setDay('')}>Today</Button></div>} />
      {data.conflicts.length > 0 && <div className="mb-4"><Alert tone="red" title="Overlapping assignments">{data.conflicts.map((c: any) => `${c.job_a} ↔ ${c.job_b}`).join(', ')} — double booking is currently allowed in settings.</Alert></div>}
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card className="overflow-hidden">
          <CardHeader title={new Date(`${data.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} description={`${data.technicians.length} technicians · times in ${data.timezone}`} />
          <div className="overflow-x-auto"><div className="min-w-[860px]">
            <div className="grid grid-cols-[180px_1fr] border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
              <div className="px-4 py-2 font-medium">Technician</div>
              <div className="relative h-8">{hours.map((h, i) => <span key={h} className="absolute top-2" style={{ left: `${(i / span) * 100}%` }}>{String(h).padStart(2, '0')}:00</span>)}</div>
            </div>
            {data.technicians.map((t: any) => (
              <div key={t.id} className="grid grid-cols-[180px_1fr] border-b border-slate-100">
                <div className="px-4 py-3"><p className="truncate text-sm font-medium text-slate-800">{t.full_name}</p>
                  <p className="text-xs text-slate-500">{t.on_leave ? <Badge tone="amber">On leave</Badge> : `${t.assignments.length}/${t.max_jobs_per_day} jobs`}</p></div>
                <div className={cn('relative h-16', t.on_leave && 'bg-[repeating-linear-gradient(45deg,#fff7ed,#fff7ed_6px,#fff_6px,#fff_12px)]')}>
                  {hours.map((_, i) => <span key={i} className="absolute inset-y-0 border-l border-slate-100" style={{ left: `${(i / span) * 100}%` }} />)}
                  {t.assignments.map((a: any) => { const l = Math.max(0, pos(a.starts_at)), r = Math.min(100, pos(a.ends_at)); return (
                    <Link key={a.id} to={`/app/work-orders/${a.id}`} title={`${a.number} · ${a.customer_name} · ${time(a.starts_at)}–${time(a.ends_at)}`}
                      className={cn('absolute top-2 bottom-2 overflow-hidden rounded-md border px-2 py-1 text-[11px] leading-tight shadow-sm hover:z-10 hover:shadow-pop', STATUS_BG[a.status] ?? 'bg-brand-50 border-brand-300 text-brand-900')}
                      style={{ left: `${l}%`, width: `${Math.max(2.5, r - l)}%` }}><p className="truncate font-semibold">{a.number}</p><p className="truncate">{a.customer_name}{a.city ? ` · ${a.city}` : ''}</p></Link>); })}
                </div>
              </div>))}
            {!data.technicians.length && <EmptyState title="No active technicians" />}
          </div></div>
        </Card>
        <Card><CardHeader title="Unassigned queue" description="Highest priority first" actions={<Badge tone={data.unassigned.length ? 'amber' : 'green'}>{data.unassigned.length}</Badge>} />
          <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">{data.unassigned.length ? data.unassigned.map((w: any) => (
            <li key={w.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><Link to={`/app/work-orders/${w.id}`} className="text-sm font-medium text-brand-700">{w.number}</Link>
                <p className="truncate text-sm text-slate-700">{w.title}</p><p className="text-xs text-slate-500">{w.customer_name}{w.city ? ` · ${w.city}` : ''} · {w.category_name ?? 'General'}</p>
                <p className="mt-0.5 text-xs text-slate-500">{w.scheduled_start ? `Wanted ${dateTime(w.scheduled_start)}` : 'No time set'} · {w.expected_duration_minutes} min</p></div>
                <div className="flex flex-col items-end gap-1"><PriorityBadge p={w.priority} /><StatusBadge status={w.status} /></div></div>
              <Button size="sm" className="mt-2 w-full" variant="outline" onClick={() => setAssign(w)}><UserPlus />Assign</Button>
            </li>)) : <EmptyState title="All jobs are assigned" />}</ul></Card>
      </div>
      {assign && <AssignDialog wo={assign} open={!!assign} onOpenChange={(o) => !o && setAssign(null)} onDone={() => { qc.invalidateQueries({ queryKey: ['dispatch'] }); refetch(); }} />}
      <p className="mt-3 flex items-center gap-1 text-xs text-slate-400"><AlertTriangle className="h-3.5 w-3.5" />Travel times are estimates unless a maps provider is configured. </p>
    </div>
  );
}
