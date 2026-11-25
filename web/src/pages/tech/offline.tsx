import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cacheGet, cachePut, isNetworkError } from '@/lib/offline/cache';
import { discardItem, flushOutbox, onSynced, retryItem, sendOrQueue, subscribeOutbox, type ActionInput, type OutboxState } from '@/lib/offline/outbox';
import { disablePush, enablePush, pushState, sendTestPush, type PushState } from '@/lib/pwa';
import { ago, dateTime } from '@/lib/format';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog } from '@/components/ui';
import { toastError } from '@/components/form';
import { t } from '@/lib/i18n';

export function useOutbox() {
  const [s, setS] = useState<OutboxState | null>(null);
  useEffect(() => subscribeOutbox(setS), []);
  return s;
}

/**
 * Like useData, but every successful response is kept on the device for this user, and when the
 * network is unavailable the last saved copy is shown instead of an error.
 */
export function useOfflineData<T = any>(key: unknown[], path: string | null, opts: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: key,
    enabled: !!path,
    refetchInterval: opts.refetchInterval,
    networkMode: 'always',
    retry: (n, e) => !isNetworkError(e) && n < 1,
    queryFn: async () => {
      try {
        const data = (await api<{ data: T }>(path!)).data;
        void cachePut(`q:${path}`, data);
        return data;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        const hit = await cacheGet<T>(`q:${path}`);
        if (hit) return hit.data;
        throw new Error(t('You are offline and this screen has not been opened on this device before.'));
      }
    },
  });
}

/** Saves job details for the technician's upcoming jobs so they open without signal. */
export async function prefetchJobs(qc: QueryClient, ids: string[]) {
  for (const id of ids.slice(0, 20)) {
    const path = `/app/work-orders/${id}`;
    try {
      const data = (await api<{ data: unknown }>(path)).data;
      await cachePut(`q:${path}`, data);
      qc.setQueryData(['tech-job', id], (old: unknown) => old ?? data);
    } catch { /* best effort */ }
  }
}

/** Optimistically updates a cached job (screen + device copy) while its change waits to sync. */
export function patchJob(qc: QueryClient, id: string, fn: (w: any) => any) {
  qc.setQueryData(['tech-job', id], (w: any) => {
    if (!w) return w;
    const next = fn(structuredClone(w));
    void cachePut(`q:/app/work-orders/${id}`, next);
    return next;
  });
}

// Transitions a technician can make, mirrored from the server so queued changes show sensible next steps.
const TECH_NEXT: Record<string, string[]> = {
  assigned: ['en_route', 'in_progress', 'on_hold'], en_route: ['in_progress', 'on_hold'],
  in_progress: ['on_hold', 'completed'], on_hold: ['in_progress'], completed: [],
};
export const localStatus = (w: any, s: string) => ({ ...w, status: s, allowedTransitions: TECH_NEXT[s] ?? [], accepted_at: w.accepted_at ?? new Date().toISOString(), _pending: true });

/** Runs an action now, or queues it when offline. Returns true when it was queued. */
export async function act(input: ActionInput, opts: { success?: string; onQueued?: () => void } = {}) {
  const r = await sendOrQueue(input);
  if (r.queued) { opts.onQueued?.(); toast.message(t('Saved on this device'), { description: t('{action} will sync when you are back online.', { action: input.label }) }); return true; }
  if (opts.success) toast.success(opts.success);
  return false;
}

