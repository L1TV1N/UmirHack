import { formatMoneyWhole, formatQty, type RescuedStatsDto } from '@zapas/shared';
import { useGet } from '../../api/hooks';
import { ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import styles from './RescuedPanel.module.scss';

const DAYS = 30;

/** Сколько выручили с товара, который успели продать по скидке до конца срока. */
export function RescuedPanel({ locationId }: { locationId: string | undefined }) {
  const query = useGet<RescuedStatsDto>('/analytics/rescued', { locationId, days: DAYS }, { refetchInterval: 120_000 });
  const d = query.data;

  return (
    <Panel title="Спасено уценкой" subtitle={`За ${DAYS} дней: товар, проданный со скидкой до конца срока, вместо списания`}>
      {query.isLoading && <Loading />}
      {query.isError && (
        <div style={{ padding: 16 }}>
          <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
        </div>
      )}
      {d && d.batches === 0 && <div className={styles.empty}>Уценённых продаж за период не было. Скидки включаются в разделе «Рекомендации».</div>}
      {d && d.batches > 0 && (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>Выручка</dt>
              <dd className="num">{formatMoneyWhole(d.revenue)}</dd>
            </div>
            <div>
              <dt>Вернули себестоимость</dt>
              <dd className="num">{formatMoneyWhole(Math.min(d.cost, d.revenue))}</dd>
            </div>
            <div>
              <dt>Скидка стоила</dt>
              <dd className="num">{formatMoneyWhole(d.discountGiven)}</dd>
            </div>
          </dl>
          <ul className={styles.list}>
            {d.products.map((p) => (
              <li key={p.productId}>
                <span>
                  <strong>{p.productName}</strong>
                  <small>{formatQty(p.quantity, p.unit)}</small>
                </span>
                <span className="num">{formatMoneyWhole(p.revenue)}</span>
              </li>
            ))}
          </ul>
          <p className={styles.note}>Без скидки эти партии, скорее всего, пришлось бы списывать. Партий уценено и продано: {d.batches}.</p>
        </>
      )}
    </Panel>
  );
}
