import { formatMoneyWhole, plural, type ShortageStatsDto } from '@zapas/shared';
import { useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { ExportButton } from '../../components/ExportButton/ExportButton';
import { Chip } from '../../components/Chip/Chip';
import { ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import styles from './ShortagePanel.module.scss';

const DAYS = 30;

/** «5 ч» или «2,5 сут.»: на масштабе месяца минуты не нужны. */
function formatHours(hours: number): string {
  if (hours < 1) return 'меньше часа';
  if (hours < 48) return `${Math.round(hours)} ч`;
  return `${(Math.round(hours / 2.4) / 10).toLocaleString('ru-RU')} сут.`;
}

export function ShortagePanel({ locationId }: { locationId: string | undefined }) {
  const query = useGet<ShortageStatsDto>('/analytics/shortages', { locationId, days: DAYS }, { refetchInterval: 120_000 });
  const { can } = useAuth();
  const d = query.data;
  const max = Math.max(1, ...(d?.ingredients.map((i) => i.hours) ?? [0]));

  return (
    <Panel
      title="Дефицитные ингредиенты"
      subtitle={`За ${DAYS} дней: сколько времени продукт не давал готовить блюда`}
      actions={can('manager') && d && d.ingredients.length > 0 ? <ExportButton path="/reports/shortages.csv" query={{ locationId, days: DAYS }} filename="shortages.csv" /> : undefined}
    >
      {query.isLoading && <Loading />}
      {query.isError && (
        <div style={{ padding: 16 }}>
          <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
        </div>
      )}
      {d && d.ingredients.length === 0 && <div className={styles.empty}>За этот период нехваток не было.</div>}
      {d && d.ingredients.length > 0 && (
        <>
          <p className={styles.totals}>
            {d.totals.episodes} {plural(d.totals.episodes, ['нехватка', 'нехватки', 'нехваток'])}
            {d.totals.refusedOrders > 0 && (
              <>
                {' '}
                · отклонено заказов: {d.totals.refusedOrders} на {formatMoneyWhole(d.totals.lostRevenue)}
              </>
            )}
          </p>
          <ul className={styles.list}>
            {d.ingredients.map((i) => (
              <li key={i.productId}>
                <div className={styles.head}>
                  <strong>{i.productName}</strong>
                  <span className="num">{i.hours > 0 ? formatHours(i.hours) : '-'}</span>
                </div>
                <div className={styles.track} aria-hidden="true">
                  <i style={{ width: `${Math.max(2, Math.round((i.hours / max) * 100))}%` }} />
                </div>
                <div className={styles.meta}>
                  {i.ongoing && <Chip tone="danger">нет сейчас</Chip>}
                  {i.episodes > 0 && (
                    <span>
                      {i.episodes} {plural(i.episodes, ['раз', 'раза', 'раз'])}
                    </span>
                  )}
                  {i.dishesBlocked > 0 && (
                    <span>
                      останавливал {i.dishesBlocked} {plural(i.dishesBlocked, ['блюдо', 'блюда', 'блюд'])}
                    </span>
                  )}
                  {i.refusedOrders > 0 && (
                    <span>
                      отказов: {i.refusedOrders} на {formatMoneyWhole(i.lostRevenue)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