export function OfflineBar() {
  const s = useOutbox();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  useEffect(() => onSynced(() => { qc.invalidateQueries({ queryKey: ['tech-job'] }); qc.invalidateQueries({ queryKey: ['tech-dash'] }); }), [qc]);
  if (!s) return null;
  const show = !s.online || s.pending > 0 || s.failed > 0;
  if (!show) return null;
  return (
    <>
      <div role="status" className={`mb-4 flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${s.failed ? 'border-red-200 bg-red-50 text-red-900' : !s.online ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900'}`}>
        {s.failed ? <TriangleAlert className="h-4 w-4 shrink-0" /> : !s.online ? <CloudOff className="h-4 w-4 shrink-0" /> : <RefreshCw className={`h-4 w-4 shrink-0 ${s.syncing ? 'animate-spin' : ''}`} />}
        <span className="flex-1">
          {!s.online ? t('You are offline. Your work is saved on this phone.') : s.syncing ? t('Syncing your changes…') : s.pending ? t('Changes waiting to sync.') : t('Some changes could not be synced.')}
          {(s.pending > 0 || s.failed > 0) && <span className="ml-1 font-medium">{s.pending ? t('{n} pending', { n: s.pending }) : ''}{s.pending && s.failed ? ', ' : ''}{s.failed ? t('{n} need attention', { n: s.failed }) : ''}</span>}
        </span>
        {(s.pending > 0 || s.failed > 0) && <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t('Review')}</Button>}
        {s.online && s.pending > 0 && !s.syncing && <Button size="sm" onClick={() => flushOutbox()}>{t('Sync now')}</Button>}
      </div>
      <Dialog open={open} onOpenChange={setOpen} title={t('Changes on this device')} description={t('Queued actions are sent in order when you are online.')}>
        <ul className="divide-y divide-slate-100 text-sm">
          {s.items.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 py-2.5">
              <span className="min-w-0"><span className="block font-medium text-slate-800">{i.label}</span>
                <span className="block text-xs text-slate-500">{dateTime(i.createdAt)} · {ago(i.createdAt)}</span>
                {i.error && <span className="mt-1 block text-xs text-red-700">{i.error}</span>}</span>
              <span className="flex shrink-0 items-center gap-1">
                {i.status === 'failed' ? <><Button size="sm" variant="outline" onClick={() => retryItem(i.id!)}>{t('Retry')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => discardItem(i.id!)}>{t('Discard')}</Button></> : <Badge tone="blue">{t('Pending')}</Badge>}
              </span>
            </li>
          ))}
          {!s.items.length && <li className="py-3 text-slate-500">{t('Everything is synced.')}</li>}
        </ul>
      </Dialog>
    </>
  );
}

export function PushCard({ compact }: { compact?: boolean }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setState).catch(() => setState('unsupported')); }, []);
  if (!state || state === 'unsupported') return compact ? null : (
    <Card><CardHeader title={t('Job alerts on this device')} /><CardBody><p className="text-sm text-slate-500">{t('This browser does not support notifications. On iPhone, add ServiceFlow to the Home Screen first (Share → Add to Home Screen).')}</p></CardBody></Card>);
  if (compact && state !== 'off') return null;
  const run = async (fn: () => Promise<PushState>) => { setBusy(true); try { setState(await fn()); } catch (e) { toastError(e); } finally { setBusy(false); } };
  if (compact) return (
    <Alert tone="blue" title={t('Get job alerts')} action={<Button size="sm" loading={busy} onClick={() => run(enablePush)}><Bell />{t('Turn on')}</Button>}>
      {t('Be notified on this phone when a job is assigned or rescheduled.')}</Alert>);
  return (
    <Card><CardHeader title={t('Job alerts on this device')} description={t('Push notifications when jobs are assigned, rescheduled or need attention.')} />
      <CardBody className="flex flex-wrap items-center gap-2 text-sm">
        {state === 'on' && <><Badge tone="green">{t('On')}</Badge><Button size="sm" variant="outline" loading={busy} onClick={() => sendTestPush().then(() => toast.success(t('Test notification sent'))).catch(toastError)}>{t('Send test')}</Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(disablePush)}><BellOff />{t('Turn off')}</Button></>}
        {state === 'off' && <Button size="sm" loading={busy} onClick={() => run(enablePush)}><Bell />{t('Turn on notifications')}</Button>}
        {state === 'denied' && <p className="text-slate-600">{t('Notifications are blocked for this site. Allow them in your browser settings, then reload.')}</p>}
      </CardBody></Card>);
}
