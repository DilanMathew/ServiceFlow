import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, ShieldCheck, Wrench } from 'lucide-react';
import { api, post } from '@/lib/api';
import { date, money } from '@/lib/format';
import { Logo } from '@/components/layout/Logo';
import { Alert, Button, Card, CardBody, Checkbox, ErrorState, Field, Input, PageLoader, Select, StatusBadge, Textarea } from '@/components/ui';
import { toastError } from '@/components/form';

function Shell({ children, business }: { children: ReactNode; business?: string }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
        {business ? <span className="font-semibold text-navy-900">{business}</span> : <Logo compact />}<span className="text-xs text-slate-400">Powered by NEXUS ServiceFlow</span></div></header>
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </div>
  );
}

function LineTable({ items, currency }: { items: any[]; currency: string }) {
  return (
    <div className="overflow-x-auto"><table className="min-w-full text-sm">
      <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500"><th className="py-2">Item</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Price</th><th className="py-2 text-right">Tax</th><th className="py-2 text-right">Amount</th></tr></thead>
      <tbody>{items.map((i, k) => <tr key={k} className="border-b border-slate-100"><td className="py-2.5 pr-3">{i.description}{Number(i.discount_percent) > 0 && <span className="text-xs text-emerald-700"> (−{Number(i.discount_percent)}%)</span>}</td>
        <td className="py-2.5 text-right tabular">{Number(i.quantity)}</td><td className="py-2.5 text-right tabular">{money(i.unit_price, currency)}</td><td className="py-2.5 text-right">{Number(i.tax_rate)}%</td><td className="py-2.5 text-right tabular">{money(i.line_total, currency)}</td></tr>)}</tbody>
    </table></div>
  );
}
function Totals({ d }: { d: any }) {
  const rows: [string, any][] = [['Subtotal', d.subtotal], ...(Number(d.discount_total) > 0 ? [['Discount', -d.discount_total] as [string, any]] : []), ['Tax', d.tax_total]];
  return (
    <div className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
      {rows.map(([k, v]) => <div key={k} className="flex justify-between text-slate-600"><span>{k}</span><span className="tabular">{money(v, d.currency)}</span></div>)}
      {(d.tax_breakdown ?? []).map((t: any) => <div key={t.name + t.rate} className="flex justify-between pl-3 text-xs text-slate-400"><span>{t.name} {t.rate}%</span><span className="tabular">{money(t.amount, d.currency)}</span></div>)}
      <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-navy-900"><span>Total</span><span className="tabular">{money(d.total, d.currency)}</span></div>
    </div>
  );
}

