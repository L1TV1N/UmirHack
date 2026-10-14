import { formatMoney, type WaiterHotDishDto } from '@zapas/shared';
import { Flame } from 'lucide-react';
import { useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import styles from './Waiter.module.scss';

/** Что предложить гостям в первую очередь. Без разбора расчёта: только блюдо, цена и сколько порций продать. */
export default function WaiterHotPage() {
  const scope = useScope();
  const q = useGet<WaiterHotDishDto[]>('/waiter/hot-dishes', { locationId: scope.locationId ?? '' }, { enabled: Boolean(scope.locationId) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data ?? [];
  if (items.length === 0) return <EmptyState title="Сейчас ничего особенного">Срок продуктов не поджимает: предлагайте всё меню.</EmptyState>;
  return (
    <>
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
