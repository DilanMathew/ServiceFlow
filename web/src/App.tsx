import { lazy, Suspense, Component, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CalendarDays, ClipboardList, FileText, Headset, History, Home, Inbox, Receipt, User, Wrench, Building2, Gauge, CreditCard, Activity, Megaphone, ScrollText, Settings } from 'lucide-react';
import { useAuth, homeFor } from './lib/auth';
import { AppShell, SimpleShell, NotificationBell, UserMenu } from './components/layout/AppShell';
import { Button, PageLoader } from './components/ui';

const p = <T,>(f: () => Promise<T>) => lazy(f as any);
// public & auth
const Landing = p(() => import('./pages/public/Landing'));
const Login = p(() => import('./pages/auth/Login'));
const Register = p(() => import('./pages/auth/Register'));
const AuthFlows = p(() => import('./pages/auth/Flows'));
const PublicPages = p(() => import('./pages/public/PublicPages'));
// business app
const Dashboard = p(() => import('./pages/app/Dashboard'));
const Onboarding = p(() => import('./pages/app/Onboarding'));
const Customers = p(() => import('./pages/app/Customers'));
const Assets = p(() => import('./pages/app/Assets'));
const Requests = p(() => import('./pages/app/Requests'));
const WorkOrders = p(() => import('./pages/app/WorkOrders'));
const Dispatch = p(() => import('./pages/app/Dispatch'));
const Technicians = p(() => import('./pages/app/Technicians'));
const Quotations = p(() => import('./pages/app/Quotations'));
const Invoices = p(() => import('./pages/app/Invoices'));
const Payments = p(() => import('./pages/app/Payments'));
const Inventory = p(() => import('./pages/app/Inventory'));
const Amc = p(() => import('./pages/app/Amc'));
const CalendarPage = p(() => import('./pages/app/Calendar'));
const Reports = p(() => import('./pages/app/Reports'));
const Communications = p(() => import('./pages/app/Communications'));
const Support = p(() => import('./pages/app/Support'));
const Documents = p(() => import('./pages/app/Documents'));
const Integrations = p(() => import('./pages/app/Integrations'));
const AiAssistant = p(() => import('./pages/app/AiAssistant'));
const Subscription = p(() => import('./pages/app/Subscription'));
const SettingsPage = p(() => import('./pages/app/Settings'));
const Profile = p(() => import('./pages/app/Profile'));
// technician, customer, platform
const Tech = p(() => import('./pages/tech/Tech'));
const Portal = p(() => import('./pages/portal/Portal'));
const Platform = p(() => import('./pages/platform/Platform'));

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
        <h1 className="text-lg font-semibold text-navy-900">Something went wrong</h1>
        <p className="mt-1 max-w-md text-sm text-slate-500">An unexpected error occurred while showing this page. Your data is safe.</p>
        <Button className="mt-4" onClick={() => { this.setState({ error: null }); location.reload(); }}>Reload</Button>
      </div>
    );
  }
}

