import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setMonitoringUser } from './monitoring';
import { useQueryClient } from '@tanstack/react-query';
import { api, lastRefreshWasOffline, post, refreshSession, setToken } from './api';
import { lastProfile, rememberProfile, setOfflineUser, wipeOfflineData } from './offline/cache';
import { flushOutbox, outboxState, refreshOutbox, startOutbox } from './offline/outbox';
import { configureFormat } from './format';
import { applyUserLanguage } from './i18n';

export interface Me {
  user: { id: string; email: string; full_name: string; phone: string | null; user_type: 'platform' | 'staff' | 'customer'; mfa_enabled: boolean; email_verified_at: string | null; locale?: string | null };
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
  /** Opened from the device cache because there was no connection; actions are queued until online. */
  offlineSession: boolean;
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
  const [offlineSession, setOfflineSession] = useState(false);
  const qc = useQueryClient();
  useEffect(() => { setMonitoringUser(me ? { id: me.user.id, tenantId: me.tenant?.id ?? null, role: me.user.user_type } : null); }, [me]);

  const reload = useCallback(async () => {
    try {
      const r = await api<{ data: Me }>('/auth/me');
      applyMe(r.data);
      setOfflineSession(false);
      // Technicians may need to open the app without signal: keep their profile (never tokens) on the device.
      if (r.data.technicianId) void rememberProfile(r.data);
      void refreshOutbox().then(() => flushOutbox());
      return r.data;
    } catch { setMe(null); setOfflineUser(null); return null; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function applyMe(m: Me) {
    setMe(m);
    applyUserLanguage(m.user.locale, m.settings?.locale);
    setOfflineUser(m.user.id);
    if (m.settings) configureFormat({ currency: m.settings.currency, locale: m.settings.locale, timezone: m.settings.timezone });
  }

  useEffect(() => {
    startOutbox();
    (async () => {
      if (await refreshSession()) await reload();
      else if (lastRefreshWasOffline()) {
        const cached = await lastProfile<Me>();
        if (cached?.technicianId) { applyMe(cached); setOfflineSession(true); void refreshOutbox(); }
      }
      setLoading(false);
    })();
    // When the connection returns during an offline session, restore the real session.
    const back = async () => { if (await refreshSession()) await reload(); };
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const acceptToken = useCallback(async (token: string) => { setToken(token); qc.clear(); return reload(); }, [qc, reload]);
  const logout = useCallback(async () => {
    const unsynced = outboxState().pending + outboxState().failed;
    if (unsynced && !window.confirm(`${unsynced} job update(s) on this device have not been sent yet and will be lost if you sign out. Sign out anyway?`)) return;
    try { await post('/auth/logout'); } catch { /* ignore */ }
    await wipeOfflineData(me?.user.id ?? null);
    setToken(null); setMe(null); setOfflineUser(null); setOfflineSession(false); qc.clear();
    void refreshOutbox();
  }, [qc, me]);

  const value = useMemo<AuthCtx>(() => ({
    me, loading, offlineSession, reload, acceptToken, logout,
    can: (...perms) => !!me && perms.some((p) => me.permissions.includes(p)),
    feature: (f) => !!me?.entitlements?.features?.[f],
  }), [me, loading, offlineSession, reload, acceptToken, logout]);
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
