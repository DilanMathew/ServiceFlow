import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useData } from '@/lib/hooks';
import { date, dateTime, money } from '@/lib/format';
import { cn, fileSize, titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Select, StatusBadge, Tabs, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';

function Usage({ label, used, limit, fmt = (n: number) => String(n) }: { label: string; used: number; limit: number | null; fmt?: (n: number) => string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return <div><div className="flex justify-between text-sm"><span className="text-slate-600">{label}</span><span className="tabular font-medium">{fmt(used)} / {limit == null ? 'Unlimited' : fmt(limit)}</span></div>
    <div className="mt-1.5 h-2 rounded-full bg-slate-100"><div className={cn('h-2 rounded-full', pct > 90 ? 'bg-red-500' : 'bg-brand-600')} style={{ width: `${limit ? pct : 4}%` }} /></div></div>;
}

export default function Subscription() {
  const [sp, setSp] = useSearchParams();
  const { can, reload } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const tab = sp.get('tab') ?? 'plan';
  const { data, isLoading, error, refetch } = useData<any>(['subscription'], '/app/subscription');
  const { data: tickets } = useData<any[]>(['platform-tickets'], tab === 'support' ? '/app/subscription/support-tickets' : null);
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly');
  const [ticket, setTicket] = useState<any>(null);
  const [reply, setReply] = useState<Record<string, string>>({});
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const { subscription: s, entitlements: e, plans, events, invoices, usage, featureLabels } = data;
  const manage = can('subscription.manage');
  const after = async (p: Promise<any>) => { try { const r = await p; if (r.data?.checkoutUrl) window.location.href = r.data.checkoutUrl; else { toast.success(r.data?.scheduled ? `Change scheduled for ${date(r.data.effective)}` : r.data?.manual ? 'Invoice created — NEXUS will confirm your bank transfer' : 'Subscription updated'); qc.invalidateQueries({ queryKey: ['subscription'] }); reload(); } } catch (err) { toastError(err); } };
  return (
    <div>
      <PageHeader title="Subscription & NEXUS support" description="Your ServiceFlow plan. This is separate from the payments your customers make to you." />
      <Tabs value={tab} onValueChange={(t) => setSp({ tab: t })} tabs={[{ value: 'plan', label: 'Plan & usage' }, { value: 'billing', label: 'Billing history' }, { value: 'support', label: 'NEXUS support' }]} />
      <div className="mt-5">
        {tab === 'plan' && <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2"><CardHeader title={`${s.plan_name} plan`} description={`${titleCase(s.billing_cycle)} · ${money(s.price, s.currency)}`} actions={<StatusBadge status={e.status} />} />
              <CardBody className="space-y-3 text-sm">
                {e.status === 'trialing' && <Alert tone="blue">Free trial until {date(e.trialEndsAt)}. Activate a plan to keep using ServiceFlow without interruption.</Alert>}
                {e.readOnly && <Alert tone="red">Your workspace is read-only. Renew to continue making changes.</Alert>}
                {s.cancel_at_period_end && <Alert tone="amber" action={manage && <Button size="sm" onClick={() => after(post('/app/subscription/resume'))}>Keep subscription</Button>}>Cancels at the end of the period ({date(s.current_period_end)}).</Alert>}
                {s.pending_plan_name && <Alert tone="blue">Changes to {s.pending_plan_name} on {date(s.current_period_end)}.</Alert>}
                <p className="text-slate-600">Current period: {date(s.current_period_start)} – {date(s.current_period_end)}</p>
                {manage && <div className="flex flex-wrap gap-2">{(['trialing', 'expired', 'past_due', 'grace_period', 'suspended'].includes(e.status) || e.readOnly) && <Button onClick={() => after(post('/app/subscription/checkout', { billingCycle: cycle }))}>Pay & activate</Button>}
                  {e.status === 'active' && !s.cancel_at_period_end && <Button variant="danger-outline" onClick={async () => { const r = await confirm({ title: 'Cancel subscription?', description: 'You keep access until the end of the paid period. Your data is retained.', requireReason: true, danger: true, confirmLabel: 'Cancel subscription' }); if (r) after(post('/app/subscription/cancel', { reason: r.reason })); }}>Cancel subscription</Button>}</div>}
              </CardBody></Card>
            <Card><CardHeader title="Usage" /><CardBody className="space-y-4"><Usage label="Active users" used={usage.users} limit={e.limits.users} /><Usage label="Technicians" used={usage.technicians} limit={e.limits.technicians} />
              <Usage label="Branches" used={usage.branches} limit={e.limits.branches} /><Usage label="Storage" used={Number(usage.storage_bytes)} limit={e.limits.storageMb == null ? null : e.limits.storageMb * 1048576} fmt={fileSize} />
              <Usage label="AI requests (month)" used={usage.ai_requests} limit={e.limits.aiRequestsPerMonth} /></CardBody></Card>
          </div>
          <div className="flex items-center justify-between"><h2 className="text-lg font-semibold text-navy-900">Plans</h2>
            <Select aria-label="Billing cycle" className="w-40" value={cycle} onChange={(ev) => setCycle(ev.target.value as any)} options={[{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }]} /></div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{plans.map((p: any) => (
            <Card key={p.id} className={cn('flex flex-col p-5', p.id === s.plan_id && 'border-brand-500 ring-1 ring-brand-500')}>
              <div className="flex items-center justify-between"><h3 className="font-semibold text-navy-900">{p.name}</h3>{p.id === s.plan_id && <Badge tone="blue">Current</Badge>}</div>
              <p className="mt-1 text-xs text-slate-500">{p.description}</p>
              <p className="mt-3 text-2xl font-bold text-navy-900">{Number(p.monthly_price) === 0 && p.code === 'enterprise' ? 'Custom' : money(cycle === 'annual' ? p.annual_price : p.monthly_price, p.currency)}<span className="text-sm font-normal text-slate-500">{Number(p.monthly_price) ? `/${cycle === 'annual' ? 'yr' : 'mo'}` : ''}</span></p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm">
                <li className="text-slate-600">{p.max_technicians ?? 'Unlimited'} technicians · {p.max_users ?? 'unlimited'} users · {p.max_branches} branch(es)</li>
                {Object.entries(featureLabels).map(([k, label]) => <li key={k} className={cn('flex items-center gap-2', !p.features[k] && 'text-slate-400')}>{p.features[k] ? <Check className="h-4 w-4 text-brand-600" /> : <Minus className="h-4 w-4" />}{label as string}</li>)}
              </ul>
              {manage && p.id !== s.plan_id && (p.code === 'enterprise' ? <Button variant="outline" className="mt-4" onClick={() => setSp({ tab: 'support' })}>Contact NEXUS</Button>
                : <Button className="mt-4" variant={p.sort_order > (plans.find((x: any) => x.id === s.plan_id)?.sort_order ?? 0) ? 'primary' : 'outline'} onClick={() => after(post('/app/subscription/change-plan', { planCode: p.code, billingCycle: cycle }))}>
                  {p.sort_order > (plans.find((x: any) => x.id === s.plan_id)?.sort_order ?? 0) ? 'Upgrade' : 'Downgrade'}</Button>)}
            </Card>))}</div>
        </div>}
        {tab === 'billing' && <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="NEXUS invoices" /><DataTable rows={invoices} empty={<EmptyState title="No invoices yet" />} columns={[{ key: 'n', header: 'Invoice', cell: (r: any) => r.number },
            { key: 'p', header: 'Period', cell: (r: any) => `${date(r.period_start)} – ${date(r.period_end)}` }, { key: 'a', header: 'Amount', className: 'text-right', cell: (r: any) => money(r.amount, r.currency) },
            { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>
          <Card><CardHeader title="Subscription history" /><ul className="divide-y divide-slate-100 text-sm">{events.map((ev: any, i: number) => <li key={i} className="px-5 py-2.5"><p className="font-medium">{titleCase(ev.event_type)}{ev.to_plan ? ` → ${ev.to_plan}` : ''}</p>
            <p className="text-xs text-slate-500">{dateTime(ev.created_at)}{ev.amount ? ` · ${money(ev.amount, ev.currency)}` : ''}</p></li>)}</ul></Card>
        </div>}
        {tab === 'support' && <div className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => setTicket({ subject: '', body: '', priority: 'normal' })}>Contact NEXUS support</Button></div>
          {(tickets ?? []).length === 0 ? <Card><EmptyState title="No support requests" description="Questions about billing, setup or a problem? Our team will help." /></Card> : tickets!.map((t) => (
            <Card key={t.id}><CardHeader title={t.subject} description={dateTime(t.created_at)} actions={<StatusBadge status={t.status} />} />
              <CardBody className="space-y-2 text-sm"><p className="whitespace-pre-line rounded-lg bg-slate-100 p-3">{t.body}</p>
                {(t.messages ?? []).map((m: any) => <p key={m.id} className={cn('whitespace-pre-line rounded-lg p-3', m.author_side === 'platform' ? 'ml-6 bg-brand-50' : 'bg-slate-100')}>{m.body}<span className="block text-xs text-slate-500">{m.author_side === 'platform' ? 'NEXUS support' : 'You'} · {dateTime(m.created_at)}</span></p>)}
                {t.status !== 'closed' && <div className="flex gap-2"><Input placeholder="Reply…" value={reply[t.id] ?? ''} onChange={(ev) => setReply({ ...reply, [t.id]: ev.target.value })} />
                  <Button disabled={!reply[t.id]} onClick={() => post(`/app/subscription/support-tickets/${t.id}/messages`, { body: reply[t.id] }).then(() => { setReply({ ...reply, [t.id]: '' }); qc.invalidateQueries({ queryKey: ['platform-tickets'] }); }).catch(toastError)}>Send</Button></div>}
              </CardBody></Card>))}
        </div>}
      </div>
      <Dialog open={!!ticket} onOpenChange={(o) => !o && setTicket(null)} title="Contact NEXUS support" footer={<Button disabled={!ticket?.subject || !ticket?.body} onClick={() => post('/app/subscription/support-tickets', ticket).then(() => { setTicket(null); qc.invalidateQueries({ queryKey: ['platform-tickets'] }); toast.success('Sent to NEXUS support'); }).catch(toastError)}>Send</Button>}>
        {ticket && <div className="space-y-3"><Field label="Subject"><Input value={ticket.subject} onChange={(ev) => setTicket({ ...ticket, subject: ev.target.value })} /></Field>
          <Field label="Priority"><Select value={ticket.priority} onChange={(ev) => setTicket({ ...ticket, priority: ev.target.value })} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: titleCase(p) }))} /></Field>
          <Field label="How can we help?"><Textarea rows={5} value={ticket.body} onChange={(ev) => setTicket({ ...ticket, body: ev.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}
