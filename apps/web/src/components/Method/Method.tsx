import type { ReactNode } from 'react';
import styles from './Method.module.scss';

/** Пояснение к расчёту: по умолчанию свёрнуто, чтобы не занимать место у тех, кому оно не нужно. */
export function Method({ title = 'Как считается', children }: { title?: string; children: ReactNode }) {
  return (
    <details className={styles.method}>
      <summary>{title}</summary>
      <div className={styles.grid}>{children}</div>
    </details>
  );
}

export function MethodItem({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <p>
      <strong>{title}</strong>
      {children}
    </p>
  );
}
