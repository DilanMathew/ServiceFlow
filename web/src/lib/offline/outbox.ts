/**
 * Offline action queue ("outbox") for the technician app.
 * Actions are stored per user in IndexedDB and replayed strictly in order when the device is online,
 * each with its own Idempotency-Key so a replay after a dropped response is never applied twice.
 */
import { api, ApiError, refreshSession } from '../api';
import { idbAvailable, outboxStore } from './idb';
import { isNetworkError, offlineUser } from './cache';

export interface OutboxFile { name: string; type: string; blob: Blob }
export interface OutboxItem {
  id?: number; userId: string; createdAt: string; label: string; jobId?: string; kind: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; json?: unknown;
  form?: { fields: Record<string, string>; files: OutboxFile[] };
  key: string; status: 'pending' | 'failed'; error?: string; attempts: number;
}
export interface OutboxState { items: OutboxItem[]; pending: number; failed: number; syncing: boolean; online: boolean }

let state: OutboxState = { items: [], pending: 0, failed: 0, syncing: false, online: typeof navigator === 'undefined' ? true : navigator.onLine };
const subs = new Set<(s: OutboxState) => void>();
const emit = () => subs.forEach((f) => f(state));
export const subscribeOutbox = (f: (s: OutboxState) => void) => { subs.add(f); f(state); return () => { subs.delete(f); }; };
export const outboxState = () => state;

const synced = new Set<(item: OutboxItem, response: unknown) => void>();
/** Called after each queued action is accepted by the server (used to refresh screens). */
export const onSynced = (f: (item: OutboxItem, response: unknown) => void) => { synced.add(f); return () => { synced.delete(f); }; };

export async function refreshOutbox() {
  const uid = offlineUser();
  const items = uid && idbAvailable() ? (await outboxStore.byUser<OutboxItem>(uid)).sort((a, b) => a.id! - b.id!) : [];
  state = { ...state, items, pending: items.filter((i) => i.status === 'pending').length, failed: items.filter((i) => i.status === 'failed').length };
  emit();
}

const newKey = () => `ofl-${crypto.randomUUID()}`;

function send(item: OutboxItem) {
  const headers = { 'Idempotency-Key': item.key };
  if (item.form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(item.form.fields)) fd.append(k, v);
    for (const f of item.form.files) fd.append('files', new File([f.blob], f.name, { type: f.type }));
    return api(item.path, { method: item.method, body: fd, headers });
  }
  return api(item.path, { method: item.method, body: item.json ?? {}, headers });
}

export type ActionInput = Omit<OutboxItem, 'id' | 'userId' | 'createdAt' | 'key' | 'status' | 'attempts'>;

/**
 * Sends now when possible; otherwise (offline, connection lost, or earlier actions still waiting)
 * queues the action and returns { queued: true }. HTTP errors are thrown to the caller as usual.
 */
export async function sendOrQueue<T = any>(input: ActionInput): Promise<{ queued: false; data: T } | { queued: true }> {
  const uid = offlineUser();
  const canQueue = !!uid && idbAvailable();
  const mustQueue = canQueue && (!navigator.onLine || state.pending > 0);
  const item: OutboxItem = { ...input, userId: uid ?? '', createdAt: new Date().toISOString(), key: newKey(), status: 'pending', attempts: 0 };
  if (!mustQueue) {
    try { return { queued: false, data: await send(item) as T }; }
    catch (e) { if (!canQueue || !isNetworkError(e)) throw e; }
  }
  await outboxStore.add(item);
  await refreshOutbox();
  return { queued: true };
}

let flushing: Promise<void> | null = null;
export function flushOutbox(): Promise<void> {
  flushing ??= (async () => {
    const uid = offlineUser();
    if (!uid || !idbAvailable() || !navigator.onLine) return;
    state = { ...state, syncing: true }; emit();
    try {
      const items = (await outboxStore.byUser<OutboxItem>(uid)).filter((i) => i.status === 'pending').sort((a, b) => a.id! - b.id!);
      let reauthed = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const res = await send(item);
          await outboxStore.del(item.id!);
          synced.forEach((f) => f(item, res));
          reauthed = false;
        } catch (e) {
          if (isNetworkError(e)) break;                                       // still offline: try later
          if (e instanceof ApiError && e.status === 401) {
            // Session needs renewing (e.g. the app was opened offline): renew once, then retry this same item.
            if (reauthed || !(await refreshSession())) break;
            reauthed = true; i--; continue;
          }
          if (e instanceof ApiError && (e.status >= 500 || e.status === 429)) { await outboxStore.put({ ...item, attempts: item.attempts + 1 }); break; }
          // A business rule rejected it (e.g. the job was reassigned): keep it for the technician to review.
          await outboxStore.put({ ...item, status: 'failed', attempts: item.attempts + 1, error: e instanceof Error ? e.message : 'Rejected' });
        }
      }
    } finally {
      state = { ...state, syncing: false };
      await refreshOutbox();
      flushing = null;
    }
  })();
  return flushing;
}

export async function discardItem(id: number) { await outboxStore.del(id); await refreshOutbox(); }
export async function retryItem(id: number) {
  const item = state.items.find((i) => i.id === id);
  if (item) { await outboxStore.put({ ...item, status: 'pending', error: undefined, key: newKey() }); await refreshOutbox(); void flushOutbox(); }
}

let started = false;
export function startOutbox() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const setOnline = () => { state = { ...state, online: navigator.onLine }; emit(); if (navigator.onLine) void flushOutbox(); };
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void flushOutbox(); });
  setInterval(() => { if (state.pending) void flushOutbox(); }, 30_000);
}
