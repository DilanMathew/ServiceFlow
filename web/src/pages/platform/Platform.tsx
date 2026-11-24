import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Eye, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { patch, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useData, useListState, usePaged } from '@/lib/hooks';
import { compactMoney, date, dateTime, money, num } from '@/lib/format';
import { fileSize, titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, DescriptionList, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatCard, StatusBadge, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';
import { GroupedBarChart, SimpleBarChart } from '@/components/charts';
import Profile from '../app/Profile';

function Overview() {
  const { data, isLoading, error, refetch } = useData<any>(['p-overview'], '/platform/overview');
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const t = data.totals;
  return (
    <div>
      <PageHeader title="Platform overview" description="NEXUS ServiceFlow SaaS metrics (demo tenants excluded from revenue)." />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <StatCard label="Businesses" value={t.total} /><StatCard label="Active" value={t.active_tenants} tone="green" /><StatCard label="Trials" value={t.trials} tone="violet" /><StatCard label="Paying" value={t.paying} tone="navy" />
        <StatCard label="At risk" value={t.at_risk} tone="amber" hint="past due / grace" /><StatCard label="Suspended" value={t.suspended} tone="red" /><StatCard label="Cancelled" value={t.cancelled} tone="red" />
        <StatCard label="Failed payments" value={data.failed.failed_invoices} tone="red" hint={compactMoney(data.failed.failed_amount, 'USD')} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">{data.mrr.length ? data.mrr.map((m: any) => <StatCard key={m.currency} label={`MRR (${m.currency})`} value={money(m.mrr, m.currency)} tone="green" />) : <StatCard label="MRR" value="—" />}
        <StatCard label="Jobs (30 days)" value={num(data.usage.jobs_30d)} /><StatCard label="Staff users" value={num(data.usage.staff_users)} /><StatCard label="Storage" value={fileSize(Number(data.usage.storage_bytes))} /></div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card><CardHeader title="Tenant growth" description="New sign-ups vs churned per month" /><CardBody><GroupedBarChart data={data.growth.map((g: any) => ({ ...g, month: new Date(`${g.month}-01T12:00:00`).toLocaleString(undefined, { month: 'short' }) }))} x="month" series={[{ key: 'new_tenants', name: 'New' }, { key: 'churned', name: 'Churned' }]} /></CardBody></Card>
        <Card><CardHeader title="Subscription revenue collected" description="Paid NEXUS invoices per month" /><CardBody><SimpleBarChart data={data.growth.map((g: any) => ({ month: new Date(`${g.month}-01T12:00:00`).toLocaleString(undefined, { month: 'short' }), revenue: Number(g.revenue) }))} x="month" y="revenue" labelFmt={(v) => v} fmt={(v) => compactMoney(v, 'USD')} /></CardBody></Card>
        <Card><CardHeader title="Plan distribution" /><CardBody><SimpleBarChart data={data.plans} x="name" y="tenants" horizontal labelFmt={(v) => v} height={200} /></CardBody></Card>
      </div>
    </div>
  );
}

function Tenants() {
  const nav = useNavigate();
  const { params, set } = useListState();
  const { data, isLoading, error, refetch } = usePaged<any>('/platform/tenants', params);
  return (
    <div><PageHeader title="Tenants" description="Registered businesses. Tenant business data is not visible here." />
      <Card><div className="flex flex-wrap gap-3 border-b border-slate-100 p-4"><SearchInput className="w-full sm:w-72" value={params.q ?? ''} onChange={(q) => set({ q })} />
        <Select aria-label="Status" className="w-44" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="Any status" options={['active', 'trialing', 'past_due', 'grace_period', 'suspended', 'cancelled', 'expired'].map((s) => ({ value: s, label: titleCase(s) }))} /></div>
        <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} onRowClick={(r: any) => nav(`/platform/tenants/${r.id}`)} empty={<EmptyState icon={Building2} title="No tenants" />} columns={[
          { key: 'n', header: 'Business', cell: (r: any) => <div><p className="font-medium">{r.name} {r.is_demo && <Badge tone="blue">Demo</Badge>}</p><p className="text-xs text-slate-500">{r.slug} · {r.country}</p></div> },
          { key: 'p', header: 'Plan', cell: (r: any) => <div><p>{r.plan_name}</p><p className="text-xs text-slate-500">{money(r.price, r.currency)} / {r.billing_cycle === 'annual' ? 'yr' : 'mo'}</p></div> },
          { key: 'u', header: 'Users', className: 'text-right', cell: (r: any) => r.users }, { key: 'c', header: 'Created', hideOnMobile: true, cell: (r: any) => date(r.created_at) },
          { key: 'l', header: 'Last activity', hideOnMobile: true, cell: (r: any) => r.last_activity ? dateTime(r.last_activity) : '—' },
          { key: 's', header: 'Status', cell: (r: any) => <div className="flex gap-1">{r.status !== 'active' && <StatusBadge status={r.status} />}<StatusBadge status={r.subscription_status} /></div> }]} /></Card></div>
  );
}

