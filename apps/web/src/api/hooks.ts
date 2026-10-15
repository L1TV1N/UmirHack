import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { ApiError, get, type Query } from './client';

export function useGet<T>(
  path: string,
  query?: Query,
  options?: Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<T, ApiError>({
    queryKey: [path, query ?? {}],
    queryFn: ({ signal }) => get<T>(path, query, signal),
    ...options,
  });
}

/** Сбрасывает кеш запросов, чьи адреса начинаются с одного из префиксов. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (prefixes: string[]) =>
    qc.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === 'string' && prefixes.some((p) => (q.queryKey[0] as string).startsWith(p)),
    });
}

/** Всё, что меняется после операций с остатками. */
export const STOCK_PREFIXES = ['/stock', '/documents', '/analytics', '/stop-list', '/inventories', '/promotions', '/traceability'];

export function useAction<TVars, TRes>(fn: (vars: TVars) => Promise<TRes>, invalidate: string[] = []) {
  const invalidateKeys = useInvalidate();
  return useMutation<TRes, ApiError, TVars>({
    mutationFn: fn,
    // без связи запрос не должен вставать на паузу: документы сами решают, ставить ли себя в очередь
    networkMode: 'always',
    onSuccess: () => {
      if (invalidate.length) void invalidateKeys(invalidate);
    },
  });
}
