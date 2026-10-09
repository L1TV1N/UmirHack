import type { ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { Button } from '../Button/Button';
import styles from './Feedback.module.scss';

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, message: text, onRetry }: { error?: unknown; message?: string; onRetry?: () => void }) {
  const message = text ?? (error instanceof ApiError ? error.message : 'Не удалось загрузить данные');
  return (
    <div className={styles.error} role="alert">
      <span>{message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

export function Loading({ label = 'Загрузка' }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      {label}…
    </div>
  );
}