function TenantDetail() {
  const { id } = useParams();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { acceptToken } = useAuth();
  const nav = useNavigate();
  const { data: t, isLoading, error, refetch } = useData<any>(['p-tenant', id], `/platform/tenants/${id}`);
  const { data: plans } = useData<any[]>(['p-plans'], '/platform/plans');
  const [ov, setOv] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['p-tenant', id] });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const s = t.subscription;
  const activeGrant = t.grants.find((g: any) => !g.revoked_at && new Date(g.expires_at) > new Date());
  return (
    <div>
      <PageHeader back={<Link to="/platform/tenants" className="text-sm text-slate-500">← Tenants</Link>} title={<span className="flex items-center gap-3">{t.name}<StatusBadge status={t.status} />{t.is_demo && <Badge tone="blue">Demo</Badge>}</span>}
        description={`${t.slug} · ${t.email ?? ''} · created ${date(t.created_at)}`}
        actions={<>
          <Button variant="outline" disabled={!activeGrant} title={activeGrant ? '' : 'The tenant has not granted support access'} onClick={async () => { try { const r = await post(`/platform/tenants/${t.id}/support-session`); await acceptToken(r.data.accessToken); nav('/app'); } catch (e) { toastError(e); } }}><Eye />Open support view</Button>
          {t.status === 'active' ? <Button variant="danger-outline" onClick={async () => { const r = await confirm({ title: `Suspend ${t.name}?`, description: 'All users are signed out and blocked until reactivation.', requireReason: true, danger: true, confirmLabel: 'Suspend' }); if (r) post(`/platform/tenants/${t.id}/suspend`, { reason: r.reason }).then(refresh).catch(toastError); }}>Suspend</Button>
            : <Button onClick={() => post(`/platform/tenants/${t.id}/reactivate`).then(refresh).catch(toastError)}>Reactivate</Button>}
        </>} />
      {t.suspended_reason && <div className="mb-4"><Alert tone="red" title="Suspended">{t.suspended_reason}</Alert></div>}
      {!activeGrant && <div className="mb-4"><Alert tone="blue">Support view requires a time-limited access grant from the tenant (Settings → Support access).</Alert></div>}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4"><StatCard label="Users" value={t.usage.users} /><StatCard label="Technicians" value={t.usage.technicians} /><StatCard label="Work orders (30d)" value={t.usage.work_orders_30d} /><StatCard label="Storage" value={fileSize(Number(t.usage.storage_bytes))} /></div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="Subscription" actions={<Button size="sm" variant="outline" onClick={() => setOv({ planCode: s.plan_code, status: s.status, price: s.price, trialEndsAt: '', currentPeriodEnd: '', reason: '', maxTechnicians: s.custom_limits?.max_technicians ?? '', maxUsers: s.custom_limits?.max_users ?? '' })}>Override</Button>} />
          <CardBody><DescriptionList items={[['Plan', s.plan_name], ['Status', <StatusBadge status={s.status} />], ['Billing', `${money(s.price, s.currency)} / ${s.billing_cycle}`], ['Trial ends', date(s.trial_ends_at)],
            ['Current period', `${date(s.current_period_start)} – ${date(s.current_period_end)}`], ['Custom limits', Object.keys(s.custom_limits ?? {}).length ? JSON.stringify(s.custom_limits) : '—']]} /></CardBody></Card>
        <Card><CardHeader title="Owners" /><ul className="divide-y divide-slate-100 text-sm">{t.owners.map((o: any) => <li key={o.email} className="px-5 py-2.5"><p className="font-medium">{o.full_name}</p><p className="text-xs text-slate-500">{o.email} · MFA {o.mfa_enabled ? 'on' : 'off'} · last login {o.last_login_at ? dateTime(o.last_login_at) : 'never'}</p></li>)}</ul></Card>
        <Card className="lg:col-span-2"><CardHeader title="Subscription history" /><DataTable rows={t.events} columns={[{ key: 'd', header: 'Date', cell: (e: any) => dateTime(e.created_at) }, { key: 't', header: 'Event', cell: (e: any) => titleCase(e.event_type) },
          { key: 'p', header: 'Plan', cell: (e: any) => e.to_plan ?? '—' }, { key: 'a', header: 'Amount', cell: (e: any) => e.amount ? money(e.amount, e.currency) : '—' }]} /></Card>
        <Card><CardHeader title="Integration health" /><ul className="divide-y divide-slate-100 text-sm">{t.integrations.map((i: any) => <li key={i.kind} className="flex justify-between px-5 py-2.5"><span>{titleCase(i.kind)} · {i.provider} {i.mode === 'test' && <Badge>test</Badge>}</span><StatusBadge status={i.is_enabled ? i.status : 'inactive'} /></li>)}</ul></Card>
      </div>
      <Dialog open={!!ov} onOpenChange={(o) => !o && setOv(null)} title="Override subscription" description="All overrides are audited." footer={<Button disabled={!ov?.reason || ov.reason.length < 3} onClick={() => patch(`/platform/tenants/${t.id}/subscription`, {
        planCode: ov.planCode, status: ov.status, price: ov.price === '' ? undefined : Number(ov.price), reason: ov.reason, trialEndsAt: ov.trialEndsAt ? new Date(ov.trialEndsAt).toISOString() : undefined,
        currentPeriodEnd: ov.currentPeriodEnd ? new Date(ov.currentPeriodEnd).toISOString() : undefined,
        customLimits: (ov.maxTechnicians !== '' || ov.maxUsers !== '') ? { ...(ov.maxTechnicians !== '' ? { max_technicians: Number(ov.maxTechnicians) } : {}), ...(ov.maxUsers !== '' ? { max_users: Number(ov.maxUsers) } : {}) } : undefined,
      }).then(() => { setOv(null); refresh(); toast.success('Subscription updated'); }).catch(toastError)}>Apply</Button>}>
        {ov && <div className="grid gap-3 sm:grid-cols-2"><Field label="Plan"><Select value={ov.planCode} onChange={(e) => setOv({ ...ov, planCode: e.target.value })} options={(plans ?? []).map((p) => ({ value: p.code, label: p.name }))} /></Field>
          <Field label="Status"><Select value={ov.status} onChange={(e) => setOv({ ...ov, status: e.target.value })} options={['trialing', 'active', 'past_due', 'grace_period', 'cancelled', 'expired', 'suspended'].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>
          <Field label="Price"><Input type="number" value={ov.price} onChange={(e) => setOv({ ...ov, price: e.target.value })} /></Field><Field label="Extend trial to"><Input type="date" value={ov.trialEndsAt} onChange={(e) => setOv({ ...ov, trialEndsAt: e.target.value })} /></Field>
          <Field label="Period ends"><Input type="date" value={ov.currentPeriodEnd} onChange={(e) => setOv({ ...ov, currentPeriodEnd: e.target.value })} /></Field><span />
          <Field label="Custom technician limit"><Input type="number" value={ov.maxTechnicians} onChange={(e) => setOv({ ...ov, maxTechnicians: e.target.value })} /></Field><Field label="Custom user limit"><Input type="number" value={ov.maxUsers} onChange={(e) => setOv({ ...ov, maxUsers: e.target.value })} /></Field>
          <Field label="Reason" className="sm:col-span-2" required><Textarea rows={2} value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}

function Plans() {
  const qc = useQueryClient();
  const { data, isLoading } = useData<any>(['p-plans-full'], '/platform/plans');
  const [all, setAll] = useState<any>(null);
  const { data: meta } = useData<any>(['p-plans-meta'], '/platform/plans');
  const [edit, setEdit] = useState<any>(null);
  if (isLoading) return <PageLoader />;
  const features = (all ?? meta)?.features ?? {};
  void setAll;
  const blank = { code: '', name: '', description: '', currency: 'USD', monthlyPrice: 0, annualPrice: 0, trialDays: 14, maxUsers: 10, maxTechnicians: 5, maxStorageMb: 5120, maxBranches: 1, aiRequestsPerMonth: 0, features: {}, isPublic: true, isActive: true, sortOrder: 10 };
  const FK = ['crm', 'service_requests', 'work_orders', 'technician_portal', 'basic_reports', 'customer_portal', 'quotations', 'invoicing', 'amc', 'notifications', 'advanced_reports', 'inventory', 'advanced_permissions', 'ai', 'integrations', 'multi_branch', 'dispatch_optimizer'];
  return (
    <div><PageHeader title="Plans & pricing" description="All prices, limits and features are configured here — never hard-coded." actions={<Button onClick={() => setEdit(blank)}><Plus />New plan</Button>} />
      <Card><DataTable rows={data} onRowClick={(p: any) => setEdit({ id: p.id, code: p.code, name: p.name, description: p.description ?? '', currency: p.currency, monthlyPrice: Number(p.monthly_price), annualPrice: Number(p.annual_price), trialDays: p.trial_days,
        maxUsers: p.max_users, maxTechnicians: p.max_technicians, maxStorageMb: p.max_storage_mb, maxBranches: p.max_branches, aiRequestsPerMonth: p.ai_requests_per_month, features: p.features, isPublic: p.is_public, isActive: p.is_active, sortOrder: p.sort_order })}
        columns={[{ key: 'n', header: 'Plan', cell: (p: any) => <div><p className="font-medium">{p.name} {!p.is_public && <Badge>Private</Badge>} {!p.is_active && <Badge tone="red">Inactive</Badge>}</p><p className="text-xs text-slate-500">{p.code}</p></div> },
          { key: 'pr', header: 'Price', cell: (p: any) => `${money(p.monthly_price, p.currency)}/mo · ${money(p.annual_price, p.currency)}/yr` }, { key: 'l', header: 'Limits', cell: (p: any) => `${p.max_technicians ?? '∞'} techs · ${p.max_users ?? '∞'} users · ${p.max_branches} branches` },
          { key: 't', header: 'Trial', cell: (p: any) => `${p.trial_days} days` }, { key: 's', header: 'Subscribers', className: 'text-right', cell: (p: any) => p.subscribers }]} /></Card>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'New plan'} size="xl" footer={<Button onClick={() => { const { id, ...body } = edit; (id ? patch(`/platform/plans/${id}`, (({ code, ...r }) => r)(body)) : post('/platform/plans', body)).then(() => { setEdit(null); qc.invalidateQueries({ queryKey: ['p-plans-full'] }); toast.success('Plan saved'); }).catch(toastError); }}>Save plan</Button>}>
        {edit && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-4">
          {!edit.id && <Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>}
          <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Currency"><Input value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} /></Field>
          {[['monthlyPrice', 'Monthly price'], ['annualPrice', 'Annual price'], ['trialDays', 'Trial days'], ['maxUsers', 'Max users (blank = ∞)'], ['maxTechnicians', 'Max technicians (blank = ∞)'], ['maxStorageMb', 'Storage MB (blank = ∞)'], ['maxBranches', 'Max branches'], ['aiRequestsPerMonth', 'AI requests / month'], ['sortOrder', 'Sort order']].map(([k, l]) => (
            <Field key={k} label={l}><Input type="number" value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value === '' ? null : Number(e.target.value) })} /></Field>))}
          <Field label="Description" className="sm:col-span-4"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
          <div><p className="label">Features</p><div className="grid gap-1 sm:grid-cols-3">{FK.map((k) => <Checkbox key={k} label={features[k] ?? titleCase(k)} checked={!!edit.features[k]} onChange={(e) => setEdit({ ...edit, features: { ...edit.features, [k]: e.target.checked } })} />)}</div></div>
          <div className="flex gap-4"><Checkbox label="Public (shown on pricing page)" checked={edit.isPublic} onChange={(e) => setEdit({ ...edit, isPublic: e.target.checked })} /><Checkbox label="Active" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /></div></div>}
      </Dialog></div>
  );
}