function RequestForm() {
  const { slug } = useParams();
  const { data: t, isLoading, error } = useQuery({ queryKey: ['public-tenant', slug], queryFn: async () => (await api(`/public/tenants/${slug}`)).data });
  const [v, setV] = useState({ contactName: '', contactPhone: '', contactEmail: '', addressText: '', description: '', serviceCategoryId: '', preferredDate: '', preferredTimeSlot: 'any', consent: false, website: '' });
  const [files, setFiles] = useState<FileList | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (isLoading) return <PageLoader />;
  if (error) return <Shell><ErrorState error={error} /></Shell>;
  if (!t.requestFormEnabled) return <Shell business={t.name}><Alert tone="amber">Online requests are not available. Please call {t.phone}.</Alert></Shell>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const fd = new FormData();
      Object.entries(v).forEach(([k, val]) => { if (val !== '' && val !== false) fd.append(k, String(val)); });
      Array.from(files ?? []).slice(0, 5).forEach((f) => fd.append('photos', f));
      const r = await api(`/public/tenants/${slug}/requests`, { method: 'POST', body: fd });
      setDone(r.data.message);
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  return (
    <Shell business={t.name}>
      {done ? <Card><CardBody className="py-12 text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" /><p className="mt-3 text-lg font-semibold text-navy-900">{done}</p>
        <p className="mt-1 text-sm text-slate-500">We will contact you shortly{t.phone ? ` · ${t.phone}` : ''}.</p></CardBody></Card> : (
        <Card><CardBody>
          <h1 className="text-xl font-semibold text-navy-900">Request a service</h1><p className="mt-1 text-sm text-slate-500">Tell us what you need and we'll get back to you.</p>
          <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
            <Field label="Your name" required><Input required value={v.contactName} onChange={(e) => setV({ ...v, contactName: e.target.value })} /></Field>
            <Field label="Phone" required><Input required type="tel" value={v.contactPhone} onChange={(e) => setV({ ...v, contactPhone: e.target.value })} /></Field>
            <Field label="Email"><Input type="email" value={v.contactEmail} onChange={(e) => setV({ ...v, contactEmail: e.target.value })} /></Field>
            <Field label="Service"><Select value={v.serviceCategoryId} onChange={(e) => setV({ ...v, serviceCategoryId: e.target.value })} placeholder="Not sure" options={t.categories.map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
            <Field label="Service address" required className="sm:col-span-2"><Input required value={v.addressText} onChange={(e) => setV({ ...v, addressText: e.target.value })} /></Field>
            <Field label="Describe the problem" required className="sm:col-span-2"><Textarea required minLength={10} rows={4} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="e.g. My AC is leaking water and making noise" /></Field>
            <Field label="Preferred date"><Input type="date" value={v.preferredDate} onChange={(e) => setV({ ...v, preferredDate: e.target.value })} /></Field>
            <Field label="Preferred time"><Select value={v.preferredTimeSlot} onChange={(e) => setV({ ...v, preferredTimeSlot: e.target.value })} options={[{ value: 'any', label: 'Any time' }, { value: 'morning', label: 'Morning' }, { value: 'afternoon', label: 'Afternoon' }, { value: 'evening', label: 'Evening' }]} /></Field>
            <Field label="Photos (optional, up to 5)" className="sm:col-span-2"><input type="file" accept="image/*" multiple capture="environment" onChange={(e) => setFiles(e.target.files)} className="text-sm" /></Field>
            <input tabIndex={-1} autoComplete="off" className="hidden" aria-hidden value={v.website} onChange={(e) => setV({ ...v, website: e.target.value })} />
            <Checkbox className="sm:col-span-2" checked={v.consent} onChange={(e) => setV({ ...v, consent: e.target.checked })} label={`I agree that ${t.name} may contact me about this request and process my details for this purpose.`} />
            <div className="sm:col-span-2"><Button type="submit" size="lg" loading={busy} disabled={!v.consent}>Submit request</Button></div>
          </form>
        </CardBody></Card>)}
    </Shell>
  );
}

function QuotationPage() {
  const { token } = useParams();
  const qc = useQueryClient();
  const { data: q, isLoading, error } = useQuery({ queryKey: ['pq', token], queryFn: async () => (await api(`/public/quotations/${token}`)).data });
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (isLoading) return <PageLoader />;
  if (error) return <Shell><ErrorState error={error} /></Shell>;
  const act = async (kind: 'approve' | 'reject') => {
    setBusy(true);
    try { await post(`/public/quotations/${token}/${kind}`, kind === 'approve' ? { name, accept: true } : { reason }); qc.invalidateQueries({ queryKey: ['pq', token] }); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Shell business={q.business.name}>
      <Card><CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs uppercase tracking-wide text-slate-500">Quotation</p><h1 className="text-xl font-semibold text-navy-900">{q.number}{q.revision > 1 && ` · Rev ${q.revision}`}</h1>
            <p className="text-sm text-slate-500">For {q.customer_name} · Valid until {date(q.valid_until)}</p></div>
          <div className="flex items-center gap-2"><StatusBadge status={q.status} /><a href={`/api/public/quotations/${token}/pdf`} target="_blank" rel="noreferrer"><Button variant="outline" size="sm"><Download />PDF</Button></a></div>
        </div>
        {q.title && <p className="mt-4 font-medium">{q.title}</p>}
        <div className="mt-4"><LineTable items={q.items} currency={q.currency} /></div><Totals d={q} />
        {q.notes && <p className="mt-6 whitespace-pre-line text-sm text-slate-600">{q.notes}</p>}
        {q.terms && <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600"><p className="font-semibold">Terms</p><p className="whitespace-pre-line">{q.terms}</p></div>}
        {['sent', 'viewed'].includes(q.status) ? (
          <div className="mt-6 grid gap-4 border-t border-slate-100 pt-6 sm:grid-cols-2">
            <div className="space-y-3"><p className="font-semibold text-navy-900">Approve this quotation</p>
              <Field label="Your full name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)} label="I accept this quotation and its terms" />
              <Button disabled={name.trim().length < 2 || !agree} loading={busy} onClick={() => act('approve')}>Approve</Button></div>
            <div className="space-y-3"><p className="font-semibold text-navy-900">Decline</p>
              <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button variant="outline" disabled={reason.trim().length < 2} loading={busy} onClick={() => act('reject')}>Decline quotation</Button></div>
          </div>
        ) : q.status === 'approved' ? <Alert tone="green" title="Approved">Approved by {q.approved_by_name} on {date(q.approved_at)}. {q.business.name} will be in touch.</Alert> : null}
      </CardBody></Card>
    </Shell>
  );
}

function InvoicePage() {
  const { token } = useParams();
  const [sp] = useSearchParams();
  const { data: i, isLoading, error } = useQuery({ queryKey: ['pi', token], queryFn: async () => (await api(`/public/invoices/${token}`)).data, refetchInterval: sp.get('payment') ? 3000 : false });
  const [busy, setBusy] = useState(false);
  if (isLoading) return <PageLoader />;
  if (error) return <Shell><ErrorState error={error} /></Shell>;
  const pay = async () => { setBusy(true); try { const r = await post(`/public/invoices/${token}/pay`); window.location.href = r.data.checkoutUrl; } catch (e) { toastError(e); setBusy(false); } };
  return (
    <Shell business={i.seller?.name}>
      {sp.get('payment') === 'success' && <div className="mb-4"><Alert tone="green" title="Payment submitted">Thank you. Your payment is confirmed once the payment provider notifies us — this page updates automatically.</Alert></div>}
      {sp.get('payment') === 'failure' && <div className="mb-4"><Alert tone="red" title="Payment failed">Your payment did not go through. You can try again.</Alert></div>}
      <Card><CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs uppercase tracking-wide text-slate-500">Tax invoice</p><h1 className="text-xl font-semibold text-navy-900">{i.number}</h1>
            <p className="text-sm text-slate-500">Issued {date(i.issue_date)} · Due {date(i.due_date)}</p></div>
          <div className="flex items-center gap-2"><StatusBadge status={i.status} /><a href={`/api/public/invoices/${token}/pdf`} target="_blank" rel="noreferrer"><Button variant="outline" size="sm"><Download />PDF</Button></a></div>
        </div>
        <div className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          <div><p className="text-xs font-semibold uppercase text-slate-500">From</p><p className="font-medium">{i.seller?.name}</p><p className="text-slate-500">{i.seller?.address}</p>{i.seller?.tax_id && <p className="text-slate-500">{i.seller.tax_label}: {i.seller.tax_id}</p>}</div>
          <div><p className="text-xs font-semibold uppercase text-slate-500">Bill to</p><p className="font-medium">{i.bill_to?.name}</p><p className="text-slate-500">{i.bill_to?.address}</p></div>
        </div>
        <div className="mt-6"><LineTable items={i.items} currency={i.currency} /></div><Totals d={i} />
        <div className="ml-auto mt-2 w-full max-w-xs space-y-1 text-sm">
          {Number(i.amount_paid) > 0 && <div className="flex justify-between text-emerald-700"><span>Paid</span><span className="tabular">{money(i.amount_paid, i.currency)}</span></div>}
          <div className="flex justify-between font-semibold"><span>Balance due</span><span className="tabular">{money(i.balance_due, i.currency)}</span></div>
        </div>
        {Number(i.balance_due) > 0 && ['issued', 'partially_paid', 'overdue'].includes(i.status) && (
          <div className="mt-6 border-t border-slate-100 pt-5">{i.onlinePayment ? <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" loading={busy} onClick={pay}>Pay {money(i.balance_due, i.currency)} online</Button>
            <span className="flex items-center gap-1 text-xs text-slate-500"><ShieldCheck className="h-4 w-4" />Secure checkout{i.onlinePayment.mode === 'test' && ' (sandbox — no real money is charged)'}</span></div>
            : <p className="text-sm text-slate-600">Please pay using the bank details on the invoice.</p>}</div>)}
        {i.notes && <p className="mt-6 whitespace-pre-line text-sm text-slate-600">{i.notes}</p>}
      </CardBody></Card>
    </Shell>
  );
}

function SandboxCheckout({ billing }: { billing?: boolean }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: ['checkout', id], queryFn: async () => (await api(`/public/pay/test/${id}`)).data, enabled: !billing });
  const [busy, setBusy] = useState(false);
  const go = async (outcome: 'success' | 'failure') => {
    setBusy(true);
    try { const r = await post(billing ? `/public/pay/test/billing/${id}` : `/public/pay/test/${id}`, { outcome }); billing ? nav(r.data.returnUrl) : (window.location.href = r.data.returnUrl); }
    catch (e) { toastError(e); setBusy(false); }
  };
  if (!billing && isLoading) return <PageLoader />;
  if (error) return <Shell><ErrorState error={error} /></Shell>;
  return (
    <Shell>
      <Card className="mx-auto max-w-md"><CardBody className="text-center">
        <Alert tone="amber" title="Sandbox checkout">This is a test payment gateway. No real money is charged.</Alert>
        {!billing && <><p className="mt-6 text-sm text-slate-500">{data.business} · Invoice {data.number}</p><p className="mt-1 text-3xl font-semibold text-navy-900">{money(data.amount, data.currency)}</p></>}
        {billing && <p className="mt-6 text-sm text-slate-500">NEXUS ServiceFlow subscription</p>}
        <div className="mt-6 grid grid-cols-2 gap-3"><Button variant="outline" loading={busy} onClick={() => go('failure')}>Simulate failure</Button><Button loading={busy} onClick={() => go('success')}>Pay (simulate success)</Button></div>
      </CardBody></Card>
    </Shell>
  );
}

function AssetPage() {
  const { token } = useParams();
  const { data: a, isLoading, error } = useQuery({ queryKey: ['qr', token], queryFn: async () => (await api(`/public/assets/${token}`)).data });
  if (isLoading) return <PageLoader />;
  if (error) return <Shell><ErrorState error={error} /></Shell>;
  return (
    <Shell business={a.business.name}>
      <Card><CardBody>
        <div className="flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Wrench className="h-5 w-5" /></div>
          <div><p className="text-xs text-slate-500">{a.number}</p><h1 className="text-lg font-semibold text-navy-900">{a.name}</h1><p className="text-sm text-slate-500">{[a.manufacturer, a.model].filter(Boolean).join(' ')}</p></div></div>
        <div className="mt-5 grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Warranty</p><p className="font-medium">{a.warrantyActive === null ? 'Unknown' : a.warrantyActive ? 'Active' : 'Expired'}</p></div>
          <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Last service</p><p className="font-medium">{date(a.lastService)}</p></div></div>
        <div className="mt-6 flex flex-wrap gap-2"><Link to={`/r/${a.business.slug}`}><Button>Request service</Button></Link><Link to={`/app/assets/${a.assetId}`}><Button variant="outline">Open in ServiceFlow (staff)</Button></Link></div>
      </CardBody></Card>
    </Shell>
  );
}

function Legal({ kind }: { kind: 'privacy' | 'terms' }) {
  return (
    <Shell><Card><CardBody className="prose prose-sm max-w-none space-y-3 text-sm text-slate-700">
      <h1 className="text-xl font-semibold text-navy-900">{kind === 'privacy' ? 'Privacy Policy' : 'Terms of Service'}</h1>
      {kind === 'privacy' ? <>
        <p>NEXUS ServiceFlow is provided by NEXUS by DIL. Each business using ServiceFlow is the controller of its customers' personal data; NEXUS processes that data on the business's behalf as a processor.</p>
        <p>We process account data (name, email, phone), business records entered by our customers, and technical logs needed to secure the service. We do not sell personal data. Data is encrypted in transit, secrets are encrypted at rest, and each business's data is isolated.</p>
        <p>Data subjects can request access, correction or erasure through the business they dealt with; businesses can fulfil export, rectification and erasure requests in ServiceFlow, subject to legal retention obligations (for example, tax records).</p>
        <p>Subprocessors may include hosting, email delivery, messaging, payment and AI providers configured by the business. Contact NEXUS for the current subprocessor list and data processing agreement.</p>
        <p className="text-xs text-slate-500">This summary is provided for transparency and is not legal advice. Compliance with GDPR or other laws also depends on each business's own practices and contracts.</p>
      </> : <>
        <p>By creating an account you agree to use ServiceFlow lawfully, keep your credentials secure, and only upload data you are entitled to process.</p>
        <p>Subscriptions renew for the selected billing period until cancelled. Cancellation takes effect at the end of the paid period. Pricing is shown in the app and may change with notice.</p>
        <p>The service is provided with reasonable care and skill; scheduled maintenance and incidents are communicated in-app. Liability is limited to the fees paid in the preceding 12 months, except where the law does not allow such limits.</p>
      </>}
    </CardBody></Card></Shell>
  );
}

export default function PublicPages({ page }: { page: string }) {
  switch (page) {
    case 'request': return <RequestForm />;
    case 'quotation': return <QuotationPage />;
    case 'invoice': return <InvoicePage />;
    case 'checkout': return <SandboxCheckout />;
    case 'billing-checkout': return <SandboxCheckout billing />;
    case 'asset': return <AssetPage />;
    case 'privacy': return <Legal kind="privacy" />;
    default: return <Legal kind="terms" />;
  }
}
