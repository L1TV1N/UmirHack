import type { WaiterStopDto } from '@zapas/shared';
import { OctagonX } from 'lucide-react';
import { useScope } from '../../auth/ScopeProvider';
import { useWaiterGet } from '../../lib/useWaiterGet';
import { OfflineEmpty, OfflineNote } from './OfflineNote';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import styles from './Waiter.module.scss';

/** Стоп-лист для зала: что сейчас нельзя заказать и почему, одной строкой. */
export default function WaiterStopPage() {
  const scope = useScope();
  const q = useWaiterGet<WaiterStopDto[]>('/waiter/stop-list', { locationId: scope.locationId ?? '' }, { enabled: Boolean(scope.locationId), refetchInterval: 30_000 });
  if (q.unreachable) return <OfflineEmpty what="стоп-лист" />;
  if (q.isLoading || (q.data === undefined && !q.error)) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data ?? [];
  if (items.length === 0) {
    return (
      <>
        <OfflineNote savedAt={q.savedAt} />
        <EmptyState title="Стоп-лист пуст">Можно заказывать всё меню.</EmptyState>
      </>
    );
  }
  const dishes = items.filter((i) => i.entityType === 'dish');
  const products = items.filter((i) => i.entityType === 'product');
  return (
    <>
      <OfflineNote savedAt={q.savedAt} />
      {dishes.length > 0 && (
        <>
          <h2 className={styles.section}>Блюда, которые заказать нельзя</h2>
          <ul className={styles.stopList}>
            {dishes.map((i) => (
              <li key={i.key}>
                <OctagonX size={18} aria-hidden="true" />
                <span>
                  <strong>{i.name}</strong>
                  <small>{i.note}</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {products.length > 0 && (
        <>
          <h2 className={styles.section}>Закончились продукты</h2>
          <ul className={styles.stopList}>
            {products.map((i) => (
              <li key={i.key}>
                <OctagonX size={18} aria-hidden="true" />
                <span>
                  <strong>{i.name}</strong>
                  <small>{i.note}</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
