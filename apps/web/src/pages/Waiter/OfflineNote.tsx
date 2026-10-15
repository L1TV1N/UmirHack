import { CloudOff } from 'lucide-react';
import { fmtDateTime } from '../../lib/format';
import styles from './Waiter.module.scss';

/** Показаны данные, сохранённые на телефоне: говорим, на какой момент они верны. */
export function OfflineNote({ savedAt }: { savedAt: number | null }) {
  if (savedAt === null) return null;
  return (
    <div className={styles.offlineNote} role="status">
      <CloudOff size={15} aria-hidden="true" />
      <span>Нет связи. Данные на {fmtDateTime(new Date(savedAt).toISOString())}: стоп-лист мог измениться, сервер проверит заказ, когда связь вернётся.</span>
    </div>
  );
}

/** Связи нет, а сохранённых данных ещё нет: открыть этот раздел можно будет, когда связь вернётся. */
export function OfflineEmpty({ what }: { what: string }) {
  return (
    <div className={styles.offlineNote} role="status">
      <CloudOff size={15} aria-hidden="true" />
      <span>Нет связи, {what} появится, когда она вернётся. Раздел откроется с последними данными, как только вы хотя бы раз загрузите его при связи.</span>
    </div>
  );
}