function RequireAuth({ type, children }: { type: 'staff' | 'customer' | 'platform' | 'tech'; children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to={type === 'customer' ? '/portal/login' : '/login'} state={{ from: loc.pathname + loc.search }} replace />;
  const ok = type === 'platform' ? me.user.user_type === 'platform' && !me.support
    : type === 'customer' ? me.user.user_type === 'customer'
    : type === 'tech' ? me.user.user_type === 'staff' && (me.permissions.includes('work_orders.read_own') || me.permissions.includes('work_orders.execute'))
    : me.user.user_type === 'staff' || !!me.support;
  if (!ok) return <Navigate to={homeFor(me)} replace />;
  return <>{children}</>;
}

function NotFound() {
  return <div className="flex min-h-[60vh] flex-col items-center justify-center text-center"><p className="text-5xl font-bold text-navy-900">404</p>
    <p className="mt-2 text-slate-500">This page does not exist.</p><a href="/" className="mt-4"><Button variant="outline">Go home</Button></a></div>;
}

const techNav = [{ to: '/tech', label: 'Today', icon: Home }, { to: '/tech/calendar', label: 'Schedule', icon: CalendarDays }, { to: '/tech/history', label: 'History', icon: History }, { to: '/tech/profile', label: 'Profile', icon: User }];
const portalNav = [{ to: '/portal', label: 'Home', icon: Home }, { to: '/portal/requests', label: 'Requests', icon: Inbox }, { to: '/portal/jobs', label: 'Visits', icon: Wrench },
  { to: '/portal/billing', label: 'Billing', icon: Receipt }, { to: '/portal/support', label: 'Support', icon: Headset }];
const platformNav = [{ to: '/platform', label: 'Overview', icon: Gauge }, { to: '/platform/tenants', label: 'Tenants', icon: Building2 }, { to: '/platform/plans', label: 'Plans', icon: ScrollText },
  { to: '/platform/billing', label: 'Billing', icon: CreditCard }, { to: '/platform/support', label: 'Support', icon: Headset }, { to: '/platform/health', label: 'Health', icon: Activity },
  { to: '/platform/announcements', label: 'Notices', icon: Megaphone }, { to: '/platform/audit', label: 'Audit', icon: FileText }, { to: '/platform/settings', label: 'Config', icon: Settings }];

export function App() {
  const { me, loading } = useAuth();
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={loading ? <PageLoader /> : me ? <Navigate to={homeFor(me)} replace /> : <Landing />} />
          <Route path="/pricing" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<AuthFlows mode="forgot" />} />
          <Route path="/reset-password" element={<AuthFlows mode="reset" />} />
          <Route path="/verify-email" element={<AuthFlows mode="verify" />} />
          <Route path="/accept-invite" element={<AuthFlows mode="invite" />} />
          <Route path="/portal/login" element={<Login portal />} />
          <Route path="/portal/:slug/login" element={<Login portal />} />
          <Route path="/portal/:slug/register" element={<AuthFlows mode="portal-register" />} />
          {/* Public, token-based pages */}
          <Route path="/r/:slug" element={<PublicPages page="request" />} />
          <Route path="/q/view/:token" element={<PublicPages page="quotation" />} />
          <Route path="/i/:token" element={<PublicPages page="invoice" />} />
          <Route path="/pay/test/billing/:id" element={<PublicPages page="billing-checkout" />} />
          <Route path="/pay/test/:id" element={<PublicPages page="checkout" />} />
          <Route path="/q/:token" element={<PublicPages page="asset" />} />
          <Route path="/privacy" element={<PublicPages page="privacy" />} />
          <Route path="/terms" element={<PublicPages page="terms" />} />

          <Route path="/app/onboarding" element={<RequireAuth type="staff"><Onboarding /></RequireAuth>} />
          <Route path="/app" element={<RequireAuth type="staff"><AppShell /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="customers/*" element={<Customers />} />
            <Route path="assets/*" element={<Assets />} />
            <Route path="requests/*" element={<Requests />} />
            <Route path="work-orders/*" element={<WorkOrders />} />
            <Route path="dispatch" element={<Dispatch />} />
            <Route path="technicians/*" element={<Technicians />} />
            <Route path="quotations/*" element={<Quotations />} />
            <Route path="invoices/*" element={<Invoices />} />
            <Route path="payments" element={<Payments />} />
            <Route path="inventory/*" element={<Inventory />} />
            <Route path="amc/*" element={<Amc />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="reports/*" element={<Reports />} />
            <Route path="communications" element={<Communications />} />
            <Route path="support/*" element={<Support />} />
            <Route path="documents" element={<Documents />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="ai" element={<AiAssistant />} />
            <Route path="subscription" element={<Subscription />} />
            <Route path="settings/*" element={<SettingsPage />} />
            <Route path="profile" element={<Profile />} />
            <Route path="*" element={<NotFound />} />
          </Route>

          <Route path="/tech" element={<RequireAuth type="tech"><SimpleShell title="Technician" base="/tech" nav={techNav}><NotificationBell base="/tech" /><UserMenu profilePath="/tech/profile" /></SimpleShell></RequireAuth>}>
            <Route path="*" element={<Tech />} /><Route index element={<Tech />} />
          </Route>
          <Route path="/portal" element={<RequireAuth type="customer"><SimpleShell title="Customer portal" base="/portal" nav={portalNav}><UserMenu profilePath="/portal/profile" /></SimpleShell></RequireAuth>}>
            <Route path="*" element={<Portal />} /><Route index element={<Portal />} />
          </Route>
          <Route path="/platform" element={<RequireAuth type="platform"><SimpleShell title="Platform administration" base="/platform" nav={platformNav} wide><UserMenu profilePath="/platform/profile" /></SimpleShell></RequireAuth>}>
            <Route path="*" element={<Platform />} /><Route index element={<Platform />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
export { ClipboardList };
