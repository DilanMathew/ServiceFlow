import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Headset, Plus, Star } from 'lucide-react';
import { toast } from 'sonner';
import { patch, post } from '@/lib/api';
import { useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatCard, StatusBadge, Tabs, Textarea } from '@/components/ui';
import { toastError } from '@/components/form';
import { BackLink, CustomerPicker } from './shared';
import { PriorityBadge } from './WorkOrders';

const CATS = ['general', 'complaint', 'billing', 'service_quality', 'technician', 'scheduling', 'other'];

function SupportHome() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'tickets';
  const { can } = useAuth();
  const { params, set } = useListState();
  const tickets = usePaged<any>('/app/support/tickets', { ...params, tab: undefined }, tab === 'tickets');
  const feedback = usePaged<any>('/app/support/feedback', { ...params, tab: undefined }, tab === 'feedback');
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ customerId: '', subject: '', category: 'general', priority: 'normal', message: '' });
  const [review, setReview] = useState<any>(null);
  const summary = (feedback.data as any)?.summary;
  return (
    <div>
      <PageHeader title="Support & feedback" description="Customer tickets, complaints and post-service ratings." actions={can('support.manage') && <Button onClick={() => setOpen(true)}><Plus />New ticket</Button>} />
      <Tabs value={tab} onValueChange={(t) => setSp({ tab: t })} tabs={[{ value: 'tickets', label: 'Tickets' }, { value: 'feedback', label: 'Feedback' }]} />
      <div className="mt-5">
        {tab === 'tickets' && <Card>
          <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4"><SearchInput className="w-full sm:w-64" value={params.q ?? ''} onChange={(q) => set({ q })} />
            <Select aria-label="Status" className="w-48" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={[['open,in_progress,waiting_for_customer', 'Open'], ['open', 'New'], ['in_progress', 'In progress'], ['waiting_for_customer', 'Waiting for customer'], ['resolved', 'Resolved'], ['closed', 'Closed']].map(([value, label]) => ({ value, label }))} />
            <Select aria-label="Category" className="w-40" value={params.category ?? ''} onChange={(e) => set({ category: e.target.value })} placeholder="All categories" options={CATS.map((c) => ({ value: c, label: titleCase(c) }))} />
            <Checkbox label="Assigned to me" checked={params.assignedTo === 'me'} onChange={(e) => set({ assignedTo: e.target.checked ? 'me' : '' })} /></div>
          <DataTable rows={tickets.data?.data} loading={tickets.isLoading} error={tickets.error} onRetry={tickets.refetch} meta={tickets.data?.meta} onPage={(page) => set({ page }, false)}
            onRowClick={(r: any) => nav(`/app/support/${r.id}`)} empty={<EmptyState icon={Headset} title="No tickets" />} columns={[
              { key: 'n', header: 'Ticket', cell: (r: any) => <div><p className="font-medium">{r.number}</p><p className="max-w-xs truncate text-xs text-slate-500">{r.subject}</p></div> },
              { key: 'c', header: 'Customer', cell: (r: any) => r.customer_name ?? '—' }, { key: 'cat', header: 'Category', hideOnMobile: true, cell: (r: any) => titleCase(r.category) },
              { key: 'p', header: 'Priority', cell: (r: any) => <PriorityBadge p={r.priority} /> }, { key: 'a', header: 'Assignee', hideOnMobile: true, cell: (r: any) => r.assignee_name ?? '—' },
              { key: 'u', header: 'Updated', hideOnMobile: true, cell: (r: any) => dateTime(r.updated_at) }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} />
        </Card>}
        {tab === 'feedback' && <>
          {summary && <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4"><StatCard label="Average rating" value={summary.avg_rating ? `${summary.avg_rating} ★` : '—'} hint="last 90 days" />
            <StatCard label="Satisfaction" value={summary.satisfaction_pct != null ? `${summary.satisfaction_pct}%` : '—'} tone="green" hint="4–5 star" /><StatCard label="Responses" value={summary.total} tone="violet" /><StatCard label="Negative" value={summary.negative} tone="red" hint="1–2 star" /></div>}
          <Card><div className="flex flex-wrap gap-3 border-b border-slate-100 p-4"><Select aria-label="Review status" className="w-44" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All" options={['pending', 'reviewed', 'action_taken', 'dismissed'].map((s) => ({ value: s, label: titleCase(s) }))} />
            <Checkbox label="Negative only (≤2★)" checked={params.maxRating === '2'} onChange={(e) => set({ maxRating: e.target.checked ? '2' : '' })} /></div>
            <DataTable rows={feedback.data?.data} loading={feedback.isLoading} error={feedback.error} meta={feedback.data?.meta} onPage={(page) => set({ page }, false)} empty={<EmptyState icon={Star} title="No feedback yet" />} columns={[
              { key: 'r', header: 'Rating', cell: (r: any) => <span className={cn('font-semibold', r.rating <= 2 ? 'text-red-600' : 'text-amber-500')}>{'★'.repeat(r.rating)}</span> },
              { key: 'c', header: 'Customer / job', cell: (r: any) => <div><p>{r.customer_name}</p><Link to={`/app/work-orders/${r.work_order_id}`} className="text-xs text-brand-700">{r.work_order_number}</Link></div> },
              { key: 't', header: 'Technician', hideOnMobile: true, cell: (r: any) => r.technician_name ? `${r.technician_name}${r.technician_rating ? ` (${r.technician_rating}★)` : ''}` : '—' },
              { key: 'm', header: 'Comment', cell: (r: any) => <p className="max-w-sm text-sm text-slate-600">{r.comment}{r.corrective_action && <span className="block text-xs text-emerald-700">Action: {r.corrective_action}</span>}</p> },
              { key: 's', header: 'Review', cell: (r: any) => <StatusBadge status={r.review_status} /> },
              { key: 'x', header: '', cell: (r: any) => can('support.manage') && r.review_status === 'pending' && <Button size="sm" variant="outline" onClick={() => setReview({ id: r.id, status: 'action_taken', correctiveAction: '', createTicket: r.rating <= 2 })}>Review</Button> }]} /></Card></>}
      </div>
      <Dialog open={open} onOpenChange={setOpen} title="New support ticket" footer={<Button disabled={!v.subject || !v.message} onClick={() => post('/app/support/tickets', { ...v, customerId: v.customerId || null }).then((r) => { setOpen(false); nav(`/app/support/${r.data.id}`); }).catch(toastError)}>Create</Button>}>
        <div className="space-y-3"><Field label="Customer"><CustomerPicker value={v.customerId} onChange={(id) => setV({ ...v, customerId: id })} /></Field>
          <Field label="Subject" required><Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Category"><Select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} options={CATS.map((c) => ({ value: c, label: titleCase(c) }))} /></Field>
            <Field label="Priority"><Select value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} options={['low', 'normal', 'high', 'urgent'].map((c) => ({ value: c, label: titleCase(c) }))} /></Field></div>
          <Field label="Details" required><Textarea rows={4} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} /></Field></div>
      </Dialog>
      <Dialog open={!!review} onOpenChange={(o) => !o && setReview(null)} title="Review feedback" footer={<Button onClick={() => post(`/app/support/feedback/${review.id}/review`, { status: review.status, correctiveAction: review.correctiveAction || null, createTicket: review.createTicket })
        .then(() => { setReview(null); feedback.refetch(); toast.success('Feedback reviewed'); }).catch(toastError)}>Save</Button>}>
        {review && <div className="space-y-3"><Field label="Outcome"><Select value={review.status} onChange={(e) => setReview({ ...review, status: e.target.value })} options={['reviewed', 'action_taken', 'dismissed'].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>
          <Field label="Corrective action"><Textarea rows={3} value={review.correctiveAction} onChange={(e) => setReview({ ...review, correctiveAction: e.target.value })} /></Field>
          <Checkbox label="Open a follow-up support ticket" checked={review.createTicket} onChange={(e) => setReview({ ...review, createTicket: e.target.checked })} /></div>}
      </Dialog>
    </div>
  );
}

function TicketDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data: t, isLoading, error, refetch } = useData<any>(['ticket', id], `/app/support/tickets/${id}`);
  const { data: users } = useData<any[]>(['users-min'], '/app/users');
  const [msg, setMsg] = useState({ body: '', internal: false });
  const [resolution, setResolution] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['ticket', id] });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const upd = (body: any) => patch(`/app/support/tickets/${t.id}`, body).then(() => { refresh(); toast.success('Ticket updated'); }).catch(toastError);
  return (
    <div>
      <PageHeader back={<BackLink to="/app/support" label="Support" />} title={<span className="flex items-center gap-3">{t.number}<StatusBadge status={t.status} /><PriorityBadge p={t.priority} /></span>} description={t.subject} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="Conversation" />
          <ul className="space-y-3 p-5">{t.messages.map((m: any) => (
            <li key={m.id} className={cn('rounded-lg p-3 text-sm', m.is_internal ? 'border border-amber-200 bg-amber-50' : m.author_type === 'customer' ? 'bg-slate-100' : m.author_type === 'system' ? 'text-center text-xs text-slate-500' : 'ml-8 bg-brand-50')}>
              {m.author_type !== 'system' && <p className="mb-1 text-xs text-slate-500">{m.author_name ?? titleCase(m.author_type)} · {dateTime(m.created_at)} {m.is_internal && <Badge tone="amber">Internal note</Badge>}</p>}
              <p className="whitespace-pre-line">{m.body}</p></li>))}</ul>
          {can('support.manage') && t.status !== 'closed' && <div className="space-y-2 border-t border-slate-100 p-4"><Textarea rows={3} placeholder="Reply to the customer or add an internal note…" value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
            <div className="flex items-center justify-between"><Checkbox label="Internal note (not visible to customer)" checked={msg.internal} onChange={(e) => setMsg({ ...msg, internal: e.target.checked })} />
              <Button size="sm" disabled={!msg.body.trim()} onClick={() => post(`/app/support/tickets/${t.id}/messages`, msg).then(() => { setMsg({ body: '', internal: false }); refresh(); }).catch(toastError)}>Send</Button></div></div>}
        </Card>
        <div className="space-y-6">
          <Card><CardHeader title="Details" /><CardBody className="space-y-3 text-sm">
            {t.customer_id && <p><Link to={`/app/customers/${t.customer_id}`} className="font-medium text-brand-700">{t.customer_name}</Link><br /><span className="text-slate-500">{t.customer_phone} {t.customer_email}</span></p>}
            {t.work_order_number && <p>Job: <Link to={`/app/work-orders/${t.work_order_id}`} className="text-brand-700">{t.work_order_number}</Link></p>}
            {can('support.manage') && <>
              <Field label="Status"><Select value={t.status} onChange={(e) => e.target.value === 'resolved' && !t.resolution ? toast.error('Add a resolution first') : upd({ status: e.target.value })} options={['open', 'in_progress', 'waiting_for_customer', 'resolved', 'closed'].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>
              <Field label="Priority"><Select value={t.priority} onChange={(e) => upd({ priority: e.target.value })} options={['low', 'normal', 'high', 'urgent'].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>
              <Field label="Assigned to"><Select value={t.assigned_to ?? ''} onChange={(e) => upd({ assignedTo: e.target.value || null })} placeholder="Unassigned" options={(users ?? []).filter((u) => u.is_active).map((u) => ({ value: u.id, label: u.full_name }))} /></Field>
            </>}
          </CardBody></Card>
          <Card><CardHeader title="Resolution" /><CardBody className="space-y-2">{t.resolution ? <p className="text-sm">{t.resolution}</p> : can('support.manage') && <>
            <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="How was this resolved?" /><Button size="sm" disabled={!resolution.trim()} onClick={() => upd({ resolution, status: 'resolved' })}>Resolve ticket</Button></>}</CardBody></Card>
        </div>
      </div>
    </div>
  );
}
export default function Support() { return <Routes><Route index element={<SupportHome />} /><Route path=":id" element={<TicketDetail />} /></Routes>; }
