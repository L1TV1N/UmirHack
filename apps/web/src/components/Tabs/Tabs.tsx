import type { ReactNode } from 'react';
import styles from './Tabs.module.scss';

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
}

export function Tabs<V extends string>({ items, value, onChange, label }: { items: TabItem<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className={styles.tabs} role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className={styles.tab} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<V extends string>({ items, value, onChange, label }: { items: TabItem<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {items.map((t) => (
        <button key={t.value} type="button" aria-pressed={t.value === value} className={styles.seg} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
