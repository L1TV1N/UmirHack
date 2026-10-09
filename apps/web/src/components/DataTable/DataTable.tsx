import type { KeyboardEvent, ReactNode } from 'react';
import styles from './DataTable.module.scss';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  dense?: boolean;
  caption?: string;
  rowClass?: (row: T) => string | undefined;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, loading, empty, dense, caption, rowClass }: Props<T>) {
  const alignClass = (a?: 'left' | 'right' | 'center') => (a === 'right' ? styles.right : a === 'center' ? styles.center : '');

  const onKey = (e: KeyboardEvent, row: T) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  return (
    <div className={styles.wrap}>
      <table className={`${styles.table} ${dense ? styles.dense : ''}`}>
        {caption && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={alignClass(c.align)} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading &&
            !rows &&
            Array.from({ length: 6 }, (_, i) => (
              <tr key={`s${i}`} aria-hidden="true">
                {columns.map((c) => (
                  <td key={c.key}>
                    <div className={styles.skeleton} style={{ width: `${55 + ((i * 17 + c.key.length * 11) % 40)}%` }} />
                  </td>
                ))}
              </tr>
            ))}
          {rows?.map((row) => (
            <tr
              key={rowKey(row)}
              className={[onRowClick ? styles.clickable : '', rowClass?.(row) ?? ''].filter(Boolean).join(' ')}
              {...(onRowClick ? { onClick: () => onRowClick(row), onKeyDown: (e: KeyboardEvent) => onKey(e, row), tabIndex: 0 } : {})}
            >
              {columns.map((c) => (
                <td key={c.key} className={alignClass(c.align)} {...(typeof c.header === 'string' && c.header ? { 'data-label': c.header } : {})}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows && rows.length === 0 && <div className={styles.empty}>{empty ?? 'Ничего не найдено'}</div>}
    </div>
  );
}
