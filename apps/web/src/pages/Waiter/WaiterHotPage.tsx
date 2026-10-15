import { formatMoney, type WaiterHotDishDto } from '@zapas/shared';
import { Flame } from 'lucide-react';
import { useScope } from '../../auth/ScopeProvider';
import { useWaiterGet } from '../../lib/useWaiterGet';
import { OfflineEmpty, OfflineNote } from './OfflineNote';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import styles from './Waiter.module.scss';

/** Что предложить гостям в первую очередь. Без разбора расчёта: только блюдо, цена и сколько порций продать. */
export default function WaiterHotPage() {
  const scope = useScope();
  const q = useWaiterGet<WaiterHotDishDto[]>('/waiter/hot-dishes', { locationId: scope.locationId ?? '' }, { enabled: Boolean(scope.locationId) });
  if (q.unreachable) return <OfflineEmpty what="горячее" />;
  if (q.isLoading || (q.data === undefined && !q.error)) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data ?? [];
  if (items.length === 0) {
    return (
      <>
        <OfflineNote savedAt={q.savedAt} />
        <EmptyState title="Сейчас ничего особенного">Срок продуктов не поджимает: предлагайте всё меню.</EmptyState>
      </>
    );
  }
  return (
    <>
      <OfflineNote savedAt={q.savedAt} />
      <p className={styles.intro}>Предложите эти блюда гостям в первую очередь: продукты для них нужно использовать быстрее.</p>
      <ul className={styles.hotList}>
        {items.map((d, i) => (
          <li key={d.dishId}>
            <span className={styles.rank}>{i + 1}</span>
            <span className={styles.hotName}>
              <strong>{d.dishName}</strong>
              <small>
                Желательно продать около {d.portionsToPush} порц.
              </small>
            </span>
            <span className={styles.hotPrice}>
              <Flame size={15} aria-hidden="true" />
              {formatMoney(d.price)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
