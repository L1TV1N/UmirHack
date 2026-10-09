import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button } from '../Button/Button';
import styles from './Lines.module.scss';

export interface UpsertResult<T> {
  line: T;
  /** Строка добавлена или заполнена заново, а не дополнена. */
  created: boolean;
}

export function useLines<T extends { key: number }>(make: (key: number) => Omit<T, 'key'>, initial = 1) {
  const seq = useRef(0);
  const create = useCallback((): T => {
    seq.current += 1;
    return { key: seq.current, ...make(seq.current) } as T;
  }, [make]);
  const [lines, setLinesState] = useState<T[]>(() => Array.from({ length: initial }, () => create()));
  // Актуальный список «сейчас», а не на момент последнего рендера: сканер присылает коды чаще, чем React успевает перерисоваться
  const latest = useRef(lines);
  const setLines = useCallback((next: T[]) => {
    latest.current = next;
    setLinesState(next);
  }, []);

  return {
    lines,
    /** Список «прямо сейчас», в том числе между перерисовками. */
    snapshot: () => latest.current,
    add: () => setLines([...latest.current, create()]),
    remove: (key: number) => setLines(latest.current.length > 1 ? latest.current.filter((x) => x.key !== key) : latest.current),
    update: (key: number, patch: Partial<T>) => setLines(latest.current.map((x) => (x.key === key ? { ...x, ...patch } : x))),
    reset: () => setLines([create()]),
    /** Заменяет все строки заготовленными (например, строками из загруженной накладной). */
    replaceAll: (patches: Partial<T>[]) => setLines(patches.length > 0 ? patches.map((patch) => ({ ...create(), ...patch })) : [create()]),
    /**
     * Строка по найденному признаку дополняется (например, количество плюс один). Если такой нет, заполняется первая
     * пустая строка, а если пустых нет, добавляется новая.
     */
    upsert(find: (line: T) => boolean, change: (line: T) => Partial<T>, fresh: Partial<T>, blank: (line: T) => boolean): UpsertResult<T> {
      const list = latest.current;
      const hit = list.find(find);
      if (hit) {
        const line = { ...hit, ...change(hit) };
        setLines(list.map((x) => (x.key === hit.key ? line : x)));
        return { line, created: false };
      }
      const empty = list.find(blank);
      if (empty) {
        const line = { ...empty, ...fresh };
        setLines(list.map((x) => (x.key === empty.key ? line : x)));
        return { line, created: true };
      }
      const line = { ...create(), ...fresh };
      setLines([...list, line]);
      return { line, created: true };
    },
  };
}

export function LinesHead({ template, labels }: { template: string; labels: string[] }) {
  return (
    <div className={`${styles.grid} ${styles.head}`} style={{ ['--template' as string]: template }} aria-hidden="true">
      {labels.map((l, i) => (
        <span key={`${l}${i}`}>{l}</span>
      ))}
    </div>
  );
}

export function LineRow({
  template,
  labels,
  cells,
  onRemove,
  canRemove,
  error,
  note,
}: {
  template: string;
  /** Подписи колонок: на телефоне заголовок таблицы скрыт, и подпись показывается над каждым полем. */
  labels?: string[];
  cells: ReactNode[];
  onRemove: () => void;
  canRemove: boolean;
  error?: string | undefined;
  /** Пояснение под строкой (например, откуда она взялась). */
  note?: ReactNode;
}) {
  return (
    <div className={styles.grid} style={{ ['--template' as string]: template }}>
      {cells.map((c, i) => (
        <div key={i} className={styles.cell} {...(labels?.[i] ? { 'data-label': labels[i] } : {})}>
          {c}
        </div>
      ))}
      <button type="button" className={styles.remove} onClick={onRemove} disabled={!canRemove} aria-label="Удалить строку">
        <Trash2 size={16} />
      </button>
      {note && <div className={styles.note}>{note}</div>}
      {error && <div className={styles.err}>{error}</div>}
    </div>
  );
}

export function LinesFooter({ onAdd, children }: { onAdd: () => void; children?: ReactNode }) {
  return (
    <div className={styles.footer}>
      <Button size="sm" icon={<Plus size={15} />} onClick={onAdd}>
        Добавить строку
      </Button>
      {children}
    </div>
  );
}

export const Lines = { Wrap: ({ children }: { children: ReactNode }) => <div className={styles.wrap}>{children}</div>, unit: styles.unit };