function Billing() {
  const { params, set } = useListState();
  const { data, isLoading, refetch } = usePaged<any>('/platform/billing/invoices', params);
  const { data: events } = useData<any[]>(['p-events'], '/platform/billing/events');
  const [paid, setPaid] = useState<any>(null);
  return (
    <div><PageHeader title="SaaS billing" description="Invoices NEXUS issues to tenants. Separate from payments tenants collect from their own customers." />
      <Card className="mb-6"><div className="flex gap-3 border-b border-slate-100 p-4"><Select aria-label="Status" className="w-40" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All" options={['open', 'paid', 'failed', 'void'].map((s) => ({ value: s, label: titleCase(s) }))} /></div>
        <DataTable rows={data?.data} loading={isLoading} meta={data?.meta} onPage={(page) => set({ page }, false)} empty={<EmptyState title="No invoices" />} columns={[{ key: 'n', header: 'Invoice', cell: (r: any) => r.number }, { key: 't', header: 'Tenant', cell: (r: any) => r.tenant_name },
          { key: 'p', header: 'Plan / period', cell: (r: any) => <div><p>{r.plan_name}</p><p className="text-xs text-slate-500">{date(r.period_start)} – {date(r.period_end)}</p></div> }, { key: 'a', header: 'Amount', className: 'text-right', cell: (r: any) => money(r.amount, r.currency) },
          { key: 's', header: 'Status', cell: (r: any) => <div><StatusBadge status={r.status} />{r.failure_reason && <p className="text-xs text-red-600">{r.failure_reason}</p>}</div> },
          { key: 'x', header: '', cell: (r: any) => r.status === 'open' && <div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => setPaid({ id: r.id, reference: '' })}>Mark paid</Button>
            <Button size="sm" variant="ghost" onClick={() => post(`/platform/billing/invoices/${r.id}/void`).then(() => refetch()).catch(toastError)}>Void</Button></div> }]} /></Card>
      <Card><CardHeader title="Recent subscription events" /><DataTable rows={events} columns={[{ key: 'd', header: 'Date', cell: (e: any) => dateTime(e.created_at) }, { key: 't', header: 'Tenant', cell: (e: any) => e.tenant_name },
        { key: 'e', header: 'Event', cell: (e: any) => titleCase(e.event_type) }, { key: 'p', header: 'Plan', cell: (e: any) => e.to_plan ?? '—' }]} /></Card>
      <Dialog open={!!paid} onOpenChange={(o) => !o && setPaid(null)} title="Record bank transfer" footer={<Button disabled={!paid?.reference} onClick={() => post(`/platform/billing/invoices/${paid.id}/mark-paid`, { reference: paid.reference }).then(() => { setPaid(null); refetch(); toast.success('Subscription activated'); }).catch(toastError)}>Mark paid & activate</Button>}>
        {paid && <Field label="Bank reference"><Input value={paid.reference} onChange={(e) => setPaid({ ...paid, reference: e.target.value })} /></Field>}</Dialog></div>
  );
}

