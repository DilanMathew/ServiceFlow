import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setMonitoringUser } from './monitoring';
import { useQueryClient } from '@tanstack/react-query';
import { api, post, refreshSession, setToken } from './api';
import { configureFormat } from './format';

export interface Me {
  user: { id: string; email: string; full_name: string; phone: string | null; user_type: 'platform' | 'staff' | 'customer'; mfa_enabled: boolean; email_verified_at: string | null };
  tenant: { id: string; name: string; slug: string; country: string; status: string; is_demo: boolean } | null;
  settings: { currency: string; timezone: string; locale: string; inventory_enabled: boolean; onboarding_completed_at: string | null; onboarding_step: number; technician_can_see_prices: boolean } | null;
  entitlements: { planCode: string; planName: string; status: string; readOnly: boolean; features: Record<string, boolean>;
    limits: { users: number | null; technicians: number | null; storageMb: number | null; branches: number; aiRequestsPerMonth: number }; trialEndsAt: string | null } | null;
  roles: string[]; permissions: string[]; technicianId: string | null; customerId: string | null;
  support: { grantId: string; expiresAt: string } | null;
  announcements: { id: string; title: string; body: string; severity: string }[];
}

interface AuthCtx {
  me: Me | null; loading: boolean;
  can: (...perms: string[]) => boolean;
  feature: (f: string) => boolean;
  reload: () => Promise<Me | null>;
  acceptToken: (token: string) => Promise<Me | null>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();
  useEffect(() => { setMonitoringUser(me ? { id: me.user.id, tenantId: me.tenant?.id ?? null, role: me.user.user_type } : null); }, [me]);

  const reload = useCallback(async () => {
    try {
      const r = await api<{ data: Me }>('/auth/me');
      setMe(r.data);
      if (r.data.settings) configureFormat({ currency: r.data.settings.currency, locale: r.data.settings.locale, timezone: r.data.settings.timezone });
      return r.data;
    } catch { setMe(null); return null; }
  }, []);

  useEffect(() => {
    (async () => {
      if (await refreshSession()) await reload();
      setLoading(false);
    })();
  }, [reload]);

  const acceptToken = useCallback(async (token: string) => { setToken(token); qc.clear(); return reload(); }, [qc, reload]);
  const logout = useCallback(async () => {
    try { await post('/auth/logout'); } catch { /* ignore */ }
    setToken(null); setMe(null); qc.clear();
  }, [qc]);

  const value = useMemo<AuthCtx>(() => ({
    me, loading, reload, acceptToken, logout,
    can: (...perms) => !!me && perms.some((p) => me.permissions.includes(p)),
    feature: (f) => !!me?.entitlements?.features?.[f],
  }), [me, loading, reload, acceptToken, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}

/** Where a user lands after signing in. */
export function homeFor(me: Me | null) {
  if (!me) return '/login';
  if (me.user.user_type === 'platform' && !me.support) return '/platform';
  if (me.user.user_type === 'customer') return '/portal';
  if (me.roles.includes('technician') && !me.permissions.includes('work_orders.read')) return '/tech';
  if (me.permissions.includes('settings.manage') && me.settings && !me.settings.onboarding_completed_at && !me.tenant?.is_demo) return '/app/onboarding';
  return '/app';
}
