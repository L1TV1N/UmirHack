import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ApiError, Query } from '../api/client';
import { useGet } from '../api/hooks';
import { isTransient } from '../api/transient';
import { useAuth } from '../auth/AuthProvider';
import { loadWaiterData, saveWaiterData } from './waiterCache';

export type WaiterQuery<T> = Omit<UseQueryResult<T, ApiError>, 'data' | 'error'> & {
  data: T | undefined;
  error: ApiError | null;
  /** Связи нет, показаны сохранённые на телефоне данные. */
  offline: boolean;
  /** Когда эти данные были получены с сервера (миллисекунды), только в режиме без связи. */
  savedAt: number | null;
  /** Связи нет, а на телефоне этих данных ещё нет. */
  unreachable: boolean;
};

/**
 * Запрос для экрана официанта. Каждый ответ сервера запоминается; если связи нет и свежего ответа тоже,
 * вместо ошибки показывается последний сохранённый. Отказ сервера по существу (403, 404) кеш не подменяет.
 */
export function useWaiterGet<T>(path: string, query?: Query, options?: Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>): WaiterQuery<T> {
  const { user } = useAuth();
  const q = useGet<T>(path, query, options);
  const userId = user?.id;
  const key = `${path}?${JSON.stringify(query ?? {})}`;
  const [saved, setSaved] = useState<{ key: string; data: T; savedAt: number } | null>(null);

  useEffect(() => {
    if (userId && q.data !== undefined && !q.isError) void saveWaiterData(userId, key, q.data);
  }, [userId, key, q.data, q.isError]);

  const unreachable = q.data === undefined && (q.fetchStatus === 'paused' || (q.isError && isTransient(q.error)));
  useEffect(() => {
    if (!userId || !unreachable) return;
    let alive = true;
    void loadWaiterData<T>(userId, key).then((s) => {
      if (alive && s) setSaved({ key, data: s.data, savedAt: s.savedAt });
    });
    return () => {
      alive = false;
    };
  }, [userId, key, unreachable]);

  const fallback = unreachable && saved?.key === key ? saved : null;
  return {
    ...q,
    data: q.data ?? fallback?.data,
    error: fallback ? null : q.error,
    isLoading: fallback ? false : q.isLoading,
    isError: fallback ? false : q.isError,
    offline: fallback !== null,
    savedAt: fallback?.savedAt ?? null,
    unreachable: unreachable && fallback === null,
  } as WaiterQuery<T>;
}