function Tickets() {
  const { data, refetch } = useData<any[]>(['p-tickets'], '/platform/tickets');
  const [reply, setReply] = useState<Record<string, { body: string; status: string }>>({});
  return (<div><PageHeader title="Tenant support" />{(data ?? []).length ? <div className="space-y-4">{data!.map((t) => { const r = reply[t.id] ?? { body: '', status: 'waiting_for_customer' }; return (
    <Card key={t.id}><CardHeader title={t.subject} description={`${t.tenant_name} · ${t.created_by_name ?? ''} · ${dateTime(t.created_at)}`} actions={<div className="flex gap-1"><Badge tone={t.priority === 'urgent' ? 'red' : 'slate'}>{t.priority}</Badge><StatusBadge status={t.status} /></div>} />
      <CardBody className="space-y-2 text-sm"><p className="whitespace-pre-line rounded-lg bg-slate-100 p-3">{t.body}</p>{(t.messages ?? []).map((m: any) => <p key={m.id} className={`whitespace-pre-line rounded-lg p-3 ${m.author_side === 'platform' ? 'ml-6 bg-brand-50' : 'bg-slate-100'}`}>{m.body}<span className="block text-xs text-slate-500">{dateTime(m.created_at)}</span></p>)}
        <div className="flex flex-wrap gap-2"><Input className="min-w-[240px] flex-1" value={r.body} onChange={(e) => setReply({ ...reply, [t.id]: { ...r, body: e.target.value } })} placeholder="Reply…" />
          <Select aria-label="Status" className="w-48" value={r.status} onChange={(e) => setReply({ ...reply, [t.id]: { ...r, status: e.target.value } })} options={['in_progress', 'waiting_for_customer', 'resolved', 'closed'].map((s) => ({ value: s, label: titleCase(s) }))} />
          <Button disabled={!r.body} onClick={() => post(`/platform/tickets/${t.id}/messages`, r).then(() => { setReply({ ...reply, [t.id]: { body: '', status: r.status } }); refetch(); }).catch(toastError)}>Send</Button></div></CardBody></Card>); })}</div>
    : <Card><EmptyState title="No tickets" /></Card>}</div>);
}

