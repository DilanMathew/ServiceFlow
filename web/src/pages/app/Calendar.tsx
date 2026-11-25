import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useData } from '@/lib/hooks';
import { time } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, ErrorState, PageHeader, PageLoader, Select } from '@/components/ui';
import { useTechnicians } from './shared';
import { t } from '@/lib/i18n';
import { dfmt } from '@/lib/format';

type View = 'month' | 'week' | 'day';
export function CalendarView({ base = '/app/work-orders', techMode }: { base?: string; techMode?: boolean }) {
  const [view, setView] = useState<View>(techMode ? 'week' : 'month');
  const [cursor, setCursor] = useState(new Date());
  const [tech, setTech] = useState('');
  const { data: techs } = useTechnicians();
  const range = useMemo(() => view === 'month' ? [startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), addDays(endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }), 1)]
    : view === 'week' ? [startOfWeek(cursor, { weekStartsOn: 1 }), addDays(startOfWeek(cursor, { weekStartsOn: 1 }), 7)] : [new Date(format(cursor, 'yyyy-MM-dd') + 'T00:00:00'), addDays(new Date(format(cursor, 'yyyy-MM-dd') + 'T00:00:00'), 1)], [view, cursor]);
  const { data, isLoading, error, refetch } = useData<any>(['calendar', range[0].toISOString(), view, tech], `/app/calendar?from=${range[0].toISOString()}&to=${range[1].toISOString()}${tech ? `&technicianId=${tech}` : ''}`);
  const days: Date[] = []; for (let d = range[0]; d < range[1]; d = addDays(d, 1)) days.push(d);
  const move = (n: number) => setCursor(view === 'month' ? addMonths(cursor, n) : addDays(cursor, n * (view === 'week' ? 7 : 1)));
  const events = (d: Date) => [
    ...(data?.jobs ?? []).filter((j: any) => isSameDay(new Date(j.start), d)).map((j: any) => ({ key: j.id, link: `${base}/${j.id}`, label: `${time(j.start)} ${j.number}`, sub: `${j.customer_name}${j.technician_name ? ` · ${j.technician_name}` : ''}`,
      cls: j.overdue ? 'border-red-300 bg-red-50 text-red-800' : j.is_amc ? 'border-teal-300 bg-teal-50 text-teal-900' : j.rescheduled ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-brand-200 bg-brand-50 text-brand-900' })),
    ...(data?.visits ?? []).filter((v: any) => isSameDay(new Date(`${v.due_date}T12:00:00`), d)).map((v: any) => ({ key: v.id, link: `/app/amc/${v.contract_id}`, label: t('AMC visit {n}', { n: v.visit_number }), sub: v.customer_name, cls: 'border-teal-300 border-dashed bg-white text-teal-800' })),
    ...(data?.leave ?? []).filter((l: any) => new Date(l.start) <= addDays(d, 1) && new Date(l.end) >= d).map((l: any) => ({ key: l.id + d, link: '', label: t('{name} on leave', { name: l.technician_name }), sub: l.reason ?? '', cls: 'border-slate-200 bg-slate-100 text-slate-600' })),
  ];
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="icon" variant="outline" onClick={() => move(-1)} aria-label={t('Previous')}><ChevronLeft /></Button><Button size="icon" variant="outline" onClick={() => move(1)} aria-label={t('Next')}><ChevronRight /></Button>
        <Button variant="outline" onClick={() => setCursor(new Date())}>{t('Today')}</Button>
        <h2 className="ml-2 text-lg font-semibold text-navy-900">{dfmt(cursor, view === 'day' ? 'EEEE d MMMM yyyy' : 'MMMM yyyy')}</h2>
        <div className="ml-auto flex gap-2">
          {!techMode && <Select aria-label={t('Technician')} className="w-48" value={tech} onChange={(e) => setTech(e.target.value)} placeholder={t('All technicians')} options={(techs ?? []).map((x) => ({ value: x.id, label: x.full_name }))} />}
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">{(['month', 'week', 'day'] as View[]).map((v) => <Button key={v} size="sm" variant={view === v ? 'secondary' : 'ghost'} onClick={() => setView(v)}>{v === 'month' ? t('Month') : v === 'week' ? t('Week') : t('Day')}</Button>)}</div>
        </div>
      </div>
      {error ? <ErrorState error={error} onRetry={refetch} /> : isLoading ? <PageLoader /> : (
        <Card className="overflow-hidden">
          <div className={cn('grid border-b border-slate-100 bg-slate-50 text-xs font-medium text-slate-500', view === 'day' ? 'grid-cols-1' : 'grid-cols-7')}>
            {(view === 'day' ? [cursor] : days.slice(0, 7)).map((d) => <div key={d.toISOString()} className="px-2 py-2">{dfmt(d, view === 'day' ? 'EEEE' : 'EEE')}</div>)}</div>
          <div className={cn('grid', view === 'day' ? 'grid-cols-1' : 'grid-cols-7')}>
            {days.map((d) => { const ev = events(d); const hol = data?.holidays?.find((h: any) => h.date === format(d, 'yyyy-MM-dd')); return (
              <div key={d.toISOString()} className={cn('border-b border-r border-slate-100 p-1.5', view === 'month' ? 'min-h-[110px]' : 'min-h-[420px]', view === 'month' && !isSameMonth(d, cursor) && 'bg-slate-50/60')}>
                <div className="mb-1 flex items-center justify-between px-1"><span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs', isSameDay(d, new Date()) ? 'bg-brand-600 font-semibold text-white' : 'text-slate-600')}>{format(d, 'd')}</span>
                  {hol && <Badge tone="amber">{hol.name}</Badge>}</div>
                <div className="space-y-1">{ev.slice(0, view === 'month' ? 4 : 50).map((e) => { const inner = <><p className="truncate font-medium">{e.label}</p>{view !== 'month' && <p className="truncate">{e.sub}</p>}</>;
                  return e.link ? <Link key={e.key} to={e.link} title={`${e.label} · ${e.sub}`} className={cn('block rounded border px-1.5 py-0.5 text-[11px] hover:shadow-sm', e.cls)}>{inner}</Link>
                    : <div key={e.key} className={cn('rounded border px-1.5 py-0.5 text-[11px]', e.cls)}>{inner}</div>; })}
                  {view === 'month' && ev.length > 4 && <button className="px-1 text-[11px] text-brand-700" onClick={() => { setCursor(d); setView('day'); }}>{t('+{n} more', { n: ev.length - 4 })}</button>}</div>
              </div>); })}
          </div>
        </Card>)}
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500"><span className="flex items-center gap-1"><span className="h-3 w-3 rounded border border-brand-200 bg-brand-50" />{t('Job')}</span>
        <span className="flex items-center gap-1"><span className="h-3 w-3 rounded border border-teal-300 bg-teal-50" />{t('AMC')}</span><span className="flex items-center gap-1"><span className="h-3 w-3 rounded border border-amber-300 bg-amber-50" />{t('Rescheduled')}</span>
        <span className="flex items-center gap-1"><span className="h-3 w-3 rounded border border-red-300 bg-red-50" />{t('Overdue')}</span><span className="flex items-center gap-1"><span className="h-3 w-3 rounded border bg-slate-100" />{t('Leave')}</span></div>
    </div>
  );
}
export default function CalendarPage() { return <div><PageHeader title="Calendar" description="Jobs, AMC visits, leave and holidays." /><CalendarView /></div>; }
