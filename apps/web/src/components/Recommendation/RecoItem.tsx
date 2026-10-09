import {
  describeDaysLeft,
  formatMoneyWhole,
  RECOMMENDATION_TYPE_LABELS,
  type RecommendationDto,
  type RecommendationType,
} from '@zapas/shared';
import type { ReactNode } from 'react';
import { Chip, type Tone } from '../Chip/Chip';
import styles from './Reco.module.scss';

const TONE: Record<RecommendationType, Tone> = {
  writeoff: 'danger',
  discount: 'warn',
  transfer: 'info',
  promote: 'info',
  reorder: 'neutral',
};

function daysTone(days: number): Tone {
  if (days < 0) return 'danger';
  if (days <= 1) return 'warn';
  if (days <= 3) return 'amber';
  return 'ok';
}

export function RecoItem({ rec, compact, actions }: { rec: RecommendationDto; compact?: boolean; actions?: ReactNode }) {
  return (
    <li className={`${styles.item} ${compact ? styles.compact : ''}`} style={{ listStyle: 'none' }}>
      <div className={styles.kind}>
        <Chip tone={TONE[rec.type]}>{RECOMMENDATION_TYPE_LABELS[rec.type]}</Chip>
      </div>
      <div className={styles.what}>
        <strong>{rec.headline}</strong>
        <div className={styles.where}>
          {rec.productName} · {rec.locationName}
        </div>
        {!compact && <p className={styles.why}>{rec.details}</p>}
        {!compact && rec.dishes && (
          <div className={styles.dishes}>
            {rec.dishes.map((d) => (
              <Chip key={d.id} tone="neutral">
                {d.name} · {d.portions} порц.
              </Chip>
            ))}
          </div>
        )}
        {!compact && actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <div className={styles.side}>
        {rec.daysLeft !== null && <Chip tone={daysTone(rec.daysLeft)}>{describeDaysLeft(rec.daysLeft)}</Chip>}
        {rec.atRiskValue > 0 && (
          <span className={styles.money}>
            {formatMoneyWhole(rec.atRiskValue)}
            <small>под угрозой</small>
          </span>
        )}
        {rec.recoveryValue !== undefined && !compact && (
          <span className={styles.money} style={{ color: 'var(--ok-700)' }}>
            +{formatMoneyWhole(rec.recoveryValue)}
            <small>можно вернуть</small>
          </span>
        )}
      </div>
    </li>
  );
}
