/**
 * Per-user offline data for the technician app. Only data the technician has already been
 * allowed to see is stored, it is keyed by user id, and it is wiped on logout.
 */
import { idbAvailable, kv, outboxStore } from './idb';

let currentUser: string | null = null;
export const setOfflineUser = (id: string | null) => { currentUser = id; };
export const offlineUser = () => currentUser;

const k = (userId: string, key: string) => `u:${userId}:${key}`;

export async function cachePut(key: string, data: unknown) {
  if (!currentUser || !idbAvailable()) return;
  try { await kv.set(k(currentUser, key), { data, at: Date.now() }); } catch { /* quota or private mode: ignore */ }
}

export async function cacheGet<T>(key: string): Promise<{ data: T; at: number } | undefined> {
  if (!currentUser || !idbAvailable()) return undefined;
  try { return await kv.get(k(currentUser, key)); } catch { return undefined; }
}

/** Profile used to open the technician app while offline (no tokens are stored). */
export async function rememberProfile(me: unknown) { if (idbAvailable()) try { await kv.set('last-profile', me); } catch { /* ignore */ } }
export async function lastProfile<T>(): Promise<T | undefined> { if (!idbAvailable()) return undefined; try { return await kv.get<T>('last-profile'); } catch { return undefined; } }

export async function wipeOfflineData(userId: string | null) {
  if (!idbAvailable()) return;
  try {
    await kv.del('last-profile');
    if (userId) { await kv.delPrefix(`u:${userId}:`); await outboxStore.clearUser(userId); }
  } catch { /* ignore */ }
}

/** A fetch that failed because there is no connection (as opposed to an HTTP error). */
export const isNetworkError = (e: unknown) => e instanceof TypeError || (e instanceof DOMException && e.name === 'AbortError');
