import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, CalendarClock, Download, FileSignature, MessageSquare, Plus, Receipt, ScrollText, Send, Star, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { api, openFile, patch, post } from '@/lib/api';
import { useData } from '@/lib/hooks';
import { date, dateTime, money } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Select, StatCard, StatusBadge, Tabs, Textarea } from '@/components/ui';
import { toastError } from '@/components/form';
import { Timeline } from '../app/shared';
import { statusLabel, t, tn } from '@/lib/i18n';

function useMe() { return useData<any>(['portal-me'], '/portal/me'); }

function Home() {
  const nav = useNavigate();
  const { data, isLoading, error, refetch } = useMe();
  const { data: jobs } = useData<any[]>(['portal-jobs'], '/portal/jobs');
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const s = data.summary;
  const upcoming = (jobs ?? []).filter((j) => ['scheduled', 'assigned', 'en_route', 'in_progress', 'approved', 'new'].includes(j.status));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold text-navy-900">{t('Welcome, {name}', { name: data.customer.full_name.split(' ')[0] })}</h1><p className="text-sm text-slate-500">{data.business.name}{data.business.phone ? ` · ${data.business.phone}` : ''}</p></div>
        <Button onClick={() => nav('/portal/requests/new')}><Plus />{t('Request service')}</Button></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><StatCard label={t('Open visits')} value={s.open_jobs} icon={Wrench} onClick={() => nav('/portal/jobs')} />
        <StatCard label={t('Quotes to review')} value={s.pending_quotes} icon={FileSignature} tone="violet" onClick={() => nav('/portal/billing?tab=quotes')} />
        <StatCard label={t('Balance due')} value={money(s.balance_due, data.business.currency)} icon={Receipt} tone={Number(s.balance_due) > 0 ? 'red' : 'green'} onClick={() => nav('/portal/billing')} />
        <StatCard label={t('Maintenance plans')} value={s.active_contracts} icon={ScrollText} tone="green" onClick={() => nav('/portal/contracts')} /></div>
      <Card><CardHeader title={t('Upcoming & open visits')} /><ul className="divide-y divide-slate-100">{upcoming.length ? upcoming.map((j) => (
        <li key={j.id}><Link to={`/portal/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50"><span className="min-w-0 text-sm"><span className="font-medium">{j.title}</span>
          <span className="block text-xs text-slate-500">{j.scheduled_start ? dateTime(j.scheduled_start) : t('Scheduling in progress')}{j.technician_name ? ` · ${j.technician_name}` : ''}</span></span><StatusBadge status={j.status} /></Link></li>))
        : <EmptyState icon={CalendarClock} title={t('No upcoming visits')} action={<Button size="sm" onClick={() => nav('/portal/requests/new')}>{t('Request service')}</Button>} />}</ul></Card>
      {data.aiAssistant && <Assistant />}
      <div className="grid gap-3 sm:grid-cols-3">{[['/portal/assets', t('My equipment'), Wrench], ['/portal/contracts', t('Maintenance plans'), ScrollText], ['/portal/support', t('Contact us'), MessageSquare]].map(([to, label, I]: any) => (
        <Link key={to} to={to} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm font-medium text-navy-900 hover:border-brand-300"><I className="h-5 w-5 text-brand-600" />{label}</Link>))}</div>
    </div>
  );
}

function Assistant() {
  const nav = useNavigate();
  const [msgs, setMsgs] = useState<{ role: 'user' | 'bot'; text: string; action?: any }[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<any>(null);
  const [reason, setReason] = useState('');
  const ask = async () => {
    if (!q.trim()) return;
    const text = q; setQ(''); setMsgs((m) => [...m, { role: 'user', text }]); setBusy(true);
    try { const r = await post('/portal/assistant', { message: text }); setMsgs((m) => [...m, { role: 'bot', text: r.data.answer, action: r.data.proposedAction }]); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const run = async () => {
    const a = confirmAction;
    try {
      if (a.type === 'pay_invoice') { const r = await post(`/portal/invoices/${a.id}/pay`); window.location.href = r.data.checkoutUrl; return; }
      await post(`/portal/jobs/${a.id}/change-request`, { type: a.type === 'request_cancellation' ? 'cancel' : 'reschedule', reason: reason || t('Requested via assistant'), confirmed: true });
      toast.success(t('Request sent to the business')); setConfirmAction(null); setReason('');
    } catch (e) { toastError(e); }
  };
  return (
    <Card><CardHeader title={t('Ask the assistant')} description={t('Answers come only from your own visits, invoices and plans. Nothing happens without your confirmation.')} actions={<Bot className="h-5 w-5 text-violet-600" />} />
      <CardBody className="space-y-3">
        {msgs.map((m, i) => <div key={i} className={cn('max-w-[85%] rounded-xl px-3 py-2 text-sm', m.role === 'user' ? 'ml-auto bg-brand-600 text-white' : 'bg-slate-100 text-slate-800')}>{m.text}
          {m.action && <Button size="sm" variant="outline" className="mt-2 bg-white" onClick={() => setConfirmAction(m.action)}>{m.action.label}</Button>}</div>)}
        <div className="flex gap-2"><Input placeholder={t('e.g. When is my technician coming? Do I owe anything?')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
          <Button loading={busy} onClick={ask} aria-label={t('Send')}><Send /></Button></div>
      </CardBody>
      <Dialog open={!!confirmAction} onOpenChange={(o) => !o && setConfirmAction(null)} title={t('Please confirm')} description={confirmAction?.label}
        footer={<><Button variant="outline" onClick={() => setConfirmAction(null)}>{t('Cancel')}</Button><Button onClick={run}>{t('Confirm')}</Button></>}>
        {confirmAction && confirmAction.type !== 'pay_invoice' && <Field label={t('Reason')}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        {confirmAction?.type === 'pay_invoice' && <p className="text-sm text-slate-600">{t('You\'ll be taken to the secure payment page.')}</p>}
      </Dialog>
    </Card>
  );
}

function NewRequest() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: assets } = useData<any[]>(['portal-assets'], '/portal/assets');
  const [v, setV] = useState({ description: '', serviceCategoryId: '', addressId: '', assetId: '', preferredDate: '', preferredTimeSlot: 'any', priority: 'normal' });
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: any) => setV({ ...v, [k]: e.target.value }) });
  const submit = async () => {
    setBusy(true);
    try { const fd = new FormData(); Object.entries(v).forEach(([k, x]) => x && fd.append(k, x)); Array.from(files ?? []).slice(0, 5).forEach((fl) => fd.append('photos', fl));
      const r = await api('/portal/requests', { method: 'POST', body: fd }); toast.success(t('Request {number} sent', { number: r.data.number })); qc.invalidateQueries({ queryKey: ['portal-requests'] }); nav('/portal/requests'); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-xl"><PageHeader title={t('Request a service')} />
      <Card><CardBody className="space-y-4">
        <Field label={t('What do you need help with?')} required><Textarea rows={4} {...f('description')} placeholder={t('Describe the problem')} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Service')}><Select {...f('serviceCategoryId')} placeholder={t('Not sure')} options={(me?.categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
          <Field label={t('Equipment')}><Select {...f('assetId')} placeholder="—" options={(assets ?? []).map((a) => ({ value: a.id, label: a.name }))} /></Field>
          <Field label={t('Address')}><Select {...f('addressId')} placeholder={t('Default')} options={(me?.addresses ?? []).map((a: any) => ({ value: a.id, label: `${a.label}: ${a.line1}` }))} /></Field>
          <Field label={t('Urgency')}><Select {...f('priority')} options={[{ value: 'normal', label: t('Normal') }, { value: 'high', label: t('Not working') }, { value: 'urgent', label: t('Emergency / safety risk') }]} /></Field>
          <Field label={t('Preferred date')}><Input type="date" {...f('preferredDate')} /></Field>
          <Field label={t('Preferred time')}><Select {...f('preferredTimeSlot')} options={['any', 'morning', 'afternoon', 'evening'].map((x) => ({ value: x, label: titleCase(x) }))} /></Field>
        </div>
        <Field label={t('Photos (optional)')}><input type="file" accept="image/*" capture="environment" multiple className="text-sm" onChange={(e) => setFiles(e.target.files)} /></Field>
        <Button className="w-full" size="lg" loading={busy} disabled={v.description.trim().length < 10} onClick={submit}>{t('Send request')}</Button>
      </CardBody></Card></div>
  );
}

function Requests() {
  const nav = useNavigate();
  const { data, isLoading } = useData<any[]>(['portal-requests'], '/portal/requests');
  return (<div><PageHeader title={t('My requests')} actions={<Button onClick={() => nav('/portal/requests/new')}><Plus />{t('New request')}</Button>} />
    <Card><DataTable rows={data} loading={isLoading} onRowClick={(r: any) => r.work_order_id && nav(`/portal/jobs/${r.work_order_id}`)} empty={<EmptyState title={t('No requests yet')} />} columns={[
      { key: 'n', header: t('Request'), cell: (r: any) => <div><p className="font-medium">{r.number}</p><p className="max-w-xs truncate text-xs text-slate-500">{r.description}</p></div> },
      { key: 'd', header: t('Sent'), cell: (r: any) => date(r.created_at) }, { key: 's', header: t('Status'), cell: (r: any) => <div><StatusBadge status={r.status} />{r.rejection_reason && <p className="text-xs text-slate-500">{r.rejection_reason}</p>}</div> }]} /></Card></div>);
}

function Jobs() {
  const nav = useNavigate();
  const { data, isLoading } = useData<any[]>(['portal-jobs'], '/portal/jobs');
  return (<div><PageHeader title={t('Service visits')} /><Card><DataTable rows={data} loading={isLoading} onRowClick={(r: any) => nav(`/portal/jobs/${r.id}`)} empty={<EmptyState title={t('No visits yet')} />} columns={[
    { key: 't', header: t('Visit'), cell: (r: any) => <div><p className="font-medium">{r.title}</p><p className="text-xs text-slate-500">{r.number} · {r.category_name ?? ''}</p></div> },
    { key: 'd', header: t('Date'), cell: (r: any) => dateTime(r.scheduled_start ?? r.actual_end) }, { key: 'tech', header: t('Technician'), cell: (r: any) => r.technician_name ?? '—' },
    { key: 's', header: t('Status'), cell: (r: any) => <div className="flex gap-1"><StatusBadge status={r.status} />{['completed', 'invoiced', 'paid'].includes(r.status) && !r.my_rating && <Badge tone="amber">{t('Rate us')}</Badge>}</div> }]} /></Card></div>);
}

function JobView() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: j, isLoading, error } = useData<any>(['portal-job', id], `/portal/jobs/${id}`);
  const [fb, setFb] = useState({ rating: 0, technicianRating: 0, comment: '' });
  const [change, setChange] = useState<any>(null);
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} />;
  const done = ['completed', 'invoiced', 'paid'].includes(j.status);
  const Stars = ({ v, set }: { v: number; set: (n: number) => void }) => <div className="flex gap-1">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-label={`${n} stars`} onClick={() => set(n)}><Star className={cn('h-7 w-7', n <= v ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} /></button>)}</div>;
  return (
    <div className="space-y-4">
      <Link to="/portal/jobs" className="text-sm text-slate-500">{t('← Visits')}</Link>
      <div><p className="text-xs text-slate-500">{j.number}</p><h1 className="text-xl font-semibold text-navy-900">{j.title}</h1><div className="mt-1"><StatusBadge status={j.status} /></div></div>
      <Card><CardBody className="space-y-2 text-sm"><p><b>{t('Scheduled:')}</b> {j.scheduled_start ? dateTime(j.scheduled_start) : 'We will confirm the time shortly'}</p>{j.technician_name && <p><b>{t('Technician:')}</b> {j.technician_name}</p>}
        {j.description && <p className="text-slate-600">{j.description}</p>}
        {['new', 'approved', 'scheduled', 'assigned'].includes(j.status) && <div className="flex gap-2 pt-2"><Button size="sm" variant="outline" onClick={() => setChange({ type: 'reschedule', reason: '', preferredDate: '' })}>{t('Request reschedule')}</Button>
          <Button size="sm" variant="danger-outline" onClick={() => setChange({ type: 'cancel', reason: '' })}>{t('Request cancellation')}</Button></div>}</CardBody></Card>
      {j.report && <Card><CardHeader title={t('Service report')} /><CardBody className="space-y-2 text-sm"><p><b>{t('Findings:')}</b> {j.report.findings ?? '—'}</p><p><b>{t('Work performed:')}</b> {j.report.work_performed}</p>
        {j.report.recommendations && <p><b>{t('Recommendations:')}</b> {j.report.recommendations}</p>}{j.report.customer_signed_name && <p className="text-xs text-slate-500">{t('Signed by {name}', { name: j.report.customer_signed_name })}</p>}</CardBody></Card>}
      {j.documents.length > 0 && <Card><CardHeader title={t('Photos & documents')} /><CardBody className="grid grid-cols-3 gap-2">{j.documents.map((d: any) => <a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border">
        {d.mime_type.startsWith('image/') ? <img src={d.url} alt={statusLabel(d.category)} className="h-24 w-full object-cover" /> : <span className="block p-3 text-xs">{d.file_name}</span>}</a>)}</CardBody></Card>}
      {done && (j.feedback ? <Alert tone="green" title={t('Thanks for your feedback')}>{'★'.repeat(j.feedback.rating)} {j.feedback.comment}</Alert> : (
        <Card><CardHeader title={t('How did we do?')} /><CardBody className="space-y-3"><Field label={t('Overall service')}><Stars v={fb.rating} set={(n) => setFb({ ...fb, rating: n })} /></Field>
          {j.technician_name && <Field label={t('Technician ({name})', { name: j.technician_name })}><Stars v={fb.technicianRating} set={(n) => setFb({ ...fb, technicianRating: n })} /></Field>}
          <Field label={t('Comments')}><Textarea rows={3} value={fb.comment} onChange={(e) => setFb({ ...fb, comment: e.target.value })} /></Field>
          <Button disabled={!fb.rating} onClick={() => post(`/portal/jobs/${j.id}/feedback`, { rating: fb.rating, technicianRating: fb.technicianRating || undefined, comment: fb.comment || null }).then(() => { toast.success(t('Thank you!')); qc.invalidateQueries({ queryKey: ['portal-job', id] }); }).catch(toastError)}>{t('Submit feedback')}</Button></CardBody></Card>))}
      <Card><CardHeader title={t('Progress')} /><CardBody><Timeline items={j.history.map((h: any) => ({ title: titleCase(h.to_status), meta: dateTime(h.changed_at) }))} /></CardBody></Card>
      <Dialog open={!!change} onOpenChange={(o) => !o && setChange(null)} title={change?.type === 'cancel' ? 'Request cancellation' : 'Request a new time'} description={t('The business will confirm with you.')}
        footer={<Button disabled={!change?.reason || change.reason.length < 3} onClick={() => post(`/portal/jobs/${j.id}/change-request`, { ...change, preferredDate: change.preferredDate || undefined, confirmed: true }).then((r) => { toast.success(r.data.message); setChange(null); }).catch(toastError)}>{t('Send request')}</Button>}>
        {change && <div className="space-y-3">{change.type === 'reschedule' && <Field label={t('Preferred new date')}><Input type="date" value={change.preferredDate} onChange={(e) => setChange({ ...change, preferredDate: e.target.value })} /></Field>}
          <Field label={t('Reason')}><Textarea rows={3} value={change.reason} onChange={(e) => setChange({ ...change, reason: e.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}

function Billing() {
  const [tab, setTab] = useState(new URLSearchParams(location.search).get('tab') ?? 'invoices');
  const qc = useQueryClient();
  const { data: invoices, isLoading } = useData<any[]>(['portal-invoices'], '/portal/invoices');
  const { data: quotes } = useData<any[]>(['portal-quotes'], '/portal/quotations');
  const [inv, setInv] = useState<string | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const { data: iv } = useData<any>(['portal-invoice', inv], inv ? `/portal/invoices/${inv}` : null);
  const { data: qv } = useData<any>(['portal-quote', quote], quote ? `/portal/quotations/${quote}` : null);
  const [accept, setAccept] = useState(false);
  return (
    <div><PageHeader title={t('Billing')} /><Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'invoices', label: t('Invoices') }, { value: 'quotes', label: t('Quotations'), count: quotes?.filter((q) => ['sent', 'viewed'].includes(q.status)).length }]} />
      <div className="mt-4">
        {tab === 'invoices' && <Card><DataTable rows={invoices} loading={isLoading} onRowClick={(r: any) => setInv(r.id)} empty={<EmptyState title={t('No invoices')} />} columns={[
          { key: 'n', header: t('Invoice'), cell: (r: any) => r.number }, { key: 'd', header: t('Due'), cell: (r: any) => date(r.due_date) }, { key: 't', header: t('Total'), className: 'text-right', cell: (r: any) => money(r.total, r.currency) },
          { key: 'b', header: t('Balance'), className: 'text-right', cell: (r: any) => money(r.balance_due, r.currency) }, { key: 's', header: t('Status'), cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>}
        {tab === 'quotes' && <Card><DataTable rows={quotes} onRowClick={(r: any) => { setQuote(r.id); setAccept(false); }} empty={<EmptyState title={t('No quotations')} />} columns={[
          { key: 'n', header: t('Quotation'), cell: (r: any) => <div><p>{r.number}</p><p className="text-xs text-slate-500">{r.title}</p></div> }, { key: 'v', header: t('Valid until'), cell: (r: any) => date(r.valid_until) },
          { key: 't', header: t('Total'), className: 'text-right', cell: (r: any) => money(r.total, r.currency) }, { key: 's', header: t('Status'), cell: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>}
      </div>
      <Dialog open={!!inv} onOpenChange={(o) => !o && setInv(null)} title={iv ? t('Invoice {number}', { number: iv.number }) : ''} size="lg" footer={iv && <>
        <Button variant="outline" onClick={() => openFile(`/portal/invoices/${iv.id}/pdf`).catch(toastError)}><Download />{t('PDF')}</Button>
        {Number(iv.balance_due) > 0 && iv.onlinePayment && ['issued', 'partially_paid', 'overdue'].includes(iv.status) && <Button onClick={() => post(`/portal/invoices/${iv.id}/pay`).then((r) => { window.location.href = r.data.checkoutUrl; }).catch(toastError)}>{t('Pay {amount}', { amount: money(iv.balance_due, iv.currency) })}</Button>}</>}>
        {iv ? <div className="space-y-3 text-sm"><ul className="divide-y divide-slate-100">{iv.items.map((x: any, k: number) => <li key={k} className="flex justify-between py-2"><span>{x.description} × {Number(x.quantity)}</span><span className="tabular">{money(x.line_total, iv.currency)}</span></li>)}</ul>
          <div className="flex justify-between font-semibold"><span>{t('Total')}</span><span>{money(iv.total, iv.currency)}</span></div><div className="flex justify-between"><span>{t('Balance due')}</span><span>{money(iv.balance_due, iv.currency)}</span></div>
          {iv.payments.map((p: any) => <div key={p.id} className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2"><span>{t('Paid {amount}', { amount: money(p.amount, iv.currency) })} · {date(p.received_at)}</span>
            <Button size="sm" variant="ghost" onClick={() => openFile(`/portal/payments/${p.id}/receipt.pdf`).catch(toastError)}>{t('Receipt')}</Button></div>)}
          {iv.onlinePayment?.mode === 'test' && <p className="text-xs text-slate-500">{t('Online payments are in sandbox mode.')}</p>}</div> : <PageLoader />}
      </Dialog>
      <Dialog open={!!quote} onOpenChange={(o) => !o && setQuote(null)} title={qv ? t('Quotation {number}', { number: qv.number }) : ''} size="lg" footer={qv && ['sent', 'viewed'].includes(qv.status) && <>
        <Button variant="danger-outline" onClick={() => { const reason = window.prompt('Reason for declining'); if (reason) post(`/portal/quotations/${qv.id}/reject`, { reason }).then(() => { setQuote(null); qc.invalidateQueries({ queryKey: ['portal-quotes'] }); }).catch(toastError); }}>{t('Decline')}</Button>
        <Button disabled={!accept} onClick={() => post(`/portal/quotations/${qv.id}/approve`, { accept: true }).then(() => { toast.success(t('Quotation approved')); setQuote(null); qc.invalidateQueries({ queryKey: ['portal-quotes'] }); }).catch(toastError)}>{t('Approve')}</Button></>}>
        {qv ? <div className="space-y-3 text-sm"><ul className="divide-y divide-slate-100">{qv.items.map((x: any, k: number) => <li key={k} className="flex justify-between py-2"><span>{x.description} × {Number(x.quantity)}</span><span className="tabular">{money(x.line_total, qv.currency)}</span></li>)}</ul>
          <div className="flex justify-between"><span>{t('Tax')}</span><span>{money(qv.tax_total, qv.currency)}</span></div><div className="flex justify-between font-semibold"><span>{t('Total')}</span><span>{money(qv.total, qv.currency)}</span></div>
          {qv.terms && <p className="whitespace-pre-line rounded-lg bg-slate-50 p-3 text-xs">{qv.terms}</p>}
          <Button size="sm" variant="ghost" onClick={() => openFile(`/portal/quotations/${qv.id}/pdf`).catch(toastError)}><Download />{t('PDF')}</Button>
          {['sent', 'viewed'].includes(qv.status) && <Checkbox label={t('I accept this quotation and its terms')} checked={accept} onChange={(e) => setAccept(e.target.checked)} />}</div> : <PageLoader />}
      </Dialog>
    </div>
  );
}

function Contracts() {
  const { data, isLoading } = useData<any[]>(['portal-contracts'], '/portal/contracts');
  if (isLoading) return <PageLoader />;
  return (<div><PageHeader title={t('Maintenance plans (AMC)')} />{!data?.length ? <Card><EmptyState title={t('No maintenance plans')} description={t('Ask us about annual maintenance contracts.')} /></Card> : <div className="space-y-4">{data.map((c) => (
    <Card key={c.id}><CardHeader title={c.title} description={`${c.number} · ${date(c.start_date)} – ${date(c.end_date)}`} actions={<StatusBadge status={c.status} />} />
      <CardBody className="space-y-3 text-sm"><p>{t('{done} of {total} visits completed', { done: c.visits_completed, total: c.visits_included })} · {statusLabel(c.frequency)}</p>
        <div className="flex flex-wrap gap-2">{(c.visits ?? []).map((v: any) => <Badge key={v.visit_number} tone={v.status === 'completed' ? 'green' : 'slate'}>#{v.visit_number} {date(v.due_date)}</Badge>)}</div>
        {c.coverage && <p><b>{t('Covers:')}</b> {c.coverage}</p>}{c.exclusions && <p className="text-slate-500"><b>{t('Excludes:')}</b> {c.exclusions}</p>}</CardBody></Card>))}</div>}</div>);
}

function Assets() {
  const qc = useQueryClient();
  const { data, isLoading } = useData<any[]>(['portal-assets'], '/portal/assets');
  const [v, setV] = useState<any>(null);
  return (<div><PageHeader title={t('My equipment')} actions={<Button onClick={() => setV({ name: '', manufacturer: '', model: '', serialNumber: '', installationDate: '', warrantyExpiry: '' })}><Plus />{t('Add equipment')}</Button>} />
    <Card><DataTable rows={data} loading={isLoading} empty={<EmptyState title={t('No equipment registered')} />} columns={[{ key: 'n', header: t('Equipment'), cell: (r: any) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-slate-500">{[r.manufacturer, r.model].filter(Boolean).join(' ')}</p></div> },
      { key: 'w', header: t('Warranty until'), cell: (r: any) => date(r.warranty_expiry) }, { key: 'l', header: t('Last service'), cell: (r: any) => date(r.last_service_date) }, { key: 'nx', header: t('Next due'), cell: (r: any) => date(r.next_service_due) }]} /></Card>
    <Dialog open={!!v} onOpenChange={(o) => !o && setV(null)} title={t('Register equipment')} footer={<Button disabled={!v?.name} onClick={() => post('/portal/assets', Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null]))).then(() => { setV(null); qc.invalidateQueries({ queryKey: ['portal-assets'] }); toast.success(t('Equipment added')); }).catch(toastError)}>{t('Save')}</Button>}>
      {v && <div className="grid gap-3 sm:grid-cols-2">{[['name', t('Name')], ['manufacturer', t('Brand')], ['model', t('Model')], ['serialNumber', t('Serial number')]].map(([k, l]) => <Field key={k} label={l}><Input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}
        <Field label={t('Installed on')}><Input type="date" value={v.installationDate} onChange={(e) => setV({ ...v, installationDate: e.target.value })} /></Field><Field label={t('Warranty until')}><Input type="date" value={v.warrantyExpiry} onChange={(e) => setV({ ...v, warrantyExpiry: e.target.value })} /></Field></div>}
    </Dialog></div>);
}

function SupportPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data } = useData<any[]>(['portal-tickets'], '/portal/tickets');
  const [v, setV] = useState<any>(null);
  const [reply, setReply] = useState<Record<string, string>>({});
  return (<div><PageHeader title={t('Contact & support')} description={me && `${me.business.name}${me.business.phone ? ` · ${me.business.phone}` : ''}${me.business.email ? ` · ${me.business.email}` : ''}`}
    actions={<Button onClick={() => setV({ subject: '', message: '', category: 'general' })}><Plus />{t('New message')}</Button>} />
    <div className="space-y-4">{(data ?? []).length ? data!.map((tkt) => (<Card key={tkt.id}><CardHeader title={tkt.subject} description={`${tkt.number} · ${dateTime(tkt.created_at)}`} actions={<StatusBadge status={tkt.status} />} />
      <CardBody className="space-y-2 text-sm">{(tkt.messages ?? []).map((m: any, i: number) => <p key={i} className={cn('rounded-lg p-3', m.author_type === 'customer' ? 'ml-8 bg-brand-50' : 'bg-slate-100')}>{m.body}<span className="block text-xs text-slate-500">{dateTime(m.created_at)}</span></p>)}
        {tkt.status !== 'closed' && <div className="flex gap-2"><Input value={reply[tkt.id] ?? ''} onChange={(e) => setReply({ ...reply, [tkt.id]: e.target.value })} placeholder={t('Reply…')} />
          <Button disabled={!reply[tkt.id]} onClick={() => post(`/portal/tickets/${tkt.id}/messages`, { body: reply[tkt.id] }).then(() => { setReply({ ...reply, [tkt.id]: '' }); qc.invalidateQueries({ queryKey: ['portal-tickets'] }); }).catch(toastError)}>{t('Send')}</Button></div>}</CardBody></Card>))
      : <Card><EmptyState title={t('No messages yet')} /></Card>}</div>
    <Dialog open={!!v} onOpenChange={(o) => !o && setV(null)} title={t('Send a message')} footer={<Button disabled={!v?.subject || !v?.message} onClick={() => post('/portal/tickets', v).then(() => { setV(null); qc.invalidateQueries({ queryKey: ['portal-tickets'] }); toast.success(t('Message sent')); }).catch(toastError)}>{t('Send')}</Button>}>
      {v && <div className="space-y-3"><Field label={t('Topic')}><Select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} options={['general', 'billing', 'scheduling', 'service_quality', 'complaint'].map((c) => ({ value: c, label: titleCase(c) }))} /></Field>
        <Field label={t('Subject')}><Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} /></Field><Field label={t('Message')}><Textarea rows={4} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} /></Field></div>}
    </Dialog></div>);
}

function ProfilePage() {
  const qc = useQueryClient();
  const { data } = useMe();
  const [p, setP] = useState<any>(null);
  if (data && !p) setP({ fullName: data.customer.full_name, phone: data.customer.phone ?? '', altPhone: data.customer.alt_phone ?? '', notificationOptOut: data.customer.notification_opt_out ?? {} });
  const [addr, setAddr] = useState<any>(null);
  if (!p) return <PageLoader />;
  return (<div className="max-w-2xl space-y-6"><PageHeader title={t('My profile')} />
    <Card><CardBody className="grid gap-4 sm:grid-cols-2"><Field label={t('Name')}><Input value={p.fullName} onChange={(e) => setP({ ...p, fullName: e.target.value })} /></Field>
      <Field label={t('Phone')}><Input value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field>
      <div className="sm:col-span-2 space-y-1"><p className="label">{t('Notifications')}</p>{['email', 'whatsapp', 'sms'].map((ch) => <Checkbox key={ch} label={ch === 'email' ? t('Send me email updates') : ch === 'whatsapp' ? t('Send me WhatsApp updates') : t('Send me SMS updates')} checked={!p.notificationOptOut[ch]} onChange={(e) => setP({ ...p, notificationOptOut: { ...p.notificationOptOut, [ch]: !e.target.checked } })} />)}</div>
      <div><Button onClick={() => patch('/portal/me', { ...p, phone: p.phone || null, altPhone: p.altPhone || null }).then(() => { toast.success(t('Saved')); qc.invalidateQueries({ queryKey: ['portal-me'] }); }).catch(toastError)}>{t('Save')}</Button></div></CardBody></Card>
    <Card><CardHeader title={t('Addresses')} actions={<Button size="sm" variant="outline" onClick={() => setAddr({ label: t('Home'), line1: '', city: '', postalCode: '', isDefault: false })}><Plus />{t('Add')}</Button>} />
      <ul className="divide-y divide-slate-100 text-sm">{data.addresses.map((a: any) => <li key={a.id} className="px-5 py-3">{a.label}: {[a.line1, a.city, a.postal_code].filter(Boolean).join(', ')} {a.is_default && <Badge tone="blue">{t('Default')}</Badge>}</li>)}</ul></Card>
    <Dialog open={!!addr} onOpenChange={(o) => !o && setAddr(null)} title={t('Add address')} footer={<Button disabled={!addr?.line1} onClick={() => post('/portal/addresses', addr).then(() => { setAddr(null); qc.invalidateQueries({ queryKey: ['portal-me'] }); }).catch(toastError)}>{t('Save')}</Button>}>
      {addr && <div className="grid gap-3 sm:grid-cols-2">{[['label', t('Label')], ['line1', t('Address')], ['city', t('City')], ['postalCode', t('Postal code')]].map(([k, l]) => <Field key={k} label={l}><Input value={addr[k]} onChange={(e) => setAddr({ ...addr, [k]: e.target.value })} /></Field>)}
        <Checkbox label={t('Default address')} checked={addr.isDefault} onChange={(e) => setAddr({ ...addr, isDefault: e.target.checked })} /></div>}
    </Dialog></div>);
}

export default function Portal() {
  return (
    <Routes>
      <Route index element={<Home />} />
      <Route path="requests" element={<Requests />} /><Route path="requests/new" element={<NewRequest />} />
      <Route path="jobs" element={<Jobs />} /><Route path="jobs/:id" element={<JobView />} />
      <Route path="billing" element={<Billing />} /><Route path="contracts" element={<Contracts />} /><Route path="assets" element={<Assets />} />
      <Route path="support" element={<SupportPage />} /><Route path="profile" element={<ProfilePage />} />
    </Routes>
  );
}
