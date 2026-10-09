import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../Button/Button';
import styles from './Pagination.module.scss';

export function Pagination({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit && offset === 0) {
    return total > 0 ? (
      <div className={styles.bar}>
        <span className="num">Всего: {total}</span>
      </div>
    ) : null;
  }
  const from = Math.min(offset + 1, total);
  const to = Math.min(offset + limit, total);
  return (
    <nav className={styles.bar} aria-label="Страницы">
      <span className="num">
        {from}–{to} из {total}
      </span>
      <div className={styles.buttons}>
        <Button size="sm" icon={<ChevronLeft size={15} />} disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Назад
        </Button>
        <Button size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          Далее
          <ChevronRight size={15} />
        </Button>
      </div>
    </nav>
  );
}
