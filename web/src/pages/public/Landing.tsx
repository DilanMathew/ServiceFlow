import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ClipboardList, CreditCard, Gauge, MapPin, ScrollText, ShieldCheck, Smartphone, Sparkles, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui';

const FEATURES = [
  { icon: ClipboardList, title: 'Requests to paid jobs', text: 'Capture requests from your portal, phone or WhatsApp, convert them into work orders and track every status change.' },
  { icon: MapPin, title: 'Smart dispatch', text: 'Skill, area, workload and travel-aware suggestions. Double-booking is blocked at the database level.' },
  { icon: Smartphone, title: 'Technician mobile portal', text: 'Today\'s jobs, navigation, photos, parts, reports and customer signatures — no app install needed.' },
  { icon: CreditCard, title: 'Quotes, invoices & payments', text: 'GST / VAT ready invoicing, online payments, partial payments and refunds with full audit trails.' },
  { icon: ScrollText, title: 'AMC contracts', text: 'Recurring maintenance visits generated automatically, with renewal reminders and quotations.' },
  { icon: Sparkles, title: 'AI assistance', text: 'Interpret requests, draft service reports and surface insights — always with a human in control.' },
  { icon: Users, title: 'Customer portal', text: 'Customers raise requests, approve quotes, pay invoices and follow their visits online.' },
  { icon: ShieldCheck, title: 'Secure multi-tenant', text: 'Each business\'s data is isolated by row-level security, encrypted secrets and append-only audit logs.' },
];

export default function Landing() {
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: async () => (await api<{ data: any[] }>('/public/plans')).data });
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-20 border-b border-slate-100 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Logo />
          <nav className="flex items-center gap-2">
            <a href="#pricing" className="hidden px-3 text-sm font-medium text-slate-600 hover:text-navy-900 sm:block">Pricing</a>
            <Link to="/login"><Button variant="ghost">Sign in</Button></Link>
            <Link to="/register"><Button>Start free trial</Button></Link>
          </nav>
        </div>
      </header>
      <section className="relative overflow-hidden bg-navy-900">
        <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-navy-800 px-3 py-1 text-xs font-medium text-brand-300 ring-1 ring-navy-700">Field service management for growing teams</p>
            <h1 className="text-4xl font-bold leading-tight text-white sm:text-5xl">Manage Every Service.<br /><span className="text-brand-400">Every Customer. Every Job.</span></h1>
            <p className="mt-5 max-w-lg text-lg text-navy-200">From the first customer enquiry to scheduled visits, invoices and recurring maintenance — one platform for AC, electrical, plumbing, CCTV, solar and equipment service businesses.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/register"><Button size="lg">Start your free trial</Button></Link>
              <Link to="/login"><Button size="lg" variant="outline" className="border-navy-600 bg-transparent text-white hover:bg-navy-800">Sign in</Button></Link>
            </div>
            <p className="mt-4 text-sm text-navy-300">No card required · India, Europe & international tax support</p>
          </div>
          <div className="hidden lg:block">
            <div className="rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-white/10">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-navy-900"><Gauge className="h-4 w-4 text-brand-600" /> Today at a glance</div>
              <div className="grid grid-cols-3 gap-3">
                {[['Jobs today', '18'], ['In progress', '6'], ['Collected', '₹42.6k']].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[11px] uppercase text-slate-500">{k}</p><p className="mt-1 text-xl font-semibold text-navy-900">{v}</p></div>))}
              </div>
              <div className="mt-4 space-y-2">
                {[['JOB-000231', 'AC not cooling — Koramangala', 'En route', 'bg-amber-50 text-amber-800'], ['JOB-000232', 'Generator service — Whitefield', 'Assigned', 'bg-violet-50 text-violet-700'],
                  ['JOB-000229', 'CCTV install — HSR Layout', 'Completed', 'bg-emerald-50 text-emerald-700']].map(([n, t, s, c]) => (
                  <div key={n} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2.5 text-sm">
                    <span><span className="font-medium text-navy-900">{n}</span> <span className="text-slate-500">· {t}</span></span><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{s}</span></div>))}
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-center text-3xl font-bold text-navy-900">Everything your service business runs on</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-slate-500">Built for real operations: transactional workflows, audit trails and permission-aware access for every role.</p>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-slate-200 p-5">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><f.icon className="h-5 w-5" /></div>
              <h3 className="font-semibold text-navy-900">{f.title}</h3><p className="mt-1.5 text-sm text-slate-600">{f.text}</p>
            </div>))}
        </div>
      </section>
      <section id="pricing" className="bg-slate-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-bold text-navy-900">Simple, transparent plans</h2>
          <p className="mt-3 text-center text-slate-500">Start with a free trial. Upgrade, downgrade or cancel any time.</p>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {(plans ?? []).map((p, i) => (
              <div key={p.code} className={`flex flex-col rounded-2xl border bg-white p-6 ${i === 1 ? 'border-brand-500 shadow-pop ring-1 ring-brand-500' : 'border-slate-200'}`}>
                {i === 1 && <span className="mb-3 self-start rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">Most popular</span>}
                <h3 className="text-lg font-semibold text-navy-900">{p.name}</h3><p className="mt-1 text-sm text-slate-500">{p.description}</p>
                <p className="mt-5"><span className="text-4xl font-bold text-navy-900">{new Intl.NumberFormat('en', { style: 'currency', currency: p.currency, maximumFractionDigits: 0 }).format(p.monthly_price)}</span><span className="text-slate-500"> /month</span></p>
                <ul className="mt-5 flex-1 space-y-2 text-sm text-slate-700">
                  <li className="flex gap-2"><Check className="h-4 w-4 text-brand-600" />Up to {p.max_technicians ?? 'unlimited'} technicians</li>
                  <li className="flex gap-2"><Check className="h-4 w-4 text-brand-600" />{p.max_users ?? 'Unlimited'} users</li>
                  {Object.entries(p.features).filter(([, v]) => v).slice(0, 7).map(([k]) => <li key={k} className="flex gap-2"><Check className="h-4 w-4 text-brand-600" />{k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}</li>)}
                </ul>
                <Link to={`/register?plan=${p.code}`} className="mt-6"><Button className="w-full" variant={i === 1 ? 'primary' : 'outline'}>Start {p.trial_days}-day trial</Button></Link>
              </div>))}
          </div>
          <p className="mt-6 text-center text-sm text-slate-500">Enterprise: multiple branches, custom limits and onboarding — contact NEXUS.</p>
        </div>
      </section>
      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-500">
        © {new Date().getFullYear()} NEXUS by DIL · <Link to="/privacy" className="hover:text-navy-900">Privacy</Link> · <Link to="/terms" className="hover:text-navy-900">Terms</Link>
      </footer>
    </div>
  );
}