function Health() {
  const { data, isLoading, refetch } = useData<any>(['p-health'], '/platform/health', { refetchInterval: 30_000 });
  if (isLoading) return <PageLoader />;
  return (<div><PageHeader title="Service health" actions={<Button variant="outline" onClick={() => refetch()}>Refresh</Button>} />
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4"><StatCard label="DB latency" value={`${data.database.latencyMs} ms`} tone={data.database.latencyMs > 100 ? 'amber' : 'green'} /><StatCard label="DB size" value={fileSize(Number(data.database.size_bytes))} />
      <StatCard label="Connections" value={`${data.database.connections} (pool ${data.database.pool.total})`} /><StatCard label="Uptime" value={`${Math.round(data.uptimeSec / 3600)} h`} hint={`${data.memoryMb} MB RSS`} /></div>
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <Card><CardHeader title="Background jobs (24h)" /><DataTable rows={data.queue.map((q: any, i: number) => ({ ...q, id: String(i) }))} columns={[{ key: 't', header: 'Job', cell: (q: any) => q.job_type }, { key: 's', header: 'Status', cell: (q: any) => <StatusBadge status={q.status === 'dead' ? 'failed' : q.status} label={titleCase(q.status)} /> }, { key: 'n', header: 'Count', className: 'text-right', cell: (q: any) => q.n }]} /></Card>
      <Card><CardHeader title="Integrations across tenants" /><DataTable rows={data.integrations.map((q: any, i: number) => ({ ...q, id: String(i) }))} columns={[{ key: 'k', header: 'Kind', cell: (q: any) => `${titleCase(q.kind)} · ${q.provider}` }, { key: 's', header: 'Status', cell: (q: any) => <StatusBadge status={q.status} /> }, { key: 'n', header: 'Tenants', className: 'text-right', cell: (q: any) => q.tenants }]} /></Card>
      <Card><CardHeader title="Webhooks (24h)" /><CardBody><DescriptionList cols={3} items={[['Received', data.webhooks.total], ['Invalid signatures', data.webhooks.invalid_signatures], ['Processing failures', data.webhooks.failed]]} /></CardBody></Card>
      <Card><CardHeader title="Dead-lettered jobs" /><DataTable rows={data.deadJobs} empty={<EmptyState title="None" />} columns={[{ key: 't', header: 'Job', cell: (j: any) => j.job_type }, { key: 'e', header: 'Error', cell: (j: any) => <span className="text-xs text-red-600">{j.last_error}</span> },
        { key: 'x', header: '', cell: (j: any) => <Button size="sm" variant="ghost" onClick={() => post(`/platform/jobs/${j.id}/retry`).then(() => refetch()).catch(toastError)}>Retry</Button> }]} /></Card>
    </div></div>);
}

