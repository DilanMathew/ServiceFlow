import { useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, ChevronRight, Clock, LogIn, LogOut, MapPin, Navigation, Pause, Phone, Play, Plus, Truck, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { dateTime, time } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, PageLoader, StatusBadge, Textarea, useConfirm } from '@/components/ui';
import { toastError } from '@/components/form';
import { PartDialog, PriorityBadge, ReportEditor } from '../app/WorkOrders';
import { CalendarView } from '../app/Calendar';
import { useFilePreview } from '../app/shared';
import Profile from '../app/Profile';
import { act, localStatus, OfflineBar, patchJob, prefetchJobs, PushCard, useOfflineData, useOutbox } from './offline';

function JobCard({ j }: { j: any }) {
  return (
    <Link to={`/tech/jobs/${j.id}`} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-card active:bg-slate-50">
      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs font-semibold text-slate-500">{j.number} · {j.category_name ?? 'Service'}</p>
        <p className="mt-0.5 font-semibold text-navy-900">{j.customer_name}</p><p className="truncate text-sm text-slate-600">{j.title}</p></div>
        <div className="flex flex-col items-end gap-1"><StatusBadge status={j.status} /><PriorityBadge p={j.priority} /></div></div>
      <div className="mt-3 flex items-center justify-between text-sm text-slate-600"><span className="flex items-center gap-1"><Clock className="h-4 w-4" />{j.scheduled_start ? time(j.scheduled_start) : '—'} · {j.expected_duration_minutes} min</span>
        <span className="flex items-center gap-1 truncate"><MapPin className="h-4 w-4" />{j.city ?? j.line1 ?? ''}</span><ChevronRight className="h-4 w-4 text-slate-400" /></div>
      {!j.accepted_at && j.status === 'assigned' && <p className="mt-2 text-xs font-medium text-amber-700">New — tap to review and accept</p>}
    </Link>
  );
}

function Today() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useOfflineData<any>(['tech-dash'], '/app/technicians/me/dashboard', { refetchInterval: 60_000 });
  // Keep upcoming jobs on the device so they open without signal.
  const ids = data ? [...data.today, ...data.upcoming].map((j: any) => j.id as string) : [];
  useEffect(() => { if (ids.length && navigator.onLine) void prefetchJobs(qc, ids); }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const att = data.attendance;
  const mark = (action: string) => act({ kind: 'attendance', method: 'POST', path: '/app/technicians/me/attendance', json: { action }, label: action === 'check_in' ? 'Check in' : 'Check out' },
    { success: action === 'check_in' ? 'Checked in' : 'Checked out',
      onQueued: () => qc.setQueryData(['tech-dash'], (d: any) => d && ({ ...d, attendance: { ...(d.attendance ?? {}), [action === 'check_in' ? 'check_in_at' : 'check_out_at']: new Date().toISOString() } })) })
    .then((queued) => { if (!queued) refetch(); }).catch(toastError);
  return (
    <div className="space-y-5">
      <PushCard compact />
      <div className="flex items-center justify-between"><div><h1 className="text-xl font-semibold text-navy-900">Hi {me?.user.full_name.split(' ')[0]}</h1>
        <p className="text-sm text-slate-500">{data.today.length} job(s) today · {data.stats.completed_today} done</p></div>
        {!att?.check_in_at ? <Button onClick={() => mark('check_in')}><LogIn />Check in</Button> : !att.check_out_at ? <Button variant="outline" onClick={() => mark('check_out')}><LogOut />Check out</Button> : <Badge tone="green">Day complete</Badge>}</div>
      <section><h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Today</h2>
        <div className="space-y-3">{data.today.length ? data.today.map((j: any) => <JobCard key={j.id} j={j} />) : <Card><EmptyState title="No jobs today" description="New assignments appear here automatically." /></Card>}</div></section>
      {data.upcoming.length > 0 && <section><h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Upcoming</h2><div className="space-y-3">{data.upcoming.map((j: any) => <JobCard key={j.id} j={j} />)}</div></section>}
    </div>
  );
}

