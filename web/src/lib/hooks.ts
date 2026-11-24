import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, qs, type Paged } from './api';
import { toastError } from '@/components/form';

/** List state (page/search/sort/filters) persisted in the URL so views are shareable and survive refresh. */
export function useListState(defaults: Record<string, string> = {}) {
  const [sp, setSp] = useSearchParams();
  const params = useMemo(() => {
    const o: Record<string, string> = { ...defaults };
    sp.forEach((v, k) => { o[k] = v; });
    return o;
  }, [sp]); // eslint-disable-line
  const set = useCallback((patch: Record<string, string | number | null | undefined>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v === null || v === undefined || v === '' ? next.delete(k) : next.set(k, String(v)));
    if (resetPage && !('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  }, [sp, setSp]);
  const toggleSort = (key: string) => set({ sort: key, order: params.sort === key && params.order === 'asc' ? 'desc' : 'asc' }, false);
  return { params, set, toggleSort, sort: params.sort ? { key: params.sort, order: (params.order ?? 'desc') as 'asc' | 'desc' } : undefined };
}

export function usePaged<T = any>(path: string, params: Record<string, unknown>, enabled = true) {
  return useQuery({ queryKey: [path, params], queryFn: () => api<Paged<T>>(`${path}${qs(params)}`), placeholderData: keepPreviousData, enabled });
}
export function useData<T = any>(key: QueryKey, path: string | null, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery({ queryKey: key, queryFn: async () => (await api<{ data: T }>(path!)).data, enabled: !!path && opts.enabled !== false, refetchInterval: opts.refetchInterval });
}

/** Mutation with consistent success/error feedback and cache invalidation. */
export function useAction<V = any, R = any>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); invalidate?: QueryKey[]; onSuccess?: (r: R) => void; silentError?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      (opts.invalidate ?? []).forEach((k) => qc.invalidateQueries({ queryKey: k }));
      opts.onSuccess?.(r);
    },
    onError: (e) => { if (!opts.silentError) toastError(e); },
  });
}

export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  return { open, setOpen, onOpen: () => setOpen(true), onClose: () => setOpen(false) };
}