function Announcements() {
  const { data, refetch } = useData<any[]>(['p-ann'], '/platform/announcements');
  const [v, setV] = useState<any>(null);
  return (<div><PageHeader title="System announcements" description="Shown as banners to all tenant users." actions={<Button onClick={() => setV({ title: '', body: '', severity: 'info', endsAt: '' })}><Plus />New</Button>} />
    <Card><DataTable rows={data} empty={<EmptyState title="No announcements" />} columns={[{ key: 't', header: 'Title', cell: (a: any) => <div><p className="font-medium">{a.title}</p><p className="text-xs text-slate-500">{a.body}</p></div> },
      { key: 's', header: 'Severity', cell: (a: any) => <Badge tone={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'amber' : 'blue'}>{a.severity}</Badge> }, { key: 'w', header: 'Window', cell: (a: any) => `${date(a.starts_at)} – ${a.ends_at ? date(a.ends_at) : 'open'}` },
      { key: 'x', header: '', cell: (a: any) => <Checkbox label="Active" checked={a.is_active} onChange={(e) => patch(`/platform/announcements/${a.id}`, { isActive: e.target.checked }).then(() => refetch())} /> }]} /></Card>
    <Dialog open={!!v} onOpenChange={(o) => !o && setV(null)} title="New announcement" footer={<Button onClick={() => post('/platform/announcements', { ...v, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null }).then(() => { setV(null); refetch(); }).catch(toastError)}>Publish</Button>}>
      {v && <div className="space-y-3"><Field label="Title"><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field><Field label="Message"><Textarea rows={3} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Severity"><Select value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value })} options={['info', 'warning', 'critical'].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>
          <Field label="Ends"><Input type="date" value={v.endsAt} onChange={(e) => setV({ ...v, endsAt: e.target.value })} /></Field></div></div>}
    </Dialog></div>);
}

