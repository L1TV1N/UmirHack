import type { WaiterStopDto } from '@zapas/shared';
import { OctagonX } from 'lucide-react';
import { useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import styles from './Waiter.module.scss';

/** Стоп-лист для зала: что сейчас нельзя заказать и почему, одной строкой. */
export default function WaiterStopPage() {
  const scope = useScope();
  const q = useGet<WaiterStopDto[]>('/waiter/stop-list', { locationId: scope.locationId ?? '' }, { enabled: Boolean(scope.locationId), refetchInterval: 30_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data ?? [];
  if (items.length === 0) return <EmptyState title="Стоп-лист пуст">Можно заказывать всё меню.</EmptyState>;
  const dishes = items.filter((i) => i.entityType === 'dish');
  const products = items.filter((i) => i.entityType === 'product');
  return (
    <>
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
