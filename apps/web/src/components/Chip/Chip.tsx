import {
  EXPIRY_STATUS_LABELS,
  type BatchStatus,
  type ExpiryStatus,
} from '@zapas/shared';
import type { ReactNode } from 'react';
import styles from './Chip.module.scss';

export type Tone = 'neutral' | 'info' | 'ok' | 'amber' | 'warn' | 'danger';

export function Chip({ tone = 'neutral', dot, children, title }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`${styles.chip} ${styles[tone]}`} {...(title ? { title } : {})}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<ExpiryStatus, Tone> = {
  expired: 'danger',
  critical: 'warn',
  soon: 'amber',
  ok: 'ok',
};

export function toneOf(status: ExpiryStatus): Tone {
  return STATUS_TONE[status];
}

export function StatusChip({ status }: { status: BatchStatus | 'empty' }) {
  if (status === 'depleted') return <Chip>Израсходована</Chip>;
  if (status === 'empty') return <Chip>Нет остатка</Chip>;
  return (
    <Chip tone={STATUS_TONE[status]} dot>
      {EXPIRY_STATUS_LABELS[status]}
    </Chip>
  );
}

const LIFE_COLOR: Record<ExpiryStatus, string> = {
  expired: 'var(--danger-600)',
  critical: 'var(--warn-600)',
  soon: 'var(--amber-500)',
  ok: 'var(--ok-600)',
};

/** Сколько срока годности уже прошло. */
export function LifeBar({ elapsed, status }: { elapsed: number; status: BatchStatus }) {
  const color = status === 'depleted' ? 'var(--ink-300)' : LIFE_COLOR[status];
  const pct = Math.round(Math.min(1, Math.max(0, elapsed)) * 100);
  return (
    <span className={styles.life} title={`Прошло ${pct}% срока годности`} role="img" aria-label={`Прошло ${pct}% срока годности`}>
      <span style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}