function SignaturePad({ onSave, busy }: { onSave: (dataUrl: string) => void; busy?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = ref.current!; const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio; c.height = c.offsetHeight * ratio;
    const ctx = c.getContext('2d')!; ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0b1f44';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  }, []);
  const pt = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  return (
    <div>
      <canvas ref={ref} className="h-44 w-full touch-none rounded-lg border-2 border-dashed border-slate-300 bg-white" aria-label="Signature area"
        onPointerDown={(e) => { drawing.current = true; const ctx = ref.current!.getContext('2d')!; const [x, y] = pt(e); ctx.beginPath(); ctx.moveTo(x, y); ref.current!.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!drawing.current) return; const ctx = ref.current!.getContext('2d')!; const [x, y] = pt(e); ctx.lineTo(x, y); ctx.stroke(); setEmpty(false); }}
        onPointerUp={() => { drawing.current = false; }} />
      <div className="mt-2 flex justify-between"><Button size="sm" variant="ghost" onClick={() => { const c = ref.current!; const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); setEmpty(true); }}>Clear</Button>
        <Button size="sm" disabled={empty} loading={busy} onClick={() => onSave(ref.current!.toDataURL('image/png'))}>Save signature</Button></div>
    </div>
  );
}

function JobDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: w, isLoading, error, refetch } = useOfflineData<any>(['tech-job', id], `/app/work-orders/${id}`);
  const outbox = useOutbox();
  const pendingPhotos = outbox?.items.filter((i) => i.jobId === id && i.kind === 'photo' && i.status === 'pending').reduce((n, i) => n + (i.form?.files.length ?? 0), 0) ?? 0;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [part, setPart] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [sign, setSign] = useState(false);
  const [signName, setSignName] = useState('');
  const [photoCat, setPhotoCat] = useState('photo_before');
  const fileRef = useRef<HTMLInputElement>(null);
  const pv = useFilePreview();
  useEffect(() => { if (w) setReport(w.report ?? { reported_issue: w.description }); }, [w?.id, w?.report?.updated_at]); // eslint-disable-line
  const refresh = () => { qc.invalidateQueries({ queryKey: ['tech-job', id] }); qc.invalidateQueries({ queryKey: ['tech-dash'] }); };
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  /** Sends a job action now, or saves it on the device (with an optimistic update) to sync later. */
  const job = async (kind: string, label: string, method: 'POST' | 'PUT' | 'DELETE', path: string, json: unknown, local: (w: any) => any, success?: string, after?: () => void) => {
    setBusy(true);
    try {
      const queued = await act({ kind, label: `${label} · ${w.number}`, jobId: w.id, method, path, json }, { success, onQueued: () => patchJob(qc, w.id, local) });
      if (!queued) refresh();
      after?.();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const wpath = `/app/work-orders/${w.id}`;
  const status = async (s: string) => {
    let reason: string | undefined;
    if (s === 'on_hold') { const r = await confirm({ title: 'Put job on hold?', requireReason: true, reasonLabel: 'Why?', confirmLabel: 'Put on hold' }); if (!r) return; reason = r.reason; }
    if (s === 'completed' && !(await confirm({ title: 'Complete this job?', description: 'Make sure the service report is saved and photos are uploaded.', confirmLabel: 'Complete job' }))) return;
    // occurredAt keeps the real start/finish time when this is synced later.
    await job('status', titleCase(s), 'POST', `${wpath}/status`, { status: s, reason, occurredAt: new Date().toISOString() },
      (x) => ({ ...localStatus(x, s), hold_reason: s === 'on_hold' ? reason : x.hold_reason }), `Status: ${titleCase(s)}`);
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    setBusy(true);
    try {
      const queued = await act({ kind: 'photo', label: `${list.length} photo(s) · ${w.number}`, jobId: w.id, method: 'POST', path: '/app/documents',
        form: { fields: { entityType: 'work_order', entityId: w.id, category: photoCat, visibility: 'customer' }, files: list.map((f) => ({ name: f.name, type: f.type, blob: f })) } },
        { success: list.length > 1 ? 'Photos uploaded' : 'Photo uploaded' });
      if (!queued) refresh();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const closed = ['completed', 'invoiced', 'paid', 'cancelled'].includes(w.status);
  const a = w.address;
  const actions: { s: string; label: string; icon: any; variant?: any }[] = [];
  if (w.allowedTransitions.includes('en_route')) actions.push({ s: 'en_route', label: 'On my way', icon: Truck });
  if (w.allowedTransitions.includes('in_progress')) actions.push({ s: 'in_progress', label: w.status === 'on_hold' ? 'Resume work' : 'Start work', icon: Play });
  if (w.allowedTransitions.includes('completed')) actions.push({ s: 'completed', label: 'Complete job', icon: CheckCircle2 });
  return (
    <div className="space-y-4 pb-6">
      <button onClick={() => nav('/tech')} className="text-sm text-slate-500">← Back</button>
      <div><p className="text-xs font-semibold text-slate-500">{w.number} · {w.category_name ?? 'Service'}</p><h1 className="text-xl font-semibold text-navy-900">{w.title}</h1>
        <div className="mt-1 flex gap-2"><StatusBadge status={w.status} /><PriorityBadge p={w.priority} /></div></div>
      {w.status === 'assigned' && !w.accepted_at && <Alert tone="blue" title="New assignment" action={<Button size="sm" loading={busy} onClick={() => job('accept', 'Accept job', 'POST', `${wpath}/accept`, {}, (x) => ({ ...x, accepted_at: new Date().toISOString(), _pending: true }), 'Job accepted')}>Accept job</Button>}>{dateTime(w.scheduled_start)}</Alert>}
      {w.status === 'on_hold' && <Alert tone="amber" title="On hold">{w.hold_reason}</Alert>}
      {!closed && actions.length > 0 && <div className="grid gap-2">{actions.map((x) => <Button key={x.s} size="lg" className="h-14 text-base" loading={busy} onClick={() => status(x.s)}><x.icon className="!size-5" />{x.label}</Button>)}
        {w.allowedTransitions.includes('on_hold') && <Button size="lg" variant="outline" onClick={() => status('on_hold')}><Pause />Pause / on hold</Button>}</div>}
      <Card><CardBody className="space-y-3 text-sm">
        <p className="text-base font-semibold text-navy-900">{w.customer_name}</p>
        <div className="grid grid-cols-2 gap-2">
          {w.customer_phone && <a href={`tel:${w.customer_phone}`}><Button variant="outline" className="w-full"><Phone />Call</Button></a>}
          {w.mapUrl && <a href={w.mapUrl} target="_blank" rel="noreferrer"><Button variant="outline" className="w-full"><Navigation />Navigate</Button></a>}
        </div>
        {a && <p className="flex gap-2 text-slate-700"><MapPin className="mt-0.5 h-4 w-4 shrink-0" />{[a.line1, a.line2, a.city, a.postal_code].filter(Boolean).join(', ')}</p>}
        {a?.access_notes && <p className="rounded-lg bg-amber-50 p-2 text-amber-900">{a.access_notes}</p>}
        <p className="flex gap-2"><Clock className="mt-0.5 h-4 w-4" />{dateTime(w.scheduled_start)} · {w.expected_duration_minutes} min</p>
        {w.asset && <p className="rounded-lg bg-slate-50 p-2">Equipment: <b>{w.asset.name}</b> {[w.asset.manufacturer, w.asset.model].filter(Boolean).join(' ')} · S/N {w.asset.serial_number ?? '—'}</p>}
        {w.description && <p className="whitespace-pre-line text-slate-700">{w.description}</p>}
        {w.customer_notes && <p className="text-slate-600">Customer notes: {w.customer_notes}</p>}
      </CardBody></Card>
      <Card><CardHeader title="Photos" description="Before and after photos are shared with the customer" actions={!closed && <div className="flex gap-1">
        <select aria-label="Photo type" value={photoCat} onChange={(e) => setPhotoCat(e.target.value)} className="input h-8 w-28 py-1 text-xs"><option value="photo_before">Before</option><option value="photo_after">After</option><option value="service_photo">Other</option></select>
        <Button size="sm" onClick={() => fileRef.current?.click()}><Camera />Add</Button></div>} />
        <input ref={fileRef} hidden type="file" accept="image/*" capture="environment" multiple onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        <CardBody>{w.documents.filter((d: any) => d.mime_type.startsWith('image/')).length ? <div className="grid grid-cols-3 gap-2">{w.documents.filter((d: any) => d.mime_type.startsWith('image/')).map((d: any) => (
          <button key={d.id} onClick={() => pv.open(d)} className="rounded-lg border border-slate-200 p-2 text-left text-xs"><Camera className="mb-1 h-4 w-4 text-slate-400" /><span className="line-clamp-2">{titleCase(d.category)}</span></button>))}</div>
          : <p className="text-sm text-slate-500">No photos yet</p>}
          {pendingPhotos > 0 && <p className="mt-2 text-xs font-medium text-amber-700">{pendingPhotos} photo(s) saved on this phone, waiting to upload</p>}</CardBody></Card>
      <Card><CardHeader title="Parts used" actions={!closed && <Button size="sm" variant="outline" onClick={() => setPart({ itemId: '', description: '', quantity: 1 })}><Plus />Add</Button>} />
        <ul className="divide-y divide-slate-100 text-sm">{w.parts.length ? w.parts.map((p: any) => <li key={p.id} className="flex items-center justify-between px-5 py-2.5"><span>{p.description} × {Number(p.quantity)}</span>
          {!closed && <Button size="icon-sm" variant="ghost" aria-label="Remove" disabled={String(p.id).startsWith('pending')} onClick={() => job('part_remove', `Remove ${p.description}`, 'DELETE', `${wpath}/parts/${p.id}`, undefined, (x) => ({ ...x, parts: x.parts.filter((y: any) => y.id !== p.id) }), 'Part removed')}><X /></Button>}</li>) : <li className="px-5 py-3 text-slate-500">None recorded</li>}</ul></Card>
      {report && <ReportEditor w={w} report={report} setReport={setReport} onSaved={refresh} compact
        saveReport={(body) => act({ kind: 'report', label: `Service report · ${w.number}`, jobId: w.id, method: 'PUT', path: `${wpath}/report`, json: body },
          { onQueued: () => patchJob(qc, w.id, (x) => ({ ...x, report: { ...(x.report ?? {}), reported_issue: body.reportedIssue, findings: body.findings, work_performed: body.workPerformed,
            recommendations: body.recommendations, equipment_condition: body.equipmentCondition, technician_notes: body.technicianNotes, updated_at: new Date().toISOString() } })) })} />}
      {w.report?.work_performed && !w.report.customer_approved_at && !['cancelled'].includes(w.status) && <Card><CardHeader title="Customer sign-off" description="Ask the customer to review the work and sign" />
        <CardBody>{sign ? <div className="space-y-3"><Field label="Customer name"><Input value={signName} onChange={(e) => setSignName(e.target.value)} /></Field>
          <SignaturePad busy={busy} onSave={(sig) => signName.trim().length < 2 ? toast.error('Enter the customer name') : job('signature', 'Customer signature', 'POST', `${wpath}/signature`, { signedName: signName, signature: sig, approved: true },
            (x) => ({ ...x, report: { ...(x.report ?? {}), customer_approved_at: new Date().toISOString(), customer_signed_name: signName } }), 'Signature saved', () => setSign(false))} /></div>
          : <Button variant="outline" className="w-full" onClick={() => { setSignName(w.customer_name); setSign(true); }}>Capture customer signature</Button>}</CardBody></Card>}
      {w.report?.customer_approved_at && <Alert tone="green">Signed by {w.report.customer_signed_name} · {dateTime(w.report.customer_approved_at)}</Alert>}
      <Card><CardHeader title="Notes" /><ul className="divide-y divide-slate-100 text-sm">{w.notes.map((n: any) => <li key={n.id} className="px-5 py-2.5"><p className="text-xs text-slate-500">{n.author_name} · {dateTime(n.created_at)}</p><p>{n.body}</p></li>)}</ul>
        {!closed && <div className="flex gap-2 border-t border-slate-100 p-3"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a work note…" />
          <Button disabled={!note.trim()} onClick={() => job('note', 'Work note', 'POST', `${wpath}/notes`, { body: note },
            (x) => ({ ...x, notes: [...x.notes, { id: `pending-${Date.now()}`, body: note, author_name: 'You · waiting to sync', created_at: new Date().toISOString() }] }), undefined, () => setNote(''))}>Add</Button></div>}</Card>
      <PartDialog part={part} setPart={setPart} hidePrice onSave={(p) => job('part', `Part: ${p.description || 'item'}`, 'POST', `${wpath}/parts`, p,
        (x) => ({ ...x, parts: [...x.parts, { id: `pending-${Date.now()}`, description: p.description || 'Part (waiting to sync)', quantity: p.quantity }] }), 'Part recorded', () => setPart(null))} />
      {pv.node}
    </div>
  );
}

function History() {
  const { data, isLoading } = useOfflineData<any[]>(['tech-history'], '/app/technicians/me/history');
  if (isLoading) return <PageLoader />;
  return (<div><h1 className="mb-4 text-xl font-semibold text-navy-900">Job history</h1><Card><ul className="divide-y divide-slate-100">{data?.length ? data.map((j) => (
    <li key={j.id}><Link to={`/tech/jobs/${j.id}`} className="flex items-center justify-between px-4 py-3 text-sm"><span><span className="font-medium">{j.number}</span> · {j.customer_name}<span className="block text-xs text-slate-500">{dateTime(j.actual_end)}</span></span><StatusBadge status={j.status} /></Link></li>))
    : <EmptyState title="No completed jobs yet" />}</ul></Card></div>);
}

export default function Tech() {
  return (
    <><OfflineBar /><Routes>
      <Route index element={<Today />} />
      <Route path="jobs/:id" element={<JobDetail />} />
      <Route path="calendar" element={<div><h1 className="mb-4 text-xl font-semibold text-navy-900">My schedule</h1><CalendarView base="/tech/jobs" techMode /></div>} />
      <Route path="history" element={<History />} />
      <Route path="profile" element={<Profile />} />
    </Routes></>
  );
}
export { cn };
