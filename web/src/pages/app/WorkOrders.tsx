import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ClipboardList, FileDown, Kanban, List, MapPin, MoreHorizontal, Phone, Plus, Printer, Receipt, Sparkles, UserPlus, UserX, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, del, get, openFile, patch, post, put } from '@/lib/api';
import { useAction, useData, useListState, usePaged } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime, isoToLocal, localToIso, money, time } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, DescriptionList, Dialog, EmptyState, ErrorState, Field, Input, Menu, PageHeader, PageLoader, SearchInput, Select, StatusBadge, Tabs, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';
import { BackLink, CustomerPicker, DocumentsPanel, Timeline, useSettingsLists, useTechnicians } from './shared';

const STATUSES = ['new', 'approved', 'scheduled', 'assigned', 'en_route', 'in_progress', 'on_hold', 'completed', 'invoiced', 'paid', 'cancelled', 'rejected'];
const PRIORITY_TONE: Record<string, any> = { urgent: 'red', high: 'amber', normal: 'slate', low: 'slate' };
export const PriorityBadge = ({ p }: { p: string }) => (p === 'normal' ? null : <Badge tone={PRIORITY_TONE[p]}>{titleCase(p)}</Badge>);

// ---------------------------------------------------------------- assignment dialog (with rule-based suggestions)
export function AssignDialog({ wo, open, onOpenChange, onDone }: { wo: any; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { feature } = useAuth();
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(60);
  const [tech, setTech] = useState('');
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setStart(isoToLocal(wo.scheduled_start)); setDuration(wo.expected_duration_minutes ?? 60); setTech(''); setWarnings(null); } }, [open]); // eslint-disable-line
  const { data: sug, isFetching } = useQuery({ queryKey: ['suggest', wo.id, start], enabled: open && feature('dispatch_optimizer'),
    queryFn: async () => (await get(`/app/dispatch/suggestions/${wo.id}${start ? `?start=${encodeURIComponent(localToIso(start)!)}` : ''}`)).data });
  const { data: techs } = useTechnicians();
  const submit = async (force = false) => {
    if (!tech) return toast.error('Choose a technician');
    const chosen = sug?.suggestions.find((s: any) => s.technicianId === tech);
    const st = start ? localToIso(start) : chosen?.slotStart;
    if (!st) return toast.error('Choose a date and time');
    setBusy(true);
    try {
      await post(`/app/work-orders/${wo.id}/assign`, { technicianId: tech, scheduledStart: st, durationMinutes: duration, force, source: chosen ? 'suggestion' : 'manual' });
      toast.success('Technician assigned'); onOpenChange(false); onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ASSIGNMENT_WARNINGS') setWarnings(e.details.warnings);
      else toastError(e);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Assign ${wo.number}`} description="Suggestions consider skills, service area, availability, workload and travel. You make the final decision." size="lg"
      footer={warnings ? <><Button variant="outline" onClick={() => setWarnings(null)}>Change</Button><Button loading={busy} onClick={() => submit(true)}>Assign anyway</Button></> : <><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={busy} onClick={() => submit(false)}>Assign</Button></>}>
      {warnings ? <Alert tone="amber" title="Please review before assigning"><ul className="mt-1 list-disc pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Alert> : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Start"><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Duration (minutes)"><Input type="number" min={15} step={15} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></Field>
          </div>
          {feature('dispatch_optimizer') ? (
            <div><p className="label">Suggested technicians {isFetching && <span className="text-xs font-normal text-slate-400">updating…</span>}</p>
              <div className="max-h-80 space-y-2 overflow-y-auto">{sug?.suggestions.map((s: any) => (
                <label key={s.technicianId} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', tech === s.technicianId ? 'border-brand-500 bg-brand-50' : 'border-slate-200', !s.available && 'opacity-60')}>
                  <input type="radio" name="tech" className="mt-1" checked={tech === s.technicianId} onChange={() => { setTech(s.technicianId); if (!start && s.slotStart) setStart(isoToLocal(s.slotStart)); }} />
                  <div className="flex-1"><div className="flex items-center justify-between"><span className="font-medium">{s.name}</span><Badge tone={s.available ? (s.score >= 70 ? 'green' : 'blue') : 'red'}>{s.available ? `Score ${s.score}` : 'Unavailable'}</Badge></div>
                    <p className="mt-0.5 text-xs text-slate-500">{[...s.blockers, ...s.reasons].join(' · ')}</p>
                    {!start && s.slotStart && <p className="text-xs text-brand-700">Earliest slot: {dateTime(s.slotStart)}</p>}</div>
                </label>))}</div></div>
          ) : <Field label="Technician"><Select value={tech} onChange={(e) => setTech(e.target.value)} placeholder="Select…" options={(techs ?? []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: `${t.full_name} (${t.jobs_on_date} today)` }))} /></Field>}
        </div>)}
    </Dialog>
  );
}

// ---------------------------------------------------------------- list & board
function Board() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useData<any>(['wo-board'], '/app/work-orders/board');
  const [drag, setDrag] = useState<any>(null);
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const drop = async (status: string) => {
    if (!drag || drag.status === status) return;
    if (!data.transitions[drag.status]?.includes(status)) { toast.error(`Cannot move from ${titleCase(drag.status)} to ${titleCase(status)}`); return; }
    if (['on_hold', 'cancelled'].includes(status)) { nav(`/app/work-orders/${drag.id}`); return; }
    try { await post(`/app/work-orders/${drag.id}/status`, { status, version: drag.version }); qc.invalidateQueries({ queryKey: ['wo-board'] }); toast.success(`${drag.number} → ${titleCase(status)}`); } catch (e) { toastError(e); }
  };
  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {data.columns.map((c: any) => (
        <div key={c.status} className="w-72 shrink-0 rounded-xl bg-slate-100/80 p-2" onDragOver={(e) => e.preventDefault()} onDrop={() => drop(c.status)}>
          <div className="mb-2 flex items-center justify-between px-1.5"><StatusBadge status={c.status} /><span className="text-xs text-slate-500">{c.items.length}</span></div>
          <div className="space-y-2">{c.items.map((w: any) => (
            <div key={w.id} draggable onDragStart={() => setDrag(w)} onClick={() => nav(`/app/work-orders/${w.id}`)} className="cursor-pointer rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-card hover:border-brand-300">
              <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-slate-500">{w.number}</span><PriorityBadge p={w.priority} /></div>
              <p className="mt-1 line-clamp-2 font-medium text-slate-800">{w.title}</p><p className="mt-1 text-xs text-slate-500">{w.customer_name}{w.city ? ` · ${w.city}` : ''}</p>
              <p className="mt-1.5 text-xs text-slate-500">{w.scheduled_start ? dateTime(w.scheduled_start) : 'Not scheduled'}{w.technician_name ? ` · ${w.technician_name}` : ''}</p>
            </div>))}{!c.items.length && <p className="px-2 py-6 text-center text-xs text-slate-400">No jobs</p>}</div>
        </div>))}
    </div>
  );
}

function WorkOrderList() {
  const nav = useNavigate();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { params, set, sort, toggleSort } = useListState();
  const view = params.view ?? 'list';
  const { data, isLoading, error, refetch } = usePaged('/app/work-orders', { ...params, view: undefined }, view === 'list');
  const { data: techs } = useTechnicians();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const bulk = async (action: 'priority' | 'cancel' | 'approve', extra: any = {}) => {
    try { const r = await post('/app/work-orders/bulk', { ids: [...sel], action, ...extra }); toast.success(`${r.data.succeeded} updated${r.data.failed ? `, ${r.data.failed} skipped` : ''}`); setSel(new Set()); qc.invalidateQueries({ queryKey: ['/app/work-orders'] }); }
    catch (e) { toastError(e); }
  };
  return (
    <div>
      <PageHeader title="Work orders" description="Every job from request to payment."
        actions={<>
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5"><Button size="sm" variant={view === 'list' ? 'secondary' : 'ghost'} onClick={() => set({ view: 'list' })}><List />List</Button>
            <Button size="sm" variant={view === 'board' ? 'secondary' : 'ghost'} onClick={() => set({ view: 'board' })}><Kanban />Board</Button></div>
          <Button variant="outline" onClick={() => nav('/app/calendar')}><CalendarClock />Calendar</Button>
          {can('work_orders.create') && <Button onClick={() => nav('/app/work-orders/new')}><Plus />New job</Button>}
        </>} />
      {view === 'board' ? <Board /> : (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
            <SearchInput className="w-full sm:w-64" value={params.q ?? ''} onChange={(q) => set({ q })} placeholder="Job number, title, customer…" />
            <Select aria-label="Status" className="w-40" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
            <Select aria-label="Priority" className="w-32" value={params.priority ?? ''} onChange={(e) => set({ priority: e.target.value })} placeholder="Any priority" options={['urgent', 'high', 'normal', 'low'].map((s) => ({ value: s, label: titleCase(s) }))} />
            <Select aria-label="Technician" className="w-44" value={params.technicianId ?? ''} onChange={(e) => set({ technicianId: e.target.value })} placeholder="All technicians" options={(techs ?? []).map((t) => ({ value: t.id, label: t.full_name }))} />
            <Checkbox label="Unassigned" checked={params.unassigned === '1'} onChange={(e) => set({ unassigned: e.target.checked ? '1' : '' })} />
            <Checkbox label="Overdue" checked={params.overdue === '1'} onChange={(e) => set({ overdue: e.target.checked ? '1' : '' })} />
          </div>
          {sel.size > 0 && <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-brand-50 px-4 py-2 text-sm">
            <span className="font-medium text-brand-900">{sel.size} selected</span>
            <Button size="sm" variant="outline" onClick={() => bulk('approve')}>Approve</Button>
            <Menu trigger={<Button size="sm" variant="outline">Set priority</Button>} items={['urgent', 'high', 'normal', 'low'].map((p) => ({ label: titleCase(p), onSelect: () => bulk('priority', { priority: p }) }))} />
            {can('work_orders.cancel') && <Button size="sm" variant="danger-outline" onClick={async () => { const r = await confirm({ title: `Cancel ${sel.size} job(s)?`, requireReason: true, danger: true, confirmLabel: 'Cancel jobs' }); if (r) bulk('cancel', { reason: r.reason }); }}>Cancel</Button>}
            <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Clear</Button></div>}
          <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} sort={sort} onSort={toggleSort}
            selectable={can('work_orders.update')} selected={sel} onSelect={setSel} onRowClick={(r: any) => nav(`/app/work-orders/${r.id}`)}
            empty={<EmptyState icon={ClipboardList} title="No work orders" description="Create a job or convert a service request." />}
            columns={[
              { key: 'number', header: 'Job', sortable: true, cell: (r: any) => <div><p className="font-medium text-slate-900">{r.number}</p><p className="max-w-[260px] truncate text-xs text-slate-500">{r.title}</p></div> },
              { key: 'customer', header: 'Customer', sortable: true, cell: (r: any) => <div><p>{r.customer_name}</p><p className="text-xs text-slate-500">{r.city ?? ''}</p></div> },
              { key: 'scheduled', header: 'Scheduled', sortable: true, hideOnMobile: true, cell: (r: any) => r.scheduled_start ? <span className={cn(new Date(r.scheduled_start) < new Date() && ['scheduled', 'assigned', 'en_route'].includes(r.status) && 'text-red-600')}>{dateTime(r.scheduled_start)}</span> : <span className="text-slate-400">—</span> },
              { key: 'tech', header: 'Technician', hideOnMobile: true, cell: (r: any) => r.technician_name ?? <span className="text-slate-400">Unassigned</span> },
              { key: 'priority', header: 'Priority', sortable: true, hideOnMobile: true, cell: (r: any) => <PriorityBadge p={r.priority} /> },
              { key: 'status', header: 'Status', sortable: true, cell: (r: any) => <div className="flex items-center gap-1"><StatusBadge status={r.status} />{r.reschedule_count > 0 && <Badge tone="slate">Rescheduled</Badge>}</div> },
            ]} />
        </Card>)}
    </div>
  );
}

// ---------------------------------------------------------------- create
function NewWorkOrder() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { data: s } = useSettingsLists();
  const { can } = useAuth();
  const { data: techs } = useTechnicians();
  const [v, setV] = useState<any>({ customerId: sp.get('customerId') ?? '', title: '', description: '', priority: 'normal', serviceCategoryId: '', addressId: '', assetId: '', scheduledStart: '', expectedDurationMinutes: '', estimatedCost: '', internalNotes: '', technicianId: '' });
  const { data: cust } = useQuery({ queryKey: ['customer', v.customerId], queryFn: async () => (await get(`/app/customers/${v.customerId}`)).data, enabled: !!v.customerId });
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<string[] | null>(null);
  const submit = async (force = false) => {
    setBusy(true);
    try {
      const body = { ...v, scheduledStart: v.scheduledStart ? localToIso(v.scheduledStart) : null, expectedDurationMinutes: v.expectedDurationMinutes ? Number(v.expectedDurationMinutes) : null,
        estimatedCost: v.estimatedCost ? Number(v.estimatedCost) : null, technicianId: v.technicianId || null, serviceCategoryId: v.serviceCategoryId || null, addressId: v.addressId || null,
        assetId: v.assetId || null, force };
      const r = await post('/app/work-orders', body);
      toast.success(`Job ${r.data.number} created`); nav(`/app/work-orders/${r.data.id}`);
    } catch (e) { if (e instanceof ApiError && e.code === 'ASSIGNMENT_WARNINGS') setWarn(e.details.warnings); else toastError(e); } finally { setBusy(false); }
  };
  const f = (k: string) => ({ value: v[k], onChange: (e: any) => setV({ ...v, [k]: e.target.value }) });
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader back={<BackLink to="/app/work-orders" label="Work orders" />} title="New work order" />
      <Card><CardBody className="space-y-4">
        <Field label="Customer" required><CustomerPicker value={v.customerId} onChange={(id) => setV({ ...v, customerId: id, addressId: '', assetId: '' })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Service location"><Select {...f('addressId')} placeholder="Default address" disabled={!cust} options={(cust?.addresses ?? []).map((a: any) => ({ value: a.id, label: `${a.label}: ${a.line1}, ${a.city ?? ''}` }))} /></Field>
          <Field label="Equipment"><Select {...f('assetId')} placeholder="None" disabled={!cust} options={(cust?.assets ?? []).map((a: any) => ({ value: a.id, label: `${a.name} · ${a.number}` }))} /></Field>
          <Field label="Service category"><Select {...f('serviceCategoryId')} placeholder="Select…" options={(s?.serviceCategories ?? []).filter((c: any) => c.is_active).map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Priority"><Select {...f('priority')} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: titleCase(p) }))} /></Field>
        </div>
        <Field label="Title" required><Input {...f('title')} placeholder="e.g. AC not cooling — bedroom" /></Field>
        <Field label="Description"><Textarea {...f('description')} rows={3} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Scheduled start"><Input type="datetime-local" {...f('scheduledStart')} /></Field>
          <Field label="Duration (min)" hint="Defaults from category"><Input type="number" min={5} {...f('expectedDurationMinutes')} /></Field>
          <Field label="Estimated cost"><Input type="number" min={0} step="0.01" {...f('estimatedCost')} /></Field>
        </div>
        {can('work_orders.assign') && <Field label="Assign technician" hint="Requires a scheduled start. Use Dispatch for suggestions."><Select {...f('technicianId')} placeholder="Assign later" options={(techs ?? []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: t.full_name }))} /></Field>}
        <Field label="Internal notes" hint="Not visible to the customer"><Textarea {...f('internalNotes')} rows={2} /></Field>
        {warn && <Alert tone="amber" title="Assignment warnings" action={<Button size="sm" onClick={() => submit(true)}>Create anyway</Button>}><ul className="list-disc pl-5">{warn.map((w) => <li key={w}>{w}</li>)}</ul></Alert>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => nav(-1)}>Cancel</Button><Button loading={busy} disabled={!v.customerId || v.title.trim().length < 3} onClick={() => submit()}>Create job</Button></div>
      </CardBody></Card>
    </div>
  );
}

// ---------------------------------------------------------------- detail
const NEXT_LABEL: Record<string, string> = { approved: 'Approve', scheduled: 'Mark scheduled', en_route: 'Mark en route', in_progress: 'Start work', on_hold: 'Put on hold', completed: 'Complete job', cancelled: 'Cancel job', rejected: 'Reject', assigned: 'Resume (assigned)' };

function WorkOrderDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, feature } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: w, isLoading, error, refetch } = useData<any>(['wo', id], `/app/work-orders/${id}`);
  const [tab, setTab] = useState('overview');
  const [assignOpen, setAssignOpen] = useState(false);
  const [resched, setResched] = useState<{ start: string; reason: string } | null>(null);
  const [note, setNote] = useState({ body: '', visibility: 'internal' });
  const [report, setReport] = useState<any>(null);
  const [part, setPart] = useState<any>(null);
  const [labour, setLabour] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['wo', id] }); qc.invalidateQueries({ queryKey: ['/app/work-orders'] }); };
  const act = useAction((fn: () => Promise<any>) => fn(), { onSuccess: refresh });
  useEffect(() => { if (w) setReport(w.report ?? { reported_issue: w.description }); }, [w?.id, w?.report?.updated_at]); // eslint-disable-line
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  const transition = async (to: string) => {
    let reason: string | undefined;
    if (['on_hold', 'cancelled', 'rejected'].includes(to)) { const r = await confirm({ title: `${NEXT_LABEL[to]}?`, requireReason: true, danger: to !== 'on_hold', confirmLabel: NEXT_LABEL[to] }); if (!r) return; reason = r.reason; }
    act.mutate(() => post(`/app/work-orders/${w.id}/status`, { status: to, reason, version: w.version }).then(() => toast.success(`Status: ${titleCase(to)}`)));
  };
  const closed = ['invoiced', 'paid', 'cancelled', 'rejected'].includes(w.status);
  const primary = (w.allowedTransitions as string[]).filter((s) => !['cancelled', 'rejected', 'on_hold', 'scheduled', 'approved', 'assigned'].includes(s) || (s === 'approved' && w.status === 'new'));

  return (
    <div>
      <PageHeader back={<BackLink to="/app/work-orders" label="Work orders" />}
        title={<span className="flex flex-wrap items-center gap-3">{w.number}<StatusBadge status={w.status} /><PriorityBadge p={w.priority} /></span>}
        description={w.title}
        actions={<>
          {can('work_orders.status') && primary.map((s) => <Button key={s} onClick={() => transition(s)} loading={act.isPending}>{NEXT_LABEL[s] ?? titleCase(s)}</Button>)}
          {can('work_orders.assign') && !closed && !['in_progress', 'completed'].includes(w.status) && <Button variant="outline" onClick={() => setAssignOpen(true)}><UserPlus />{w.assigned_technician_id ? 'Reassign' : 'Assign'}</Button>}
          {w.status === 'completed' && can('invoices.manage') && feature('invoicing') && !w.invoices.length && <Button variant="navy" onClick={() => act.mutate(() => post('/app/invoices', { workOrderId: w.id }).then((r) => nav(`/app/invoices/${r.data.id}`)))}><Receipt />Create invoice</Button>}
          <Menu trigger={<Button variant="outline" size="icon" aria-label="More"><MoreHorizontal /></Button>} items={[
            { label: 'Print job sheet', icon: Printer, onSelect: () => openFile(`/app/work-orders/${w.id}/job-sheet.pdf`).catch(toastError) },
            { label: 'Service report PDF', icon: FileDown, onSelect: () => openFile(`/app/work-orders/${w.id}/report.pdf`).catch(toastError) },
            ...(can('work_orders.update') && !closed && w.status !== 'in_progress' ? [{ label: 'Reschedule', icon: CalendarClock, onSelect: () => setResched({ start: isoToLocal(w.scheduled_start), reason: '' }) }] : []),
            ...(can('work_orders.assign') && w.assigned_technician_id && !['in_progress', 'completed', 'invoiced', 'paid'].includes(w.status) ? [{ label: 'Unassign technician', icon: UserX, onSelect: () => act.mutate(() => post(`/app/work-orders/${w.id}/unassign`, {})) }] : []),
            ...(can('quotations.manage') && feature('quotations') ? [{ label: 'Create quotation', icon: Receipt, onSelect: () => nav(`/app/quotations/new?customerId=${w.customer_id}&workOrderId=${w.id}`) }] : []),
            'sep' as const,
            ...(w.allowedTransitions.includes('on_hold') && can('work_orders.status') ? [{ label: 'Put on hold', onSelect: () => transition('on_hold') }] : []),
            ...(w.allowedTransitions.includes('cancelled') && can('work_orders.cancel') ? [{ label: 'Cancel job', danger: true, onSelect: () => transition('cancelled') }] : []),
            ...(w.allowedTransitions.includes('rejected') && can('work_orders.status') ? [{ label: 'Reject', danger: true, onSelect: () => transition('rejected') }] : []),
          ]} />
        </>} />
      {w.status === 'on_hold' && <div className="mb-4"><Alert tone="amber" title="On hold">{w.hold_reason}</Alert></div>}
      {['cancelled', 'rejected'].includes(w.status) && <div className="mb-4"><Alert tone="red" title={titleCase(w.status)}>{w.cancellation_reason}</Alert></div>}
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'work', label: 'Parts & labour', count: w.parts.length + w.labour.length },
        { value: 'report', label: 'Service report' }, { value: 'documents', label: 'Photos & files', count: w.documents.length }, { value: 'history', label: 'History' }]} />
      <div className="mt-5">
        {tab === 'overview' && <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card><CardHeader title="Job details" /><CardBody>
              <DescriptionList items={[['Service', w.category_name], ['Scheduled', w.scheduled_start ? `${dateTime(w.scheduled_start)} (${w.expected_duration_minutes} min)` : 'Not scheduled'],
                ['Technician', w.technician_name ?? 'Unassigned'], ['Accepted by technician', w.accepted_at ? dateTime(w.accepted_at) : '—'], ['Actual start', dateTime(w.actual_start)], ['Actual completion', dateTime(w.actual_end)],
                ['Estimated cost', w.estimated_cost != null ? money(w.estimated_cost) : '—'], ['Actual cost', w.actual_cost != null ? money(w.actual_cost) : '—'],
                ['Source request', w.request_number ? <Link to={`/app/requests/${w.service_request_id}`} className="text-brand-700">{w.request_number}</Link> : '—'], ['Branch', w.branch_name]]} />
              {w.description && <p className="mt-5 whitespace-pre-line text-sm text-slate-700">{w.description}</p>}
              {w.internal_notes && <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p className="text-xs font-semibold uppercase">Internal notes</p><p className="whitespace-pre-line">{w.internal_notes}</p></div>}
            </CardBody></Card>
            <Card><CardHeader title="Notes" />
              <ul className="divide-y divide-slate-100">{w.notes.map((n: any) => <li key={n.id} className="px-5 py-3 text-sm"><p className="text-xs text-slate-500">{n.author_name} · {dateTime(n.created_at)} {n.visibility === 'customer' && <Badge tone="blue">Visible to customer</Badge>}</p><p className="mt-1 whitespace-pre-line">{n.body}</p></li>)}</ul>
              {!closed && <div className="space-y-2 border-t border-slate-100 p-4"><Textarea rows={2} placeholder="Add a note…" value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} />
                <div className="flex items-center justify-between"><Checkbox label="Visible to customer" checked={note.visibility === 'customer'} onChange={(e) => setNote({ ...note, visibility: e.target.checked ? 'customer' : 'internal' })} />
                  <Button size="sm" disabled={!note.body.trim()} onClick={() => act.mutate(() => post(`/app/work-orders/${w.id}/notes`, note).then(() => setNote({ body: '', visibility: 'internal' })))}>Add note</Button></div></div>}
            </Card>
          </div>
          <div className="space-y-6">
            <Card><CardHeader title="Customer" /><CardBody className="space-y-2 text-sm">
              <Link to={`/app/customers/${w.customer_id}`} className="font-medium text-brand-700">{w.customer_name}</Link>
              {w.customer_phone && <a href={`tel:${w.customer_phone}`} className="flex items-center gap-2 text-slate-700"><Phone className="h-4 w-4" />{w.customer_phone}</a>}
              {w.address && <div className="flex items-start gap-2 text-slate-700"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /><span>{[w.address.line1, w.address.line2, w.address.city, w.address.postal_code].filter(Boolean).join(', ')}
                {w.address.access_notes && <span className="block text-xs text-slate-500">{w.address.access_notes}</span>}{w.mapUrl && <a href={w.mapUrl} target="_blank" rel="noreferrer" className="block text-xs text-brand-700">Open in Maps</a>}</span></div>}
            </CardBody></Card>
            {w.asset && <Card><CardHeader title="Equipment" /><CardBody className="text-sm"><Link to={`/app/assets/${w.asset.id}`} className="font-medium text-brand-700">{w.asset.name}</Link>
              <p className="text-slate-600">{[w.asset.manufacturer, w.asset.model].filter(Boolean).join(' ')}</p><p className="text-xs text-slate-500">S/N {w.asset.serial_number ?? '—'} · Warranty {date(w.asset.warranty_expiry)}</p></CardBody></Card>}
            {(w.quotations.length > 0 || w.invoices.length > 0) && <Card><CardHeader title="Billing" /><ul className="divide-y divide-slate-100 text-sm">
              {w.quotations.map((q: any) => <li key={q.id}><Link to={`/app/quotations/${q.id}`} className="flex justify-between px-5 py-2.5 hover:bg-slate-50"><span>Quote {q.number}{q.revision > 1 && ` R${q.revision}`}</span><StatusBadge status={q.status} /></Link></li>)}
              {w.invoices.map((i: any) => <li key={i.id}><Link to={`/app/invoices/${i.id}`} className="flex justify-between px-5 py-2.5 hover:bg-slate-50"><span>Invoice {i.number ?? 'draft'} · {money(i.total, i.currency)}</span><StatusBadge status={i.status} /></Link></li>)}</ul></Card>}
            {w.feedback && <Card><CardHeader title="Customer feedback" /><CardBody className="text-sm"><p className="text-lg text-amber-500">{'★'.repeat(w.feedback.rating)}<span className="text-slate-200">{'★'.repeat(5 - w.feedback.rating)}</span></p><p className="mt-1 text-slate-600">{w.feedback.comment}</p></CardBody></Card>}
          </div>
        </div>}
        {tab === 'work' && <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="Parts used" actions={!closed && <Button size="sm" variant="outline" onClick={() => setPart({ itemId: '', description: '', quantity: 1, unitPrice: '' })}><Plus />Add part</Button>} />
            <DataTable rows={w.parts} empty={<EmptyState title="No parts recorded" />} columns={[{ key: 'd', header: 'Part', cell: (p: any) => <div><p>{p.description}</p><p className="text-xs text-slate-500">{p.sku ?? 'Non-catalogue'}</p></div> },
              { key: 'q', header: 'Qty', className: 'text-right', cell: (p: any) => `${Number(p.quantity)} ${p.unit ?? ''}` }, { key: 'p', header: 'Price', className: 'text-right', cell: (p: any) => p.unit_price !== undefined ? money(p.unit_price) : '—' },
              { key: 'x', header: '', cell: (p: any) => !closed && <Button size="icon-sm" variant="ghost" aria-label="Remove part" onClick={async () => { if (await confirm({ title: 'Remove part?', description: 'Stock will be returned to inventory.', confirmLabel: 'Remove', danger: true })) act.mutate(() => del(`/app/work-orders/${w.id}/parts/${p.id}`)); }}><X /></Button> }]} /></Card>
          <Card><CardHeader title="Labour" actions={!closed && <Button size="sm" variant="outline" onClick={() => setLabour({ description: '', hours: 1, rate: '' })}><Plus />Add labour</Button>} />
            <DataTable rows={w.labour} empty={<EmptyState title="No labour recorded" />} columns={[{ key: 'd', header: 'Work', cell: (l: any) => <div><p>{l.description}</p><p className="text-xs text-slate-500">{l.technician_name}</p></div> },
              { key: 'h', header: 'Hours', className: 'text-right', cell: (l: any) => Number(l.hours) }, { key: 'r', header: 'Rate', className: 'text-right', cell: (l: any) => l.rate !== undefined ? money(l.rate) : '—' },
              { key: 'x', header: '', cell: (l: any) => !closed && <Button size="icon-sm" variant="ghost" aria-label="Remove labour" onClick={() => act.mutate(() => del(`/app/work-orders/${w.id}/labour/${l.id}`))}><X /></Button> }]} /></Card>
        </div>}
        {tab === 'report' && report && <ReportEditor w={w} report={report} setReport={setReport} onSaved={refresh} />}
        {tab === 'documents' && <DocumentsPanel entityType="work_order" entityId={w.id} title="Photos & files" onChange={refresh} />}
        {tab === 'history' && <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="Status history" /><CardBody><Timeline items={w.history.map((h: any) => ({ title: `${h.from_status ? `${titleCase(h.from_status)} → ` : ''}${titleCase(h.to_status)}`, meta: `${dateTime(h.changed_at)}${h.changed_by_name ? ` · ${h.changed_by_name}` : ''}`, body: h.note }))} /></CardBody></Card>
          <Card><CardHeader title="Assignments" /><CardBody>{w.assignments.length ? <Timeline items={w.assignments.map((a: any) => ({ title: `${a.technician_name}${a.is_current ? ' (current)' : ''}`,
            meta: `${dateTime(a.starts_at)} – ${time(a.ends_at)} · by ${a.assigned_by_name ?? 'system'} · ${titleCase(a.assignment_source)}`, body: a.end_reason ? `Ended: ${titleCase(a.end_reason)}` : undefined }))} /> : <EmptyState title="Never assigned" />}</CardBody></Card>
        </div>}
      </div>
      <AssignDialog wo={w} open={assignOpen} onOpenChange={setAssignOpen} onDone={refresh} />
      <Dialog open={!!resched} onOpenChange={(o) => !o && setResched(null)} title="Reschedule job" footer={<Button loading={act.isPending} onClick={() => act.mutate(async () => {
        try { await post(`/app/work-orders/${w.id}/reschedule`, { scheduledStart: localToIso(resched!.start), reason: resched!.reason || null }); }
        catch (e) { if (e instanceof ApiError && e.code === 'ASSIGNMENT_WARNINGS' && window.confirm(`Warnings:\n${e.details.warnings.join('\n')}\n\nReschedule anyway?`)) await post(`/app/work-orders/${w.id}/reschedule`, { scheduledStart: localToIso(resched!.start), reason: resched!.reason || null, force: true }); else throw e; }
        setResched(null); toast.success('Rescheduled — customer will be notified'); })}>Reschedule</Button>}>
        <div className="space-y-3"><Field label="New start"><Input type="datetime-local" value={resched?.start ?? ''} onChange={(e) => setResched({ ...resched!, start: e.target.value })} /></Field>
          <Field label="Reason"><Input value={resched?.reason ?? ''} onChange={(e) => setResched({ ...resched!, reason: e.target.value })} /></Field></div>
      </Dialog>
      <PartDialog part={part} setPart={setPart} onSave={(p: any) => act.mutate(() => post(`/app/work-orders/${w.id}/parts`, p).then(() => setPart(null)))} />
      <Dialog open={!!labour} onOpenChange={(o) => !o && setLabour(null)} title="Add labour" footer={<Button onClick={() => act.mutate(() => post(`/app/work-orders/${w.id}/labour`, { description: labour.description, hours: Number(labour.hours), rate: labour.rate === '' ? undefined : Number(labour.rate) }).then(() => setLabour(null)))}>Add</Button>}>
        {labour && <div className="grid gap-3 sm:grid-cols-3"><Field label="Description" className="sm:col-span-3"><Input value={labour.description} onChange={(e) => setLabour({ ...labour, description: e.target.value })} /></Field>
          <Field label="Hours"><Input type="number" min={0.25} step={0.25} value={labour.hours} onChange={(e) => setLabour({ ...labour, hours: e.target.value })} /></Field>
          <Field label="Rate" hint="Blank = category default"><Input type="number" min={0} value={labour.rate} onChange={(e) => setLabour({ ...labour, rate: e.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}

export function PartDialog({ part, setPart, onSave, hidePrice }: { part: any; setPart: (p: any) => void; onSave: (p: any) => void; hidePrice?: boolean }) {
  const { feature } = useAuth();
  const [q, setQ] = useState('');
  const { data: items } = useQuery({ queryKey: ['inv-pick', q], queryFn: async () => (await get(`/app/inventory/items?q=${encodeURIComponent(q)}&pageSize=8`)).data as any[], enabled: !!part && feature('inventory') });
  return (
    <Dialog open={!!part} onOpenChange={(o) => !o && setPart(null)} title="Record part used"
      footer={<Button disabled={!part?.itemId && !part?.description} onClick={() => onSave({ itemId: part.itemId || null, description: part.description || undefined, quantity: Number(part.quantity), unitPrice: part.unitPrice === '' || part.unitPrice === undefined ? undefined : Number(part.unitPrice) })}>Save</Button>}>
      {part && <div className="space-y-3">
        {feature('inventory') && <Field label="From inventory" hint="Stock is deducted automatically"><Input placeholder="Search SKU or name…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">{items?.map((i) => <button key={i.id} type="button" onClick={() => setPart({ ...part, itemId: i.id, description: i.name })}
            className={cn('flex w-full justify-between rounded-md border px-3 py-2 text-left text-sm', part.itemId === i.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200')}><span>{i.sku} · {i.name}</span><span className="text-xs text-slate-500">{Number(i.on_hand)} {i.unit}</span></button>)}</div></Field>}
        <Field label={feature('inventory') ? 'Or non-catalogue part' : 'Part description'}><Input value={part.itemId ? '' : part.description} disabled={!!part.itemId} onChange={(e) => setPart({ ...part, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Quantity"><Input type="number" min={0.001} step="any" value={part.quantity} onChange={(e) => setPart({ ...part, quantity: e.target.value })} /></Field>
          {!hidePrice && <Field label="Unit price" hint="Blank = catalogue price"><Input type="number" min={0} value={part.unitPrice} onChange={(e) => setPart({ ...part, unitPrice: e.target.value })} /></Field>}</div>
      </div>}
    </Dialog>
  );
}

export function ReportEditor({ w, report, setReport, onSaved, compact }: { w: any; report: any; setReport: (r: any) => void; onSaved: () => void; compact?: boolean }) {
  const { feature, can } = useAuth();
  const [notes, setNotes] = useState(report.technician_notes ?? '');
  const [busy, setBusy] = useState(false);
  const locked = !!report.customer_approved_at || ['invoiced', 'paid', 'cancelled', 'rejected'].includes(w.status);
  const f = (k: string) => ({ value: report[k] ?? '', disabled: locked, onChange: (e: any) => setReport({ ...report, [k]: e.target.value }) });
  const save = async () => {
    setBusy(true);
    try { await put(`/app/work-orders/${w.id}/report`, { reportedIssue: report.reported_issue || null, findings: report.findings || null, workPerformed: report.work_performed || null,
      recommendations: report.recommendations || null, followUpRequired: !!report.follow_up_required, followUpNotes: report.follow_up_notes || null, equipmentCondition: report.equipment_condition || null,
      technicianNotes: notes || null, aiGenerated: !!report.ai_generated }); toast.success('Report saved'); onSaved(); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const ai = async () => {
    setBusy(true);
    try { const r = await post(`/app/ai/service-report/${w.id}`, { notes }); setReport({ ...report, reported_issue: r.data.reportedIssue, findings: r.data.findings, work_performed: r.data.workPerformed,
      recommendations: r.data.recommendations, follow_up_required: r.data.followUpRequired, follow_up_notes: r.data.followUpNotes, ai_generated: true });
      toast.success('Draft generated — review and edit before saving'); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader title="Service report" description={locked ? 'Locked — signed by the customer or job closed' : 'Shared with the customer once the job is complete'} actions={report.ai_generated && <Badge tone="violet">AI-assisted draft</Badge>} />
      <CardBody className="space-y-4">
        {!locked && feature('ai') && can('ai.use') && <div className="rounded-lg border border-violet-200 bg-violet-50 p-3"><Field label="Rough notes for AI" hint="Write quickly; AI turns them into a professional report you can edit.">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="found coil dirty, gas low, cleaned coil, topped up gas 1kg, cooling ok now, recommend service every 4 months" /></Field>
          <Button size="sm" variant="outline" className="mt-2" loading={busy} disabled={notes.trim().length < 5} onClick={ai}><Sparkles />Draft report with AI</Button></div>}
        <div className={cn('grid gap-4', !compact && 'sm:grid-cols-2')}>
          <Field label="Reported issue"><Textarea rows={2} {...f('reported_issue')} /></Field>
          <Field label="Inspection findings"><Textarea rows={2} {...f('findings')} /></Field>
          <Field label="Work performed" required><Textarea rows={3} {...f('work_performed')} /></Field>
          <Field label="Recommendations"><Textarea rows={3} {...f('recommendations')} /></Field>
          <Field label="Equipment condition"><Select {...f('equipment_condition')} placeholder="—" options={['good', 'fair', 'poor', 'critical'].map((c) => ({ value: c, label: titleCase(c) }))} /></Field>
          <div className="space-y-2 pt-6"><Checkbox label="Follow-up visit required" disabled={locked} checked={!!report.follow_up_required} onChange={(e) => setReport({ ...report, follow_up_required: e.target.checked })} />
            {report.follow_up_required && <Input placeholder="Follow-up details" {...f('follow_up_notes')} />}</div>
        </div>
        {report.customer_approved_at && <Alert tone="green">Signed by {report.customer_signed_name} on {dateTime(report.customer_approved_at)}</Alert>}
        {!locked && <div className="flex justify-end"><Button loading={busy} onClick={save}>Save report</Button></div>}
      </CardBody></Card>
  );
}

export default function WorkOrders() {
  return <Routes><Route index element={<WorkOrderList />} /><Route path="new" element={<NewWorkOrder />} /><Route path=":id" element={<WorkOrderDetail />} /></Routes>;
}
export { patch };