function Audit() {
  const { params, set } = useListState();
  const { data, isLoading } = usePaged<any>('/platform/audit-logs', params);
  return (<div><PageHeader title="Platform audit log" /><Card><div className="flex gap-3 border-b border-slate-100 p-4"><Input className="w-64" placeholder="Action prefix, e.g. platform." value={params.action ?? ''} onChange={(e) => set({ action: e.target.value })} /></div>
    <DataTable rows={data?.data} loading={isLoading} meta={data?.meta} onPage={(page) => set({ page }, false)} columns={[{ key: 't', header: 'Time', cell: (r: any) => dateTime(r.created_at) }, { key: 'a', header: 'Action', cell: (r: any) => <span className="font-mono text-xs">{r.action}</span> },
      { key: 'u', header: 'Actor', cell: (r: any) => r.user_email ?? 'system' }, { key: 'te', header: 'Tenant', cell: (r: any) => r.tenant_name ?? '—' }, { key: 'd', header: 'Details', cell: (r: any) => <span className="max-w-xs truncate text-xs text-slate-500">{r.after_data ? JSON.stringify(r.after_data).slice(0, 80) : ''}</span> }]} /></Card></div>);
}

function Config() {
  const { data, refetch } = useData<any[]>(['p-settings'], '/platform/settings');
  const [v, setV] = useState({ key: '', value: '' });
  return (<div><PageHeader title="Platform configuration" description="Key/value settings (JSON values). Secrets belong in environment variables, never here." />
    <Card><DataTable rows={data?.map((d) => ({ ...d, id: d.key }))} empty={<EmptyState title="No settings" />} columns={[{ key: 'k', header: 'Key', cell: (s: any) => <span className="font-mono text-xs">{s.key}</span> }, { key: 'v', header: 'Value', cell: (s: any) => <span className="font-mono text-xs">{JSON.stringify(s.value)}</span> },
      { key: 'u', header: 'Updated', cell: (s: any) => dateTime(s.updated_at) }]} />
      <div className="flex flex-wrap gap-2 border-t border-slate-100 p-4"><Input className="w-56" placeholder="key" value={v.key} onChange={(e) => setV({ ...v, key: e.target.value })} /><Input className="w-72" placeholder='value (JSON), e.g. true' value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} />
        <Button onClick={() => { let parsed: unknown; try { parsed = JSON.parse(v.value); } catch { parsed = v.value; } put(`/platform/settings/${v.key}`, { value: parsed }).then(() => { setV({ key: '', value: '' }); refetch(); }).catch(toastError); }}>Save</Button></div></Card></div>);
}

export default function Platform() {
  return (
    <Routes>
      <Route index element={<Overview />} /><Route path="tenants" element={<Tenants />} /><Route path="tenants/:id" element={<TenantDetail />} /><Route path="plans" element={<Plans />} />
      <Route path="billing" element={<Billing />} /><Route path="support" element={<Tickets />} /><Route path="health" element={<Health />} /><Route path="announcements" element={<Announcements />} />
      <Route path="audit" element={<Audit />} /><Route path="settings" element={<Config />} /><Route path="profile" element={<Profile />} />
    </Routes>
  );
}
