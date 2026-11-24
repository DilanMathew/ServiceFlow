import { useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Mail, Pencil, Phone, Plus, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { del, patch, post, put } from '@/lib/api';
import { useData } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { date, dateTime, localToIso } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, DescriptionList, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, SearchInput, Select, StatCard, StatusBadge, Tabs } from '@/components/ui';
import { FormDialog, toastError } from '@/components/form';
import { BackLink, DocumentsPanel, useSettingsLists } from './shared';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function TechList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: s } = useSettingsLists();
  const [f, setF] = useState({ q: '', categoryId: '', status: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as any).toString();
  const { data, isLoading, error, refetch } = useData<any[]>(['technicians', qs], `/app/technicians?${qs}`);
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  return (
    <div>
      <PageHeader title="Technicians" description="Skills, service areas, availability and workload." actions={can('technicians.manage') && <Button onClick={() => setOpen(true)}><Plus />Add technician</Button>} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <SearchInput className="w-full sm:w-64" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Name or employee ID…" />
          <Select aria-label="Skill" className="w-48" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} placeholder="Any skill" options={(s?.serviceCategories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          <Select aria-label="Status" className="w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} placeholder="Any status" options={['active', 'on_leave', 'inactive', 'terminated'].map((v) => ({ value: v, label: titleCase(v) }))} />
        </div>
        <DataTable rows={data} loading={isLoading} error={error} onRetry={refetch} onRowClick={(r: any) => nav(`/app/technicians/${r.id}`)} empty={<EmptyState icon={Wrench} title="No technicians yet" description="Add technicians to start assigning jobs." />}
          columns={[
            { key: 'n', header: 'Technician', cell: (r: any) => <div><p className="font-medium">{r.full_name} {r.invitation_pending && <Badge tone="amber">Invite pending</Badge>}</p><p className="text-xs text-slate-500">{r.employee_id ?? r.email}</p></div> },
            { key: 's', header: 'Skills', hideOnMobile: true, cell: (r: any) => <div className="flex max-w-xs flex-wrap gap-1">{r.skills.slice(0, 3).map((x: any) => <Badge key={x.id}>{x.name}</Badge>)}{r.skills.length > 3 && <Badge>+{r.skills.length - 3}</Badge>}</div> },
            { key: 'a', header: 'Areas', hideOnMobile: true, cell: (r: any) => r.areas.map((x: any) => x.name).join(', ') || '—' },
            { key: 'today', header: 'Today', className: 'text-right', cell: (r: any) => <span className={cn('tabular', r.jobs_on_date >= r.max_jobs_per_day && 'font-semibold text-red-600')}>{r.jobs_on_date}/{r.max_jobs_per_day}</span> },
            { key: 'open', header: 'Open jobs', className: 'text-right', cell: (r: any) => r.open_jobs },
            { key: 'done', header: '30-day done', className: 'text-right', hideOnMobile: true, cell: (r: any) => r.completed_30d },
            { key: 'rating', header: 'Rating', hideOnMobile: true, cell: (r: any) => r.avg_rating ? `${r.avg_rating} ★` : '—' },
            { key: 'st', header: 'Status', cell: (r: any) => <StatusBadge status={r.is_active ? r.employment_status : 'inactive'} /> },
          ]} />
      </Card>
      <FormDialog open={open} onOpenChange={setOpen} title="Add technician" description="They receive an email invitation to set a password and use the mobile portal." size="lg"
        fields={[{ name: 'fullName', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'phone', label: 'Phone', type: 'tel' },
          { name: 'employeeId', label: 'Employee ID' }, { name: 'employmentType', label: 'Employment', type: 'select', options: [{ value: 'full_time', label: 'Full time' }, { value: 'part_time', label: 'Part time' }, { value: 'contractor', label: 'Contractor' }] },
          { name: 'maxJobsPerDay', label: 'Max jobs per day', type: 'number', min: 1, max: 30 }, { name: 'hourlyCost', label: 'Hourly cost (internal)', type: 'money', hint: 'Used for profitability estimates' }]}
        defaultValues={{ employmentType: 'full_time', maxJobsPerDay: 6 }} onSubmit={async (v) => { const r = await post('/app/technicians', v); qc.invalidateQueries({ queryKey: ['technicians'] }); nav(`/app/technicians/${r.data.id}`); }}
        successMessage="Technician added and invited" />
    </div>
  );
}

function TechDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data: s } = useSettingsLists();
  const { data: t, isLoading, error, refetch } = useData<any>(['technician', id], `/app/technicians/${id}`);
  const [tab, setTab] = useState('schedule');
  const [edit, setEdit] = useState(false);
  const [skills, setSkills] = useState<Record<string, number>>({});
  const [areas, setAreas] = useState<string[]>([]);
  const [slots, setSlots] = useState<{ weekday: number; startTime: string; endTime: string }[]>([]);
  const [leave, setLeave] = useState<any>(null);
  useEffect(() => { if (t) { setSkills(Object.fromEntries(t.skills.map((x: any) => [x.service_category_id, x.proficiency]))); setAreas(t.areas.map((a: any) => a.id));
    setSlots(t.availability.map((a: any) => ({ weekday: a.weekday, startTime: a.start_time.slice(0, 5), endTime: a.end_time.slice(0, 5) }))); } }, [t]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['technician', id] });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const manage = can('technicians.manage');
  const save = (p: Promise<any>, msg: string) => p.then(() => { toast.success(msg); refresh(); }).catch(toastError);
  return (
    <div>
      <PageHeader back={<BackLink to="/app/technicians" label="Technicians" />} title={<span className="flex items-center gap-3">{t.full_name}<StatusBadge status={t.employment_status} /></span>}
        description={<span className="flex flex-wrap gap-4">{t.employee_id && <span>{t.employee_id}</span>}{t.phone && <a className="inline-flex items-center gap-1 text-brand-700" href={`tel:${t.phone}`}><Phone className="h-3.5 w-3.5" />{t.phone}</a>}<span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{t.email}</span></span>}
        actions={manage && <><Button variant="outline" onClick={() => setLeave({ start: '', end: '', reason: '' })}><CalendarOff />Add leave</Button><Button variant="outline" onClick={() => setEdit(true)}><Pencil />Edit</Button></>} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard label="Completed (all time)" value={t.stats.completed} /><StatCard label="Last 30 days" value={t.stats.completed_30d} tone="green" />
        <StatCard label="Avg time on job" value={t.stats.avg_job_minutes ? `${t.stats.avg_job_minutes} min` : '—'} tone="violet" />
        <StatCard label="On-time arrival" value={t.stats.on_time_pct != null ? `${t.stats.on_time_pct}%` : '—'} tone="amber" /><StatCard label="Rating" value={t.stats.avg_rating ? `${t.stats.avg_rating} ★` : '—'} tone="navy" />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'schedule', label: 'Schedule', count: t.upcoming.length }, { value: 'skills', label: 'Skills & areas' }, { value: 'availability', label: 'Availability & leave' },
        { value: 'history', label: 'Completed jobs' }, { value: 'attendance', label: 'Attendance' }, { value: 'documents', label: 'Documents' }]} />
      <div className="mt-5">
        {tab === 'schedule' && <Card><DataTable rows={t.upcoming} onRowClick={(r: any) => nav(`/app/work-orders/${r.id}`)} empty={<EmptyState title="No open jobs" />} columns={[
          { key: 'n', header: 'Job', cell: (r: any) => <div><p className="font-medium">{r.number}</p><p className="text-xs text-slate-500">{r.title}</p></div> }, { key: 'c', header: 'Customer', cell: (r: any) => `${r.customer_name}${r.city ? ` · ${r.city}` : ''}` },
          { key: 's', header: 'Scheduled', cell: (r: any) => dateTime(r.scheduled_start) }, { key: 'st', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>}
        {tab === 'skills' && <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="Skills" description="Proficiency 1 (basic) – 5 (expert)" actions={manage && <Button size="sm" onClick={() => save(put(`/app/technicians/${t.id}/skills`, { skills: Object.entries(skills).map(([serviceCategoryId, proficiency]) => ({ serviceCategoryId, proficiency })) }), 'Skills saved')}>Save</Button>} />
            <CardBody className="space-y-2">{(s?.serviceCategories ?? []).map((c: any) => (
              <div key={c.id} className="flex items-center justify-between gap-3"><Checkbox label={c.name} disabled={!manage} checked={c.id in skills} onChange={(e) => { const n = { ...skills }; e.target.checked ? (n[c.id] = 3) : delete n[c.id]; setSkills(n); }} />
                {c.id in skills && <Select aria-label="Proficiency" className="h-8 w-20 py-1" disabled={!manage} value={skills[c.id]} onChange={(e) => setSkills({ ...skills, [c.id]: Number(e.target.value) })} options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} />}</div>))}</CardBody></Card>
          <Card><CardHeader title="Service areas" actions={manage && <Button size="sm" onClick={() => save(put(`/app/technicians/${t.id}/areas`, { serviceAreaIds: areas }), 'Areas saved')}>Save</Button>} />
            <CardBody className="space-y-2">{(s?.serviceAreas ?? []).length ? s.serviceAreas.map((a: any) => <Checkbox key={a.id} disabled={!manage} label={a.name} hint={a.postal_codes.join(', ')} checked={areas.includes(a.id)}
              onChange={(e) => setAreas(e.target.checked ? [...areas, a.id] : areas.filter((x) => x !== a.id))} />) : <EmptyState title="No service areas" description="Define areas in Settings." />}</CardBody></Card>
        </div>}
        {tab === 'availability' && <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="Weekly working hours" actions={manage && <Button size="sm" onClick={() => save(put(`/app/technicians/${t.id}/availability`, { slots }), 'Availability saved')}>Save</Button>} />
            <CardBody className="space-y-2">{DAYS.map((d, i) => { const slot = slots.find((x) => x.weekday === i + 1); return (
              <div key={d} className="flex items-center gap-3"><Checkbox label={d} className="w-16" disabled={!manage} checked={!!slot} onChange={(e) => setSlots(e.target.checked ? [...slots, { weekday: i + 1, startTime: '09:00', endTime: '18:00' }] : slots.filter((x) => x.weekday !== i + 1))} />
                {slot && <><Input type="time" className="h-8 w-28" disabled={!manage} value={slot.startTime} onChange={(e) => setSlots(slots.map((x) => (x.weekday === i + 1 ? { ...x, startTime: e.target.value } : x)))} />–
                  <Input type="time" className="h-8 w-28" disabled={!manage} value={slot.endTime} onChange={(e) => setSlots(slots.map((x) => (x.weekday === i + 1 ? { ...x, endTime: e.target.value } : x)))} /></>}</div>); })}</CardBody></Card>
          <Card><CardHeader title="Leave & time off" /><ul className="divide-y divide-slate-100">{t.timeOff.length ? t.timeOff.map((o: any) => (
            <li key={o.id} className="flex items-center justify-between px-5 py-3 text-sm"><span>{dateTime(o.starts_at)} → {dateTime(o.ends_at)}<span className="block text-xs text-slate-500">{o.reason}</span></span>
              {manage && <Button size="sm" variant="ghost" onClick={() => save(del(`/app/technicians/${t.id}/time-off/${o.id}`), 'Removed')}>Remove</Button>}</li>)) : <EmptyState title="No leave scheduled" />}</ul></Card>
        </div>}
        {tab === 'history' && <Card><DataTable rows={t.recent} onRowClick={(r: any) => nav(`/app/work-orders/${r.id}`)} empty={<EmptyState title="No completed jobs yet" />} columns={[
          { key: 'n', header: 'Job', cell: (r: any) => r.number }, { key: 'c', header: 'Customer', cell: (r: any) => r.customer_name }, { key: 'd', header: 'Completed', cell: (r: any) => dateTime(r.actual_end) },
          { key: 'dur', header: 'Duration', cell: (r: any) => r.actual_start && r.actual_end ? `${Math.round((new Date(r.actual_end).getTime() - new Date(r.actual_start).getTime()) / 60000)} min` : '—' },
          { key: 'r', header: 'Rating', cell: (r: any) => r.technician_rating ? `${r.technician_rating} ★` : '—' }]} /></Card>}
        {tab === 'attendance' && <Card><DataTable rows={t.attendance} empty={<EmptyState title="No attendance records" description="Technicians check in from the mobile portal." />} columns={[
          { key: 'd', header: 'Date', cell: (r: any) => date(r.work_date) }, { key: 'i', header: 'Check in', cell: (r: any) => dateTime(r.check_in_at) }, { key: 'o', header: 'Check out', cell: (r: any) => dateTime(r.check_out_at) }, { key: 'n', header: 'Notes', cell: (r: any) => r.notes ?? '' }]} /></Card>}
        {tab === 'documents' && <DocumentsPanel entityType="technician" entityId={t.id} title="Certificates & documents" />}
      </div>
      <FormDialog open={edit} onOpenChange={setEdit} title="Edit technician" fields={[{ name: 'employeeId', label: 'Employee ID' },
        { name: 'employmentStatus', label: 'Status', type: 'select', options: ['active', 'on_leave', 'inactive', 'terminated'].map((v) => ({ value: v, label: titleCase(v) })) },
        { name: 'employmentType', label: 'Employment', type: 'select', options: [{ value: 'full_time', label: 'Full time' }, { value: 'part_time', label: 'Part time' }, { value: 'contractor', label: 'Contractor' }] },
        { name: 'maxJobsPerDay', label: 'Max jobs per day', type: 'number', min: 1, max: 30 }, { name: 'hourlyCost', label: 'Hourly cost', type: 'money' },
        { name: 'homeLatitude', label: 'Base latitude', type: 'number', step: 'any' }, { name: 'homeLongitude', label: 'Base longitude', type: 'number', step: 'any' }, { name: 'bio', label: 'Notes', type: 'textarea' }]}
        defaultValues={{ employeeId: t.employee_id ?? '', employmentStatus: t.employment_status, employmentType: t.employment_type, maxJobsPerDay: t.max_jobs_per_day, hourlyCost: t.hourly_cost ?? '', homeLatitude: t.home_latitude ?? '', homeLongitude: t.home_longitude ?? '', bio: t.bio ?? '' }}
        onSubmit={async (v) => { await patch(`/app/technicians/${t.id}`, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null && ['employmentStatus', 'employmentType', 'maxJobsPerDay'].includes(k) ? undefined : x]))); refresh(); }} successMessage="Technician updated" />
      <Dialog open={!!leave} onOpenChange={(o) => !o && setLeave(null)} title="Add leave" footer={<Button onClick={() => post(`/app/technicians/${t.id}/time-off`, { startsAt: localToIso(leave.start), endsAt: localToIso(leave.end), reason: leave.reason || null })
        .then((r) => { setLeave(null); refresh(); r.data.conflictingJobs.length ? toast.warning(`Leave saved. Reassign: ${r.data.conflictingJobs.join(', ')}`) : toast.success('Leave saved'); }).catch(toastError)}>Save</Button>}>
        {leave && <div className="grid gap-3 sm:grid-cols-2"><Field label="From"><Input type="datetime-local" value={leave.start} onChange={(e) => setLeave({ ...leave, start: e.target.value })} /></Field>
          <Field label="To"><Input type="datetime-local" value={leave.end} onChange={(e) => setLeave({ ...leave, end: e.target.value })} /></Field>
          <Field label="Reason" className="sm:col-span-2"><Input value={leave.reason} onChange={(e) => setLeave({ ...leave, reason: e.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}
export default function Technicians() { return <Routes><Route index element={<TechList />} /><Route path=":id" element={<TechDetail />} /></Routes>; }
