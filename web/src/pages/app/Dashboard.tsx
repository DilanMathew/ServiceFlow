import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, AlertTriangle, CalendarClock, CheckCircle2, ClipboardList, Clock3, CreditCard, FileWarning, Inbox, Info, PlayCircle, ScrollText, Truck, Wallet, XCircle } from 'lucide-react';
import { useData } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { compactMoney, dateTime, ago, money } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Card, CardBody, CardHeader, EmptyState, ErrorState, Input, PageHeader, Select, Skeleton, StatCard, StatusBadge } from '@/components/ui';
import { AgingBars, GroupedBarChart, SimpleBarChart } from '@/components/charts';

const PERIODS = [{ value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'last_month', label: 'Last month' },
  { value: 'quarter', label: 'This quarter' }, { value: 'year', label: 'This year' }, { value: 'custom', label: 'Custom range' }];

export default function Dashboard() {
  const nav = useNavigate();
  const { me } = useAuth();
  const [period, setPeriod] = useState('month');
  const [range, setRange] = useState({ from: '', to: '' });
  const q = period === 'custom' ? `period=custom&from=${range.from}&to=${range.to}` : `period=${period}`;
  const { data, isLoading, error, refetch } = useData<any>(['dashboard', q], period === 'custom' && (!range.from || !range.to) ? null : `/app/dashboard?${q}`);
  const k = data?.kpi, m = data?.money;

  return (
    <div>
      <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${me?.user.full_name.split(' ')[0]}`}
        description={`${me?.tenant?.name} · figures calculated live from your records`}
        actions={<div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Period" className="w-40" value={period} onChange={(e) => setPeriod(e.target.value)} options={PERIODS} />
          {period === 'custom' && <><Input type="date" aria-label="From" className="w-40" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <Input type="date" aria-label="To" className="w-40" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></>}
        </div>} />
      {error ? <ErrorState error={error} onRetry={refetch} /> : (<>
        {data?.alerts?.length > 0 && (
          <div className="mb-6 grid gap-2 md:grid-cols-2">
            {data.alerts.map((a: any, i: number) => {
              const Icon = a.level === 'critical' ? AlertCircle : a.level === 'warning' ? AlertTriangle : Info;
              return <Link key={i} to={a.link} className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm transition hover:shadow-card ${a.level === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : a.level === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-brand-200 bg-brand-50 text-brand-900'}`}>
                <Icon className="h-4 w-4 shrink-0" />{a.message}</Link>;
            })}
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {isLoading ? Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />) : <>
            <StatCard label="Service requests" value={k.total_requests} hint="in period" icon={Inbox} onClick={() => nav('/app/requests')} />
            <StatCard label="New requests" value={k.new_requests} hint="awaiting review" icon={Inbox} tone="violet" onClick={() => nav('/app/requests?status=new,under_review')} />
            <StatCard label="Pending jobs" value={k.pending_jobs} hint="not yet assigned" icon={Clock3} tone="amber" onClick={() => nav('/app/work-orders?status=new,approved,scheduled')} />
            <StatCard label="Assigned" value={k.assigned_jobs} hint="assigned / en route" icon={Truck} tone="violet" onClick={() => nav('/app/work-orders?status=assigned,en_route')} />
            <StatCard label="In progress" value={k.in_progress_jobs} hint="incl. on hold" icon={PlayCircle} tone="amber" onClick={() => nav('/app/work-orders?status=in_progress,on_hold')} />
            <StatCard label="Completed" value={k.completed_jobs} hint="in period" icon={CheckCircle2} tone="green" onClick={() => nav('/app/work-orders?status=completed,invoiced,paid')} />
            <StatCard label="Cancelled" value={k.cancelled_jobs} hint="in period" icon={XCircle} tone="red" />
            {m && <>
              <StatCard label="Invoiced revenue" value={compactMoney(m.invoiced, m.currency)} hint="issued invoices" icon={ClipboardList} tone="navy" onClick={() => nav('/app/invoices')} />
              <StatCard label="Collected" value={compactMoney(m.collected, m.currency)} hint="payments, net of refunds" icon={Wallet} tone="green" onClick={() => nav('/app/payments')} />
              <StatCard label="Outstanding" value={compactMoney(m.outstanding, m.currency)} hint={`${compactMoney(m.overdue, m.currency)} overdue`} icon={FileWarning} tone="red" onClick={() => nav('/app/invoices?status=issued,partially_paid,overdue')} />
            </>}
            <StatCard label="Active AMCs" value={k.active_amc} icon={ScrollText} tone="blue" onClick={() => nav('/app/amc?status=active')} />
            <StatCard label="Upcoming visits" value={k.upcoming_visits} hint="next 30 days" icon={CalendarClock} tone="violet" onClick={() => nav('/app/calendar')} />
          </>}
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          {data?.charts.revenueByMonth && <Card className="xl:col-span-2"><CardHeader title="Revenue by month" description="Issued invoices vs payments received (last 12 months)" />
            <CardBody><GroupedBarChart fmt={(v) => compactMoney(v)} data={data.charts.revenueByMonth.map((r: any) => ({ month: new Date(`${r.month}-01T12:00:00`).toLocaleString(undefined, { month: 'short' }), invoiced: Number(r.invoiced), collected: Number(r.collected) }))}
              x="month" series={[{ key: 'invoiced', name: 'Invoiced' }, { key: 'collected', name: 'Collected' }]} /></CardBody></Card>}
          <Card className={data?.charts.revenueByMonth ? '' : 'xl:col-span-3'}><CardHeader title="Jobs by status" description="Open jobs plus jobs created in the period" />
            <CardBody>{data?.charts.jobsByStatus?.length ? <SimpleBarChart data={data.charts.jobsByStatus} x="status" y="count" horizontal height={260} /> : <EmptyState title="No jobs yet" />}</CardBody></Card>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
          <Card><CardHeader title="Jobs by service category" /><CardBody>{data?.charts.jobsByCategory?.length ? <SimpleBarChart data={data.charts.jobsByCategory} x="category" y="count" horizontal labelFmt={(v) => v} height={240} /> : <EmptyState title="No jobs in this period" />}</CardBody></Card>
          <Card><CardHeader title="Technician performance" description="Completed in period vs currently open" />
            <CardBody>{data?.charts.technicianPerformance?.length ? <GroupedBarChart data={data.charts.technicianPerformance.map((t: any) => ({ ...t, technician: t.technician.split(' ')[0] }))} x="technician" series={[{ key: 'completed', name: 'Completed' }, { key: 'open', name: 'Open' }]} height={240} /> : <EmptyState title="No technicians yet" />}</CardBody></Card>
          <Card><CardHeader title="Customer growth" description="New customers per month" /><CardBody><SimpleBarChart data={data?.charts.customerGrowth ?? []} x="month" y="new_customers" labelFmt={(v) => new Date(`${v}-01`).toLocaleString(undefined, { month: 'short' })} height={240} /></CardBody></Card>
          {data?.charts.outstandingAging && <Card><CardHeader title="Outstanding invoices by age" description="Balance due, by days past due date" />
            <CardBody><AgingBars buckets={[['Not due', 'current'], ['1–30', 'd1_30'], ['31–60', 'd31_60'], ['61–90', 'd61_90'], ['90+', 'd90_plus']].map(([label, key]) => ({ label, value: Number(data.charts.outstandingAging[key]) }))} height={220} /></CardBody></Card>}
          {data?.charts.paymentMethods && <Card><CardHeader title="Payment collection by method" description="Successful payments in period" />
            <CardBody>{data.charts.paymentMethods.length ? <SimpleBarChart data={data.charts.paymentMethods.map((p: any) => ({ ...p, amount: Number(p.amount) }))} x="method" y="amount" fmt={(v) => compactMoney(v)} horizontal height={220} /> : <EmptyState icon={CreditCard} title="No payments in this period" />}</CardBody></Card>}
          <Card><CardHeader title="Upcoming jobs" actions={<Link to="/app/calendar" className="text-xs font-medium text-brand-700">Calendar</Link>} />
            <ul className="divide-y divide-slate-100">{data?.upcoming?.length ? data.upcoming.map((u: any) => (
              <li key={u.id}><Link to={`/app/work-orders/${u.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                <span className="min-w-0"><span className="block truncate text-sm font-medium text-slate-800">{u.number} · {u.customer_name}</span>
                  <span className="block truncate text-xs text-slate-500">{dateTime(u.scheduled_start)} · {u.technician_name ?? 'Unassigned'}</span></span><StatusBadge status={u.status} /></Link></li>))
              : <EmptyState title="Nothing scheduled" description="Upcoming visits will appear here." />}</ul></Card>
          <Card className="lg:col-span-2 xl:col-span-3"><CardHeader title="Recent activity" />
            <ul className="divide-y divide-slate-100">{data?.activity?.map((a: any, i: number) => (
              <li key={i} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm"><span className="min-w-0 truncate"><span className="font-medium text-slate-700">{titleCase(a.action.replace('.', ' · '))}</span>
                <span className="text-slate-500"> {a.after_data?.number ?? ''} {a.user_email ? `by ${a.user_email}` : ''}</span></span><span className="shrink-0 text-xs text-slate-400">{ago(a.created_at)}</span></li>))}</ul></Card>
        </div>
        {m && <p className="mt-4 text-xs text-slate-400">Pipeline estimate for open jobs: {money(m.pipeline_estimate, m.currency)} (estimates are not revenue).</p>}
      </>)}
    </div>
  );
}
