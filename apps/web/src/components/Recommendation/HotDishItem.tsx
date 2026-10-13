import { describeDaysLeft, formatMoneyWhole, formatQty, type HotDishDto } from '@zapas/shared';
import { Chip } from '../Chip/Chip';
import { daysTone } from './RecoItem';
import styles from './HotDish.module.scss';

function level(priority: number): 'high' | 'mid' | 'low' {
  if (priority >= 60) return 'high';
  if (priority >= 30) return 'mid';
  return 'low';
}

export function HotDishItem({ dish, compact }: { dish: HotDishDto; compact?: boolean }) {
  const reasons = compact ? dish.reasons.slice(0, 1) : dish.reasons;
  return (
    <li className={`${styles.item} ${compact ? styles.compact : ''}`}>
      <div className={styles.score} title="Приоритет от 0 до 100">
        <span className={styles.num}>{dish.priority}</span>
        <span className={styles.bar} aria-hidden="true">
          <i className={styles[level(dish.priority)]} style={{ width: `${Math.max(dish.priority, 4)}%` }} />
        </span>
      </div>

      <div className={styles.what}>
        <strong>{dish.dishName}</strong>
        <div className={styles.where}>
          {dish.locationName} · хватит на {dish.portions} порц. · продать около {dish.portionsToPush}
        </div>
        <ul className={styles.reasons}>
          {reasons.map((r) => (
            <li key={r.productId}>
              <Chip tone={daysTone(r.daysLeft)}>{describeDaysLeft(r.daysLeft)}</Chip>
              <span>
                <b>{r.productName}</b>
                {!compact && (
                  <>
                    {' '}
                    · в истекающих партиях {formatQty(r.stockQty, r.unit)} · {formatQty(r.perPortion, r.unit)} на порцию
                    {r.sharedWith.length > 0 && <> · делится с «{r.sharedWith.slice(0, 2).join('», «')}»</>}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        {!compact && <p className={styles.why}>{dish.details}</p>}
      </div>

      {!compact && (
        <div className={styles.side}>
          <span className={styles.money}>
            {formatMoneyWhole(dish.atRiskValue)}
            <small>можно спасти по себестоимости</small>
          </span>
          <span className={styles.price}>{formatMoneyWhole(dish.price)} за порцию</span>
        </div>
      )}
    </li>
  );
}
