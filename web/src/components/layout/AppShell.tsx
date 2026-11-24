import { useEffect, useRef, useState, type ElementType } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Bell, Bot, Boxes, CalendarDays, ClipboardList, CreditCard, FileSignature, FileText, FolderOpen, Gauge, Headset, Inbox, LifeBuoy, LogOut, Menu as MenuIcon,
  MessageSquare, Plug, Receipt, Settings, ShieldCheck, Truck, UserCog, Users, Wrench, X, Search, ScrollText, Cpu, Sparkles,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api, post } from '@/lib/api';
import { ago, date } from '@/lib/format';
import { cn, titleCase } from '@/lib/utils';
import { Alert, Avatar, Badge, Button, Menu } from '@/components/ui';
import { Logo } from './Logo';

interface NavItem { to: string; label: string; icon: ElementType; perm?: string[]; feature?: string }
const NAV: { section: string; items: NavItem[] }[] = [
  { section: 'Overview', items: [{ to: '/app', label: 'Dashboard', icon: Gauge, perm: ['dashboard.view'] }] },
  { section: 'Operations', items: [
    { to: '/app/customers', label: 'Customers', icon: Users, perm: ['customers.read'], feature: 'crm' },
    { to: '/app/assets', label: 'Assets', icon: Cpu, perm: ['assets.read'], feature: 'crm' },
    { to: '/app/requests', label: 'Service Requests', icon: Inbox, perm: ['requests.read'], feature: 'service_requests' },
    { to: '/app/work-orders', label: 'Work Orders', icon: ClipboardList, perm: ['work_orders.read'], feature: 'work_orders' },
    { to: '/app/dispatch', label: 'Dispatch & Scheduling', icon: Truck, perm: ['dispatch.manage', 'work_orders.assign'] },
    { to: '/app/technicians', label: 'Technicians', icon: Wrench, perm: ['technicians.read'] },
    { to: '/app/calendar', label: 'Calendar', icon: CalendarDays, perm: ['calendar.view'] },
  ] },
  { section: 'Finance', items: [
    { to: '/app/quotations', label: 'Quotations', icon: FileSignature, perm: ['quotations.read'], feature: 'quotations' },
    { to: '/app/invoices', label: 'Invoices', icon: Receipt, perm: ['invoices.read'], feature: 'invoicing' },
    { to: '/app/payments', label: 'Payments', icon: CreditCard, perm: ['payments.read'], feature: 'invoicing' },
    { to: '/app/inventory', label: 'Inventory', icon: Boxes, perm: ['inventory.read'], feature: 'inventory' },
    { to: '/app/amc', label: 'AMC Contracts', icon: ScrollText, perm: ['amc.read'], feature: 'amc' },
  ] },
  { section: 'Insights & engagement', items: [
    { to: '/app/reports', label: 'Reports', icon: BarChart3, perm: ['reports.operational', 'reports.financial'] },
    { to: '/app/communications', label: 'Communications', icon: MessageSquare, perm: ['communications.read'] },
    { to: '/app/support', label: 'Support', icon: Headset, perm: ['support.read'] },
    { to: '/app/documents', label: 'Documents', icon: FolderOpen, perm: ['documents.read'] },
    { to: '/app/ai', label: 'AI Assistant', icon: Bot, perm: ['ai.use'], feature: 'ai' },
  ] },
  { section: 'Administration', items: [
    { to: '/app/integrations', label: 'Integrations', icon: Plug, perm: ['integrations.manage'] },
    { to: '/app/subscription', label: 'Subscription', icon: Sparkles, perm: ['subscription.manage', 'settings.manage'] },
    { to: '/app/settings', label: 'Settings', icon: Settings, perm: ['settings.manage', 'users.manage'] },
  ] },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can, feature, me } = useAuth();
  return (
    <nav className="flex h-full flex-col bg-navy-900 text-navy-100" aria-label="Main">
      <div className="flex h-16 items-center px-5"><Logo light /></div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
        {NAV.map((g) => {
          const items = g.items.filter((i) => (!i.perm || can(...i.perm)) && (!i.feature || feature(i.feature) || me?.support));
          if (!items.length) return null;
          return (
            <div key={g.section}>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-navy-400">{g.section}</p>
              <ul className="space-y-0.5">
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to} end={i.to === '/app'} onClick={onNavigate}
                      className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-navy-200 hover:bg-navy-800 hover:text-white')}>
                      <i.icon className="h-4 w-4 shrink-0" />{i.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="border-t border-navy-800 px-5 py-3 text-[11px] text-navy-400">NEXUS ServiceFlow · by NEXUS by DIL</div>
    </nav>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  const { data } = useQuery({ queryKey: ['search', q], queryFn: async () => (await api<{ data: any[] }>(`/app/search?q=${encodeURIComponent(q)}`)).data, enabled: q.trim().length >= 2 });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search customers, jobs, invoices…  ⌘K" aria-label="Global search" className="input h-9 border-slate-200 bg-slate-50 pl-9" />
      {open && q.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-11 z-40 max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-pop">
          {!data?.length ? <p className="px-3 py-4 text-center text-sm text-slate-500">No results</p> : data.map((r) => (
            <button key={`${r.type}-${r.id}`} className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50"
              onMouseDown={() => { nav(r.link); setQ(''); setOpen(false); }}>
              <span className="min-w-0"><span className="block truncate font-medium text-slate-800">{r.title}</span>{r.subtitle && <span className="block truncate text-xs text-slate-500">{titleCase(r.subtitle)}</span>}</span>
              <Badge>{titleCase(r.type)}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NotificationBell({ base = '/app' }: { base?: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['inbox'], queryFn: () => api<{ data: any[]; meta: { unread: number } }>('/app/notifications/inbox'), refetchInterval: 60_000 });
  const unread = data?.meta.unread ?? 0;
  return (
    <Menu trigger={<Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative">
      <Bell />{unread > 0 && <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">{unread}</span>}</Button>}
      items={[
        ...(data?.data.length ? data.data.slice(0, 8).map((n) => ({ label: <span className={cn('block max-w-[280px]', !n.read_at && 'font-semibold')}><span className="block truncate">{n.title}</span><span className="block text-xs font-normal text-slate-500">{ago(n.created_at)}</span></span>,
          onSelect: () => { post('/app/notifications/inbox/read', { ids: [n.id] }).then(() => qc.invalidateQueries({ queryKey: ['inbox'] })); if (n.link) nav(n.link.startsWith('/tech') && base === '/app' ? n.link.replace('/tech/jobs', '/app/work-orders') : n.link); } }))
          : [{ label: <span className="text-slate-500">You're all caught up</span>, onSelect: () => undefined, disabled: true }]),
        'sep' as const,
        { label: 'Mark all as read', onSelect: () => { post('/app/notifications/inbox/read', {}).then(() => qc.invalidateQueries({ queryKey: ['inbox'] })); } },
      ]} />
  );
}

export function UserMenu({ profilePath = '/app/profile' }: { profilePath?: string }) {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  return (
    <Menu trigger={<button className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100" aria-label="Account menu"><Avatar name={me?.user.full_name} />
      <span className="hidden text-left lg:block"><span className="block max-w-[140px] truncate text-sm font-medium text-slate-800">{me?.user.full_name}</span>
        <span className="block max-w-[140px] truncate text-xs text-slate-500">{me?.support ? 'NEXUS support (read-only)' : titleCase(me?.roles[0])}</span></span></button>}
      items={[{ label: 'My profile & security', icon: UserCog, onSelect: () => nav(profilePath) }, ...(me?.user.user_type === 'staff' ? [{ label: 'Help & NEXUS support', icon: LifeBuoy, onSelect: () => nav('/app/subscription?tab=support') }] : []), 'sep',
        { label: 'Sign out', icon: LogOut, danger: true, onSelect: async () => { await logout(); nav('/login'); } }]} />
  );
}

function Banners() {
  const { me } = useAuth();
  const nav = useNavigate();
  const e = me?.entitlements;
  const out = [];
  if (me?.support) out.push(<Alert key="sup" tone="amber" title="Read-only support session">You are viewing {me.tenant?.name} with a time-limited support grant (expires {date(me.support.expiresAt)}). Changes are blocked.</Alert>);
  if (me?.tenant?.is_demo) out.push(<Alert key="demo" tone="blue" title="Demo workspace">This is the CoolCare demonstration business. Data is sample data and separate from production tenants.</Alert>);
  if (e?.readOnly) out.push(<Alert key="ro" tone="red" title={`Subscription ${titleCase(e.status)}`} action={<Button size="sm" onClick={() => nav('/app/subscription')}>Renew now</Button>}>Your workspace is read-only until the subscription is renewed.</Alert>);
  else if (e?.status === 'trialing' && e.trialEndsAt) out.push(<Alert key="trial" tone="blue" action={<Button size="sm" variant="outline" onClick={() => nav('/app/subscription')}>Choose a plan</Button>}>Free trial of the {e.planName} plan ends {date(e.trialEndsAt)}.</Alert>);
  else if (e && ['past_due', 'grace_period'].includes(e.status)) out.push(<Alert key="pd" tone="amber" action={<Button size="sm" onClick={() => nav('/app/subscription')}>Update payment</Button>}>Your subscription payment is overdue. Renew to avoid interruption.</Alert>);
  if (me && !me.user.email_verified_at && !me.support) out.push(<Alert key="ev" tone="amber" action={<Button size="sm" variant="outline" onClick={() => post('/auth/resend-verification').then(() => alert('Verification email sent'))}>Resend email</Button>}>Please verify your email address.</Alert>);
  for (const a of me?.announcements ?? []) out.push(<Alert key={a.id} tone={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'amber' : 'blue'} title={a.title}>{a.body}</Alert>);
  return out.length ? <div className="mb-5 space-y-2">{out}</div> : null;
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block"><Sidebar /></aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal>
          <div className="absolute inset-0 bg-navy-950/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 animate-slide-up"><Sidebar onNavigate={() => setOpen(false)} />
            <button className="absolute right-3 top-4 rounded p-1 text-navy-200" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button></div>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><MenuIcon /></Button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1"><NotificationBell /><UserMenu /></div>
        </header>
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8"><Banners /><Outlet /></main>
      </div>
    </div>
  );
}

export function SimpleShell({ title, nav, children, base, wide }: { title: string; nav: { to: string; label: string; icon: ElementType }[]; children?: React.ReactNode; base: string; wide?: boolean }) {
  const w = wide ? 'max-w-7xl' : 'max-w-5xl';
  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className={cn('mx-auto flex h-14 items-center gap-4 px-4', w)}>
          <Link to={base}><Logo compact /></Link>
          <span className="hidden whitespace-nowrap text-sm font-medium text-slate-500 xl:inline">{title}</span>
          <nav className="ml-6 hidden gap-1 md:flex">{nav.map((n) => <NavLink key={n.to} to={n.to} end={n.to === base}
            className={({ isActive }) => cn('rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>{n.label}</NavLink>)}</nav>
          <div className="ml-auto flex items-center gap-1">{children}</div>
        </div>
      </header>
      <main className={cn('mx-auto px-4 py-5', w)}><Outlet /></main>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid border-t border-slate-200 bg-white md:hidden" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)`, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.to === base} className={({ isActive }) => cn('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-brand-700' : 'text-slate-500')}>
          <n.icon className="h-5 w-5" />{n.label}</NavLink>)}
      </nav>
    </div>
  );
}
export { FileText, ShieldCheck };
