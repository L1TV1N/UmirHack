import { useGet } from '../api/hooks';

/** Адрес кабинета поставщика «Отгрузка». Пусто, пока кабинет не подключён к серверу. */
export function usePortalLink(enabled = true): string | null {
  const q = useGet<{ url: string | null }>('/supplier-portal/link', undefined, { enabled, staleTime: 3_600_000 });
  return q.data?.url ?? null;
}
