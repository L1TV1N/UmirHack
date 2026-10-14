import { useCallback, useEffect, useState } from 'react';

const API = `${import.meta.env.BASE_URL}api`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path?: string; message?: string }[],
  ) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: { path?: string; message?: string }[] } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Не удалось выполнить запрос', data?.error?.details);
  return data as T;
}

export function useLoad<T>(path: string | null): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    setLoading(true);
    api<T>('GET', path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Ошибка'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export const money = (v: number): string => `${v.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;
export const qty = (v: number): string => v.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
export const UNIT: Record<string, string> = { kg: 'кг', l: 'л', pcs: 'шт' };
export const fmtDate = (iso: string | null): string => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-');
export const fmtDateTime = (iso: string): string => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
